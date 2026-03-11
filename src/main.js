import { randomUUID } from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import {
  validateStartUrl,
  dismissPopups,
  extractPageSnapshot,
  hashPageContent,
  fillForm,
  waitForSettle,
  fingerprintActions,
  takeScreenshot,
} from './page-utils.js';
import { initLlmClient, analyzePage, isWorthScreenshot, getCacheStats } from './llm.js';

// ---------------------------------------------------------------------------
// Global seen hashes — skip screenshotting pages we've already captured
// ---------------------------------------------------------------------------
const globalSeenHashes = new Set();
const sessionStore = new Map();
const collectedScreenshots = [];

// ---------------------------------------------------------------------------
// LLM Failure Detection
// ---------------------------------------------------------------------------

const LLM_ERROR_PREFIXES = [
  'LLM call failed',
  'LLM error:',
  'No tool_use block',
];

function isLlmFailure(analysis) {
  const reason = analysis.reasoning || '';
  return LLM_ERROR_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Blind Click Fallback — heuristic CTA clicking when LLM is unavailable
// ---------------------------------------------------------------------------

const BLIND_CTA_LABELS = [
  'Continue', 'Next', 'Get Started', 'Start Now', 'Click Here',
  'Yes', 'Try Now', 'Start', 'Begin', 'Proceed', 'Go',
  'Submit', 'See Results', 'Show Results', 'Take the Quiz',
  'Start Quiz', "Let's go", 'Next Step', 'Keep Going',
  'Confirm', 'Accept', 'Agree', 'OK',
];

const SKIP_TEXT_PATTERNS = [
  'home', 'about', 'contact', 'blog', 'faq', 'help',
  'facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'tiktok',
  'privacy', 'terms', 'cookie', 'legal', 'sitemap',
  'login', 'sign in', 'log in', 'sign up',
];

const SKIP_SELECTOR_PATTERNS = ['header', 'footer', 'nav'];

async function blindClickFallback(page, startUrl, waitAfterClick, log) {
  const startDomain = new URL(startUrl).hostname;
  const hashBefore = await hashPageContent(page);

  // --- Tier 1: CTA text labels ---
  log.info('Blind fallback Tier 1: trying CTA text labels');
  for (const label of BLIND_CTA_LABELS) {
    try {
      const el = await findClickableByLabel(page, label);
      if (!el) continue;

      log.info(`Blind fallback: clicking "${label}"`);
      await el.click({ timeout: 3000 });
      await waitForSettle(page, waitAfterClick + 2000);

      // Check if we navigated off-domain
      try {
        const currentDomain = new URL(page.url()).hostname;
        if (currentDomain !== startDomain) {
          log.info(`Blind fallback: navigated off-domain to ${currentDomain}, going back`);
          await page.goBack({ timeout: 5000 }).catch(() => {});
          await waitForSettle(page, waitAfterClick);
          continue;
        }
      } catch { /* invalid URL, skip */ }

      const hashAfter = await hashPageContent(page);
      if (hashBefore !== hashAfter) {
        log.info(`Blind fallback Tier 1 success: "${label}" changed page content`);
        return true;
      }
    } catch {
      // element not clickable, try next
    }
  }

  // --- Tier 2: Above-fold snapshot elements ---
  log.info('Blind fallback Tier 2: trying above-fold interactive elements');
  try {
    const snapshot = await extractPageSnapshot(page);
    const candidates = (snapshot.elements || []).filter((el) => {
      if (!el.aboveFold || !el.text) return false;

      // Skip elements inside header/footer/nav
      const sel = (el.selector || '').toLowerCase();
      if (SKIP_SELECTOR_PATTERNS.some((p) => sel.includes(p))) return false;

      // Skip social/utility text
      const text = el.text.toLowerCase();
      if (SKIP_TEXT_PATTERNS.some((p) => text.includes(p))) return false;

      // Skip external links
      if (el.href) {
        try {
          const linkDomain = new URL(el.href, startUrl).hostname;
          if (linkDomain !== startDomain) return false;
        } catch { return false; }
      }

      return true;
    });

    for (const candidate of candidates) {
      try {
        const el = page.locator(candidate.selector).first();
        if (!await el.isVisible({ timeout: 500 }).catch(() => false)) continue;

        log.info(`Blind fallback Tier 2: clicking "${candidate.text}" (${candidate.selector})`);
        await el.click({ timeout: 3000 });
        await waitForSettle(page, waitAfterClick + 2000);

        // Check if we navigated off-domain
        try {
          const currentDomain = new URL(page.url()).hostname;
          if (currentDomain !== startDomain) {
            log.info(`Blind fallback: navigated off-domain to ${currentDomain}, going back`);
            await page.goBack({ timeout: 5000 }).catch(() => {});
            await waitForSettle(page, waitAfterClick);
            continue;
          }
        } catch { /* invalid URL, skip */ }

        const hashAfter = await hashPageContent(page);
        if (hashBefore !== hashAfter) {
          log.info(`Blind fallback Tier 2 success: "${candidate.text}" changed page content`);
          return true;
        }
      } catch {
        // element not clickable, try next
      }
    }
  } catch (err) {
    log.warning(`Blind fallback Tier 2 failed: ${err.message}`);
  }

  log.info('Blind fallback: no clicks changed page content');
  return false;
}

// ---------------------------------------------------------------------------
// Element Finding — text-based with CSS selector fallback
// ---------------------------------------------------------------------------

async function findClickableByLabel(page, label) {
  // Strategy 1: Playwright's role-based locator (button)
  const byRole = page.getByRole('button', { name: label, exact: true });
  if (await byRole.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    return byRole.first();
  }

  // Strategy 2: Link role
  const byLink = page.getByRole('link', { name: label, exact: true });
  if (await byLink.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    return byLink.first();
  }

  // Strategy 3: Checkbox/radio label (for multi-select quiz pages)
  const byCheckbox = page.getByRole('checkbox', { name: label });
  if (await byCheckbox.first().isVisible({ timeout: 500 }).catch(() => false)) {
    return byCheckbox.first();
  }
  const byRadio = page.getByRole('radio', { name: label });
  if (await byRadio.first().isVisible({ timeout: 500 }).catch(() => false)) {
    return byRadio.first();
  }

  // Strategy 4: Label element containing the text
  const byLabel = page.getByLabel(label, { exact: true });
  if (await byLabel.first().isVisible({ timeout: 500 }).catch(() => false)) {
    return byLabel.first();
  }

  // Strategy 5: Exact text match
  const exactText = page.getByText(label, { exact: true });
  if (await exactText.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    return exactText.first();
  }

  // Strategy 6: Loose text match (substring)
  const looseText = page.getByText(label);
  if (await looseText.first().isVisible({ timeout: 500 }).catch(() => false)) {
    return looseText.first();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auto-advance past Continue/Next buttons
// ---------------------------------------------------------------------------

const NAV_BUTTON_LABELS = [
  'Continue', 'Next', 'Get Started', 'Start', 'Begin', 'Proceed',
  'Submit', 'Go', 'Confirm', 'See Results', 'See My Results',
  'Show Results', 'Take the Quiz', 'Start Quiz', 'Let\'s go',
  "Let's go", 'Next Step', 'Keep Going',
];

async function autoAdvanceNav(page, waitAfterClick, log) {
  const maxAttempts = 5;
  for (let i = 0; i < maxAttempts; i++) {
    let clicked = false;
    for (const label of NAV_BUTTON_LABELS) {
      try {
        // Try button first, then link, then generic text
        let btn = page.getByRole('button', { name: label, exact: true }).first();
        if (!await btn.isVisible({ timeout: 300 }).catch(() => false)) {
          btn = page.getByRole('link', { name: label, exact: true }).first();
        }
        if (!await btn.isVisible({ timeout: 300 }).catch(() => false)) {
          btn = page.getByText(label, { exact: true }).first();
        }

        if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
          const hashBefore = await hashPageContent(page);
          log.info(`Auto-advancing: clicking "${label}"`);
          await btn.click({ timeout: 3000 });
          await waitForSettle(page, waitAfterClick + 2000);
          await dismissPopups(page);
          const hashAfter = await hashPageContent(page);
          if (hashBefore !== hashAfter) {
            clicked = true;
            break;
          }
        }
      } catch {
        // button not found or not clickable
      }
    }
    if (!clicked) break;
  }
}

// ---------------------------------------------------------------------------
// Form Fallback — check unchecked checkboxes/toggles (terms, consent, etc.)
// ---------------------------------------------------------------------------

async function checkAllUnchecked(page, log) {
  let checkedAny = false;

  // Strategy 1: Real checkbox inputs that are unchecked
  const checkboxes = page.locator('input[type="checkbox"]:not(:checked):visible');
  const checkboxCount = await checkboxes.count().catch(() => 0);
  for (let i = 0; i < checkboxCount; i++) {
    try {
      await checkboxes.nth(i).check({ timeout: 2000 });
      if (log) log.info(`Fallback: checked checkbox ${i + 1}/${checkboxCount}`);
      checkedAny = true;
    } catch {
      // might be hidden or non-interactive
    }
  }

  // Strategy 2: Clickable label/div/button near checkbox-like text (terms, agree, privacy, consent)
  if (!checkedAny) {
    const consentPatterns = ['agree', 'terms', 'privacy', 'consent', 'accept'];
    for (const pattern of consentPatterns) {
      const el = page.locator(`label:has-text("${pattern}"), [class*="checkbox"]:has-text("${pattern}"), [class*="toggle"]:has-text("${pattern}"), [role="checkbox"]:has-text("${pattern}")`).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        try {
          await el.click({ timeout: 2000 });
          if (log) log.info(`Fallback: clicked consent element matching "${pattern}"`);
          checkedAny = true;
          break;
        } catch {
          // not clickable
        }
      }
    }
  }

  return checkedAny;
}

async function hasPageNavigated(page, hashBefore) {
  const hashAfter = await hashPageContent(page);
  return hashBefore !== hashAfter;
}

// ---------------------------------------------------------------------------
// Wait for content change (handles loaders, redirects, async transitions)
// ---------------------------------------------------------------------------

async function waitForContentChange(page, hashBefore, maxWaitMs = 5000) {
  const interval = 500;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    // Wait for any pending navigations or network requests
    await page.waitForLoadState('networkidle', { timeout: interval }).catch(() => {});
    const hashAfter = await hashPageContent(page);
    if (hashBefore !== hashAfter) return hashAfter;
    await page.waitForTimeout(interval);
  }
  return hashBefore;
}

/**
 * Wait for content to stabilize — hash stops changing for `stableMs`.
 * Useful for loader/progress pages that keep updating before settling.
 */
async function waitForContentStable(page, maxWaitMs = 20000, stableMs = 3000) {
  const deadline = Date.now() + maxWaitMs;
  let lastHash = await hashPageContent(page);
  let lastChangeTime = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
    const currentHash = await hashPageContent(page);
    if (currentHash !== lastHash) {
      lastHash = currentHash;
      lastChangeTime = Date.now();
    } else if (Date.now() - lastChangeTime >= stableMs) {
      // Content has been stable for stableMs — done
      return lastHash;
    }
  }
  return lastHash;
}

// ---------------------------------------------------------------------------
// Session State Helpers
// ---------------------------------------------------------------------------

async function saveSessionState(page, actions, sessionStoreRef, log) {
  const fingerprint = fingerprintActions(actions);
  try {
    const context = page.context();
    const cookies = await context.cookies();
    const localStorage = await page.evaluate(() => {
      const items = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        items.push({ name: key, value: window.localStorage.getItem(key) });
      }
      return items;
    });
    sessionStoreRef.set(fingerprint, {
      url: page.url(),
      cookies,
      localStorage,
    });
  } catch (err) {
    log.warning(`Failed to save session state: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Action Execution
// ---------------------------------------------------------------------------

async function executeAction(page, action, waitAfterClick, log) {
  try {
    if (action.type === 'click') {
      // Try text-based finding first, fall back to CSS selector
      let el = await findClickableByLabel(page, action.label);

      if (!el && action.selector) {
        const cssEl = page.locator(action.selector).first();
        if (await cssEl.isVisible({ timeout: 1000 }).catch(() => false)) {
          el = cssEl;
        }
      }

      if (!el) {
        if (log) log.warning(`Click action: element not found for label="${action.label}" selector="${action.selector || 'none'}"`);
        return false;
      }

      await el.click({ timeout: 5000 });
      await waitForSettle(page, waitAfterClick + 2000);
      return true;
    }

    if (action.type === 'fill_and_submit') {
      if (log) log.info(`Form: filling ${(action.formFields || []).length} fields, submit="${action.submitSelector || 'none'}"`);
      await fillForm(page, action.formFields || [], log);
      if (action.submitSelector) {
        // Try text-based finding for submit button too
        let submitEl = action.submitLabel
          ? await findClickableByLabel(page, action.submitLabel)
          : null;

        if (!submitEl) {
          submitEl = page.locator(action.submitSelector).first();
        }

        const submitVisible = await submitEl.isVisible({ timeout: 2000 }).catch(() => false);
        if (submitVisible) {
          if (log) log.info(`Form: clicking submit selector="${action.submitSelector}"`);
          await submitEl.click({ timeout: 5000 });
          await waitForSettle(page, waitAfterClick + 2000);
        } else {
          if (log) log.warning(`Form: submit button not visible selector="${action.submitSelector}"`);
        }
      }
      return true;
    }

    return false;
  } catch (err) {
    if (log) log.warning(`executeAction failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Record Pushing
// ---------------------------------------------------------------------------

async function pushRecord(page, actions, depth, screenshotUrl, isEndOfFunnel, pageType, llmReasoning) {
  const pageTitle = await page.title().catch(() => '');
  const url = page.url();
  const pathString = actions.map((a) => a.label).join(' > ');

  collectedScreenshots.push({ screenshot_url: screenshotUrl, page_url: url });

  await Actor.pushData({
    screenshotUrl,
    actions,
    pathString,
    depth,
    pageTitle,
    url,
    isEndOfFunnel,
    pageType,
    llmReasoning,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Screenshot Worthiness Gate
// ---------------------------------------------------------------------------

async function takeScreenshotIfWorthy(page, kvStore, depth, actions, log) {
  try {
    const title = await page.title().catch(() => '');
    const url = page.url();
    const bodySnippet = await page.evaluate(() => (document.body.innerText || '').slice(0, 500)).catch(() => '');

    const worthy = await isWorthScreenshot(title, url, bodySnippet);
    if (!worthy) {
      log.info(`Screenshot skipped — page not worth capturing: "${title}" (${url})`);
      return null;
    }

    const screenshotUrl = await takeScreenshot(page, kvStore, depth, actions);
    return screenshotUrl;
  } catch (err) {
    log.error(`Screenshot failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await Actor.init();

try {
  const input = await Actor.getInput() ?? {};
  const {
    startUrl,
    maxDepth = 20,
    maxBranches = 5,
    waitAfterClick = 1000,
    viewportWidth = 390,
    viewportHeight = 844,
    anthropicApiKey,
    webhookUrl: inputWebhookUrl,
    runId: inputRunId,
  } = input;

  const webhookUrl = inputWebhookUrl || process.env.WEBHOOK_URL;
  const runId = inputRunId || process.env.RUN_ID || randomUUID();

  const apiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing Anthropic API key. Provide anthropicApiKey in input or set ANTHROPIC_API_KEY env var.');
  }

  validateStartUrl(startUrl);
  const kvStore = await Actor.openKeyValueStore();
  initLlmClient(apiKey);

  const crawler = new PlaywrightCrawler({
    maxConcurrency: 1,
    maxRequestRetries: 1,
    maxRequestsPerCrawl: 1000,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 180,
    headless: true,
    launchContext: {
      launchOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    },

    async requestHandler({ page, request, log }) {
      const { actions = [], depth = 0 } = request.userData;

      await page.setViewportSize({ width: viewportWidth, height: viewportHeight });

      // Restore session state if available, otherwise replay from scratch
      const parentActions = actions.slice(0, -1);
      const parentFingerprint = actions.length > 0 ? fingerprintActions(parentActions) : null;
      const savedSession = parentFingerprint ? sessionStore.get(parentFingerprint) : null;

      if (savedSession && actions.length > 0) {
        // Fast path: restore cookies/localStorage, navigate to saved URL, execute only last action
        log.info(`Restoring session state for depth=${depth} (skipping ${actions.length - 1} replay steps)`);
        const context = page.context();
        await context.addCookies(savedSession.cookies);
        await page.goto(savedSession.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.evaluate((items) => {
          for (const { name, value } of items) {
            window.localStorage.setItem(name, value);
          }
        }, savedSession.localStorage);
        await page.waitForTimeout(1000);
        await dismissPopups(page);

        // Execute only the last action
        const lastAction = actions[actions.length - 1];
        const success = await executeAction(page, lastAction, waitAfterClick, log);
        if (!success) {
          log.warning(`Session-restored action "${lastAction.label}" failed — falling back to full replay`);
          // Fall through to full replay below
        } else {
          await dismissPopups(page);
          await autoAdvanceNav(page, waitAfterClick, log);
        }

        // If the fast path action failed, we need to do full replay
        if (!success) {
          await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.waitForTimeout(1000);
          await dismissPopups(page);

          for (const action of actions) {
            await dismissPopups(page);
            const ok = await executeAction(page, action, waitAfterClick, log);
            if (!ok) {
              log.warning(`Replay failed at action "${action.label}" — skipping state`);
              return;
            }
            await dismissPopups(page);
            await autoAdvanceNav(page, waitAfterClick, log);
          }
        }
      } else {
        // No saved session — full replay from scratch
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(1000);
        await dismissPopups(page);

        for (const action of actions) {
          await dismissPopups(page);
          const success = await executeAction(page, action, waitAfterClick, log);
          if (!success) {
            log.warning(`Replay failed at action "${action.label}" — skipping state`);
            return;
          }
          await dismissPopups(page);
          await autoAdvanceNav(page, waitAfterClick, log);
        }
      }

      // LLM analysis loop
      const MAX_ITERATIONS = 10;
      const seenHashes = new Set();
      let screenshotted = false;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        // Dismiss any popups that may have appeared
        await dismissPopups(page);

        // Check for cycles
        const currentHash = await hashPageContent(page);
        if (seenHashes.has(currentHash)) {
          log.info('Detected content cycle, stopping analysis loop');
          break;
        }
        seenHashes.add(currentHash);

        // Extract snapshot and analyze — tries content cache first, then LLM
        const snapshot = await extractPageSnapshot(page);
        const analysis = await analyzePage(snapshot, page.url(), startUrl, depth, maxDepth);

        const source = analysis.reasoning.startsWith('[cached') ? 'cache' : 'LLM';
        log.info(`Analysis [${source}] [depth=${depth}, iter=${iteration}]: ${analysis.pageType} — ${analysis.reasoning}`);

        // Helper: only screenshot if we haven't captured this content before
        const alreadySeen = globalSeenHashes.has(currentHash);
        if (alreadySeen) {
          log.info(`Skipping screenshot — content already captured (hash ${currentHash.slice(0, 8)})`);
        }

        // --- end_of_funnel ---
        if (analysis.isEndOfFunnel || analysis.pageType === 'end_of_funnel') {
          if (!alreadySeen) {
            const screenshotUrl = await takeScreenshotIfWorthy(page, kvStore, depth, actions, log);
            globalSeenHashes.add(currentHash);
            if (screenshotUrl) {
              await pushRecord(page, actions, depth, screenshotUrl, true, analysis.pageType, analysis.reasoning);
            }
          }
          screenshotted = true;
          return;
        }

        // --- form ---
        if (analysis.pageType === 'form') {
          const hashBefore = currentHash;
          const fields = analysis.formFields || [];
          log.info(`Form fields from LLM (${fields.length}): ${JSON.stringify(fields.map((f) => ({ type: f.type, selector: f.selector, value: f.value })))}`);
          log.info(`Form submit selector: ${analysis.submitSelector || '(none)'}`);

          const formAction = {
            type: 'fill_and_submit',
            formFields: fields,
            submitSelector: analysis.submitSelector,
            label: 'Form submission',
          };
          let success = await executeAction(page, formAction, waitAfterClick, log);

          if (success) {
            // Wait longer for forms — they often trigger loaders/redirects
            let hashAfter = await waitForContentChange(page, hashBefore, 10000);

            // If content didn't change or same page (validation error), try checking
            // any unchecked checkboxes/toggles and re-submitting
            if (hashBefore === hashAfter || !await hasPageNavigated(page, hashBefore)) {
              log.info('Form submit may have failed — checking for unchecked checkboxes/toggles');
              const checkedAny = await checkAllUnchecked(page, log);
              if (checkedAny && analysis.submitSelector) {
                log.info('Retrying form submit after checking unchecked elements');
                const submitEl = page.locator(analysis.submitSelector).first();
                if (await submitEl.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await submitEl.click({ timeout: 5000 });
                  await waitForSettle(page, waitAfterClick + 2000);
                  hashAfter = await waitForContentChange(page, hashBefore, 10000);
                }
              }
            }

            // If we got past the form, wait for content to fully stabilize
            // (handles loaders/progress bars after form submission)
            if (hashBefore !== hashAfter) {
              log.info('Form submitted — waiting for content to stabilize past any loaders...');
              const stableHash = await waitForContentStable(page, 20000, 3000);
              hashAfter = stableHash;
            }

            if (hashBefore !== hashAfter) {
              await saveSessionState(page, actions, sessionStore, log);
              if (!globalSeenHashes.has(hashAfter)) {
                const screenshotUrl = await takeScreenshotIfWorthy(page, kvStore, depth, actions, log);
                globalSeenHashes.add(hashAfter);
                if (screenshotUrl) {
                  await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
                }
              } else {
                log.info('Skipping screenshot — form result already captured');
              }
              screenshotted = true;
              continue;
            }
          }
          log.warning('Form submission did not change page content');
          break;
        }

        // --- navigation ---
        if (analysis.pageType === 'navigation') {
          const navButtons = analysis.navButtons || [];
          if (navButtons.length === 0) {
            log.warning('Navigation type but no nav buttons found');
            break;
          }

          // Click all nav buttons in sequence (e.g. "Select everything" then "Continue")
          const hashBefore = currentHash;
          for (const navBtn of navButtons) {
            const navAction = { type: 'click', selector: navBtn.selector, label: navBtn.label };
            await executeAction(page, navAction, waitAfterClick, log);
          }

          const hashAfter = await waitForContentChange(page, hashBefore);
          if (hashBefore !== hashAfter) {
            await saveSessionState(page, actions, sessionStore, log);
            if (!globalSeenHashes.has(hashAfter)) {
              const screenshotUrl = await takeScreenshotIfWorthy(page, kvStore, depth, actions, log);
              globalSeenHashes.add(hashAfter);
              if (screenshotUrl) {
                await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
              }
            } else {
              log.info('Skipping screenshot — nav result already captured');
            }
            screenshotted = true;
            continue;
          }
          log.warning('Navigation clicks did not change page content');
          break;
        }

        // --- quiz_choices ---
        if (analysis.pageType === 'quiz_choices') {
          const choices = (analysis.quizChoices || []).slice(0, maxBranches);
          if (choices.length === 0) {
            log.warning('Quiz choices type but no choices found');
            break;
          }

          // Screenshot the question page (only if new)
          if (!alreadySeen) {
            const screenshotUrl = await takeScreenshotIfWorthy(page, kvStore, depth, actions, log);
            globalSeenHashes.add(currentHash);
            if (screenshotUrl) {
              await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
            }
          }
          screenshotted = true;

          // Save session state so child requests can restore directly here
          if (depth < maxDepth) {
            await saveSessionState(page, actions, sessionStore, log);

            // Enqueue child states for each choice
            for (const choice of choices) {
              const childAction = { type: 'click', selector: choice.selector, label: choice.label };
              const childActions = [...actions, childAction];
              const uniqueKey = fingerprintActions(childActions);

              await crawler.addRequests([{
                url: startUrl,
                uniqueKey,
                userData: {
                  actions: childActions,
                  depth: depth + 1,
                },
              }]);
            }
          }
          return;
        }

        // --- other ---
        // If this is an LLM failure, try blind clicking before giving up
        if (isLlmFailure(analysis)) {
          log.info('LLM failed — attempting blind click fallback');
          const clicked = await blindClickFallback(page, startUrl, waitAfterClick, log);
          if (clicked) {
            log.info('Blind click fallback succeeded — re-analyzing in next iteration');
            continue;
          }
          log.info('Blind click fallback failed — falling through to stabilization wait');
        }

        // Might be a loading/progress page — wait for content to stabilize
        log.info('Page classified as "other" — waiting up to 20s for content to stabilize...');
        const stableHash = await waitForContentStable(page, 20000, 3000);
        if (stableHash !== currentHash) {
          log.info('Content changed after waiting — re-analyzing');
          continue;
        }

        // Truly static — screenshot and stop
        if (!alreadySeen) {
          const screenshotUrl = await takeScreenshotIfWorthy(page, kvStore, depth, actions, log);
          globalSeenHashes.add(currentHash);
          if (screenshotUrl) {
            await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
          }
        }
        screenshotted = true;
        return;
      }

      // Screenshot final state if not already captured
      if (!screenshotted) {
        const finalHash = await hashPageContent(page);
        if (!globalSeenHashes.has(finalHash)) {
          const screenshotUrl = await takeScreenshotIfWorthy(page, kvStore, depth, actions, log);
          globalSeenHashes.add(finalHash);
          if (screenshotUrl) {
            await pushRecord(page, actions, depth, screenshotUrl, false, 'unknown', 'Loop exhausted without classification');
          }
        }
      }
    },

    async failedRequestHandler({ request, log }) {
      const { actions = [] } = request.userData;
      log.error(`Request failed: ${actions.map((a) => a.label).join(' > ') || '(start)'}`);
    },
  });

  // Seed the initial state
  await crawler.addRequests([{
    url: startUrl,
    uniqueKey: fingerprintActions([]),
    userData: { actions: [], depth: 0 },
  }]);

  await crawler.run();

  const stats = getCacheStats();
  console.log(`LLM stats: ${stats.cacheHits} cache hits, ${stats.cacheMisses} LLM calls | ${sessionStore.size} session states saved`);

  // POST collected screenshots to webhook
  if (webhookUrl && collectedScreenshots.length > 0) {
    try {
      const payload = {
        runId,
        startUrl,
        screenshots: collectedScreenshots,
        count: collectedScreenshots.length,
        timestamp: new Date().toISOString(),
      };
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log(`Webhook POST to ${webhookUrl}: ${res.status} ${res.statusText} (${collectedScreenshots.length} screenshots)`);
    } catch (webhookErr) {
      console.error(`Webhook POST failed: ${webhookErr.message}`);
    }
  }
} catch (err) {
  await Actor.fail(`Actor failed: ${err.message}`);
}

await Actor.exit();
