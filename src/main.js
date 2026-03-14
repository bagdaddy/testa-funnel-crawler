import { randomUUID } from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import {
  validateStartUrl,
  dismissPopups,
  extractPageSnapshot,
  hashPageContent,
  snapshotDiff,
  waitForSettle,
  fingerprintActions,
  takeScreenshot,
  triggerAnimations,
} from './page-utils.js';
import { initLlmClient, analyzePage, getCacheStats } from './llm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeLabel(label) {
  if (!label) return '';
  return label
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function narrativePrefix(userData) {
  const { depth = 0, branchIndex, branchTotal, branchLabel } = userData;
  if (depth === 0) return '[start]';
  if (branchIndex != null && branchTotal != null) {
    const label = branchLabel ? ` "${branchLabel}"` : '';
    return `[branch ${branchIndex}/${branchTotal}${label}]`;
  }
  return `[depth ${depth}]`;
}

/**
 * Bidirectional text match for branch label ↔ link text.
 * Returns true if either string contains the other (case-insensitive).
 */
function matchLinkText(linkText, branchLabel) {
  if (!linkText || !branchLabel) return false;
  const lt = linkText.toLowerCase().trim();
  const bl = branchLabel.toLowerCase().trim();
  return lt.includes(bl) || bl.includes(lt);
}

// ---------------------------------------------------------------------------
// Global State
// ---------------------------------------------------------------------------
const globalSeenHashes = new Set();
const globalVisitedUrls = new Set();
const collectedScreenshots = [];
let screenshotCounter = 0;
const screenshotsPerUrl = new Map();
const MAX_SCREENSHOTS_PER_URL = 3;

// ---------------------------------------------------------------------------
// Action Execution
// ---------------------------------------------------------------------------

async function executeFillAction(page, action, log) {
  const fillType = (action.fillType || 'text').toLowerCase();
  try {
    let el = page.locator(action.selector).first();
    let visible = await el.isVisible({ timeout: 2000 }).catch(() => false);

    if (!visible && action.label) {
      const byPlaceholder = page.getByPlaceholder(action.label, { exact: false }).first();
      if (await byPlaceholder.isVisible({ timeout: 1000 }).catch(() => false)) {
        el = byPlaceholder;
        visible = true;
      } else {
        const byLabel = page.getByLabel(action.label, { exact: false }).first();
        if (await byLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
          el = byLabel;
          visible = true;
        }
      }
    }

    if (!visible) {
      log.warning(`Fill target not visible: "${action.label}" selector="${action.selector}"`);
      return false;
    }

    if (fillType === 'click' || fillType === 'checkbox' || fillType === 'radio') {
      log.info(`    fill: clicking "${action.label}"`);
      try {
        if (fillType === 'checkbox' || fillType === 'radio') {
          await el.check({ timeout: 3000 });
        } else {
          await el.click({ timeout: 3000 });
        }
      } catch {
        let fallbackClicked = false;
        try {
          const siblingBtn = el.locator('..').locator('button').first();
          if (await siblingBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await siblingBtn.click({ timeout: 3000 });
            fallbackClicked = true;
          }
        } catch { /* no sibling button */ }

        if (!fallbackClicked) {
          try {
            const parent = el.locator('..');
            await parent.click({ timeout: 3000 });
            fallbackClicked = true;
          } catch { /* parent not clickable */ }
        }

        if (!fallbackClicked) {
          await el.click({ force: true, timeout: 3000 }).catch(() => {});
          await page.evaluate((sel) => {
            const input = document.querySelector(sel);
            if (input && input.type === 'checkbox') {
              input.checked = !input.checked;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }, action.selector).catch(() => {});
        }
      }
    } else if (fillType === 'select') {
      log.info(`    fill: selecting "${action.value}" in "${action.label}"`);
      await el.selectOption(action.value || '', { timeout: 3000 });
    } else {
      log.info(`    fill: typing "${action.value}" in "${action.label}"`);
      await el.fill(action.value || '', { timeout: 3000 });
    }
    await page.waitForTimeout(200);
    return true;
  } catch (err) {
    log.warning(`Fill action failed "${action.label}": ${err.message}`);
    return false;
  }
}

async function executeAdvanceAction(page, action, waitAfterClick, log) {
  try {
    let el = page.locator(action.selector).first();
    let visible = await el.isVisible({ timeout: 3000 }).catch(() => false);

    if (!visible && action.label) {
      log.info(`    advance: selector hidden, trying text lookup for "${action.label}"`);
      const byRole = page.getByRole('button', { name: action.label, exact: false }).or(
        page.getByRole('link', { name: action.label, exact: false }),
      ).first();
      if (await byRole.isVisible({ timeout: 2000 }).catch(() => false)) {
        el = byRole;
        visible = true;
      }
    }

    if (!visible) {
      log.info(`    advance: force-clicking hidden "${action.label}"`);
      try {
        const origEl = page.locator(action.selector).first();
        await origEl.click({ force: true, timeout: 5000 });
        await waitForSettle(page, waitAfterClick + 2000);
        return true;
      } catch (forceErr) {
        log.warning(`    advance: force-click failed "${action.label}": ${forceErr.message}`);
        return false;
      }
    }

    log.info(`    advance: clicking "${action.label}"`);

    try {
      await el.click({ timeout: 5000 });
    } catch {
      const href = await el.evaluate((node) => {
        if (node.tagName === 'A' && node.href) return node.href;
        const parentLink = node.closest('a[href]');
        if (parentLink) return parentLink.href;
        const childLink = node.querySelector('a[href]');
        if (childLink) return childLink.href;
        return null;
      }).catch(() => null);

      if (href) {
        log.info(`    advance: navigating directly to ${href}`);
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } else {
        log.info(`    advance: retrying with force=true "${action.label}"`);
        await el.click({ force: true, timeout: 5000 });
      }
    }

    await waitForSettle(page, waitAfterClick + 2000);
    return true;
  } catch (err) {
    log.warning(`Advance action failed "${action.label}": ${err.message}`);
    return false;
  }
}

async function preparePageForCrawling(page) {
  await page.evaluate(() => {
    window.open = (url) => {
      if (url && url !== 'about:blank') window.location.href = url;
    };
    document.querySelectorAll('a[target="_blank"]').forEach((a) => {
      a.target = '_self';
    });
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Branch Resolution (three-tier)
// ---------------------------------------------------------------------------

/**
 * Resolve a navigable URL for a branch action.
 * Tier 1: DOM href (element, parent, child <a> tag)
 * Tier 2: Bidirectional text match against snapshot links
 * Tier 3: Click-and-capture (click element, capture URL change, navigate back)
 */
async function resolveBranchUrl(page, branch, snapshot, waitAfterClick, log) {
  // Tier 1: DOM href
  const domHref = await page.locator(branch.selector).first().evaluate((el) => {
    if (el.tagName === 'A' && el.href) return el.href;
    const parentLink = el.closest('a[href]');
    if (parentLink) return parentLink.href;
    const childLink = el.querySelector('a[href]');
    if (childLink) return childLink.href;
    return null;
  }).catch(() => null);

  if (domHref && (domHref.startsWith('http://') || domHref.startsWith('https://'))) {
    log.info(`    branch "${branch.label}": resolved via DOM href → ${domHref}`);
    return domHref;
  }

  // Tier 2: Match branch label against snapshot links
  if (snapshot.links) {
    const match = snapshot.links.find((l) => matchLinkText(l.text, branch.label));
    if (match) {
      log.info(`    branch "${branch.label}": resolved via link text match → ${match.href}`);
      return match.href;
    }
  }

  // Tier 3: Click-and-capture
  const urlBefore = page.url();
  log.info(`    branch "${branch.label}": attempting click-and-capture`);
  const clicked = await executeAdvanceAction(page, branch, waitAfterClick, log);
  if (!clicked) return null;

  const urlAfter = page.url();
  if (urlAfter !== urlBefore && urlAfter.split('#')[0] !== urlBefore.split('#')[0]) {
    log.info(`    branch "${branch.label}": captured URL → ${urlAfter}`);
    // Navigate back to the original page so other branches can be resolved
    await page.goto(urlBefore, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1000);
    return urlAfter;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Branch Enqueueing (deduplicated helper)
// ---------------------------------------------------------------------------

async function enqueueBranches(page, branches, snapshot, ctx) {
  const { actions, depth, maxBranches, maxDepth, crawler, startUrl, waitAfterClick, log } = ctx;

  if (depth >= maxDepth) {
    log.info(`  Max depth ${maxDepth} reached — not branching`);
    return 0;
  }

  const branchList = branches.slice(0, maxBranches);
  log.info(`  Found ${branchList.length} branches: ${branchList.map((b) => b.label).join(', ')}`);

  let enqueued = 0;
  for (let i = 0; i < branchList.length; i++) {
    const branch = branchList[i];
    const href = await resolveBranchUrl(page, branch, snapshot, waitAfterClick, log);

    if (!href) {
      log.info(`    branch "${branch.label}": no navigable URL — skipping`);
      continue;
    }

    const normalizedHref = href.split('#')[0];
    if (globalVisitedUrls.has(normalizedHref)) {
      log.info(`    branch "${branch.label}": already visited ${normalizedHref} — skipping`);
      continue;
    }

    enqueued++;
    const childAction = { type: 'click', selector: branch.selector, label: branch.label };
    const childActions = [...actions, childAction];
    await crawler.addRequests([{
      url: href,
      uniqueKey: fingerprintActions(childActions),
      userData: {
        actions: childActions,
        depth: depth + 1,
        directUrl: href,
        branchIndex: enqueued,
        branchTotal: branchList.length,
        branchLabel: branch.label,
      },
    }]);
  }

  log.info(`  Enqueued ${enqueued}/${branchList.length} branches`);
  return enqueued;
}

// ---------------------------------------------------------------------------
// Analysis Loop Helpers
// ---------------------------------------------------------------------------

async function maybeScreenshot(page, currentHash, currentUrl, localScreenshotHashes, depth, actions, kvStore, iteration, log) {
  const baseUrlForCap = currentUrl.split('#')[0];
  const urlScreenshots = screenshotsPerUrl.get(baseUrlForCap) || 0;

  if (urlScreenshots >= MAX_SCREENSHOTS_PER_URL) {
    return;
  }

  if (localScreenshotHashes.has(currentHash)) {
    return;
  }

  const screenshotUrl = await takeScreenshot(page, kvStore, depth, actions, { seq: ++screenshotCounter });
  localScreenshotHashes.add(currentHash);
  globalSeenHashes.add(currentHash);
  screenshotsPerUrl.set(baseUrlForCap, urlScreenshots + 1);
  if (screenshotUrl) {
    await pushRecord(page, actions, depth, screenshotUrl, false, `depth=${depth} iter=${iteration}`);
    log.info(`  Screenshotted page (#${screenshotCounter})`);
  }
}

async function screenshotPostFill(page, currentHash, currentUrl, localScreenshotHashes, depth, actions, kvStore, iteration, log) {
  const postFillHash = await hashPageContent(page);
  const baseUrlForCap = currentUrl.split('#')[0];
  const urlScreenshots = screenshotsPerUrl.get(baseUrlForCap) || 0;

  if (postFillHash !== currentHash && !localScreenshotHashes.has(postFillHash) && urlScreenshots < MAX_SCREENSHOTS_PER_URL) {
    const screenshotUrl = await takeScreenshot(page, kvStore, depth, actions, { seq: ++screenshotCounter });
    localScreenshotHashes.add(postFillHash);
    globalSeenHashes.add(postFillHash);
    screenshotsPerUrl.set(baseUrlForCap, urlScreenshots + 1);
    if (screenshotUrl) {
      await pushRecord(page, actions, depth, screenshotUrl, false, `depth=${depth} iter=${iteration} post-fill`);
      log.info(`  Screenshotted post-fill state (#${screenshotCounter})`);
    }
  }
}

/**
 * Handle no-actions state (loading pages, terminal with no actions).
 * Returns: 'return' | 'continue' | 'stuck'
 */
async function handleNoActions(page, analysis, currentHash, reConsultState, localSeenHashes, localScreenshotHashes, log) {
  const MAX_LOADING_RETRIES = analysis.pageType === 'loading' ? 7 : 5;

  if (analysis.isTerminal) {
    reConsultState.consecutiveTerminalCount++;
    if (reConsultState.consecutiveTerminalCount >= 2) {
      log.info(`  Terminal: confirmed ${reConsultState.consecutiveTerminalCount}x — done`);
      return 'return';
    }
  } else {
    reConsultState.consecutiveTerminalCount = 0;
  }

  const reason = analysis.isTerminal ? 'terminal (no actions)' : analysis.pageType === 'loading' ? 'loading' : 'no actions';
  log.info(`  Waiting for content change (${reason}, up to ${MAX_LOADING_RETRIES * 2}s)...`);

  for (let wait = 0; wait < MAX_LOADING_RETRIES; wait++) {
    await page.waitForTimeout(2000);
    const newHash = await hashPageContent(page);
    if (newHash !== currentHash) {
      log.info('  Content changed — re-analyzing');
      return 'continue';
    }
  }

  if (reConsultState.reConsultCount < 2) {
    reConsultState.reConsultCount++;
    log.info(`  Re-consulting LLM (${reason}, attempt ${reConsultState.reConsultCount}/2)`);
    localSeenHashes.delete(currentHash);
    localScreenshotHashes.delete(currentHash);
    return 'continue';
  }

  log.info(`  Dead end — ${reason}, no change after 2 re-consults`);
  return 'return';
}

/**
 * Handle advance actions: execute, detect changes, re-consult if stuck.
 * Returns: 'return' | 'continue'
 */
async function handleAdvances(page, advances, snapshot, selectorAttempts, reConsultState, localSeenHashes, localScreenshotHashes, currentHash, ctx) {
  const { actions, depth, maxDepth, maxBranches, crawler, startUrl, waitAfterClick, kvStore, log } = ctx;
  const MAX_SELECTOR_ATTEMPTS = 3;

  const freshAdvances = advances.filter((a) => {
    const attempts = selectorAttempts.get(normalizeLabel(a.label)) || 0;
    return attempts < MAX_SELECTOR_ATTEMPTS;
  });

  if (freshAdvances.length === 0) {
    log.info(`  Exhausted after ${MAX_SELECTOR_ATTEMPTS} attempts — moving on`);
    return 'return';
  }

  const urlBefore = page.url();

  for (const advance of freshAdvances) {
    const key = normalizeLabel(advance.label);
    const attemptNum = (selectorAttempts.get(key) || 0) + 1;
    selectorAttempts.set(key, attemptNum);
    const suffix = attemptNum > 1 ? ` (attempt ${attemptNum}/${MAX_SELECTOR_ATTEMPTS})` : '';
    log.info(`  Clicking "${advance.label}"${suffix}...`);
  }

  for (const advance of freshAdvances) {
    await executeAdvanceAction(page, advance, waitAfterClick, log);
  }

  // URL changed = real navigation
  const urlAfterBase = page.url().split('#')[0];
  const urlBeforeBase = urlBefore.split('#')[0];
  if (urlAfterBase !== urlBeforeBase) {
    log.info(`  URL changed → ${page.url()}`);
    selectorAttempts.clear();
    return 'continue';
  }

  // Check structural change
  await page.waitForTimeout(500);
  const postAdvanceSnapshot = await extractPageSnapshot(page);
  const diff = snapshotDiff(snapshot, postAdvanceSnapshot);

  if (diff.structureChanged) {
    log.info(`  Page changed → ${diff.summary}`);
    return 'continue';
  }

  // Wait for slow transitions
  log.info(`  No meaningful change (${diff.summary}), waiting for transition...`);
  for (let wait = 0; wait < 6; wait++) {
    await page.waitForTimeout(2000);
    const transitionSnapshot = await extractPageSnapshot(page);
    const transitionDiff = snapshotDiff(snapshot, transitionSnapshot);
    if (transitionDiff.structureChanged) {
      log.info(`  Page changed after waiting → ${transitionDiff.summary}`);
      return 'continue';
    }
  }

  // Re-consult LLM
  if (reConsultState.reConsultCount < 2) {
    reConsultState.reConsultCount++;
    const triedLabels = freshAdvances.map((a) => a.label).join(', ');
    const actionContext = `I clicked these elements but the page content did not change: ${triedLabels}. The clicks may have failed silently, or there may be different elements to interact with. Please re-examine the page and suggest alternative actions.`;

    log.info(`  Re-consulting LLM for alternatives (attempt ${reConsultState.reConsultCount}/2)`);

    const freshSnapshot = await extractPageSnapshot(page);
    const reAnalysis = await analyzePage(freshSnapshot, page.url(), depth, maxDepth, {
      skipCache: true,
      actionContext,
    });

    log.info(`  Re-analysis: ${reAnalysis.pageType} — ${reAnalysis.reasoning}`);

    if (reAnalysis.isTerminal || reAnalysis.actions.length === 0) {
      log.info(`  Terminal: ${reAnalysis.reasoning}`);
      return 'return';
    }

    const reFills = reAnalysis.actions.filter((a) => a.kind === 'fill');
    const reBranches = reAnalysis.actions.filter((a) => a.kind === 'branch');
    const reAdvances = reAnalysis.actions.filter((a) => a.kind === 'advance');

    for (const fill of reFills) {
      await executeFillAction(page, fill, log);
    }

    if (reBranches.length > 0) {
      const branchCtx = { actions, depth, maxBranches, maxDepth, crawler, startUrl, waitAfterClick, log };
      await enqueueBranches(page, reBranches, freshSnapshot, branchCtx);
      return 'return';
    }

    if (reAdvances.length > 0) {
      for (const advance of reAdvances) {
        await executeAdvanceAction(page, advance, waitAfterClick, log);
      }

      await page.waitForTimeout(500);
      const rePostSnapshot = await extractPageSnapshot(page);
      const reDiff = snapshotDiff(snapshot, rePostSnapshot);
      if (reDiff.structureChanged) {
        log.info(`  Page changed after re-consult → ${reDiff.summary}`);
        return 'continue';
      }
    }

    localSeenHashes.delete(currentHash);
    localScreenshotHashes.delete(currentHash);
    return 'continue';
  }

  log.info(`  Exhausted all advance attempts and re-consults — moving on`);
  return 'return';
}

// ---------------------------------------------------------------------------
// Record Pushing
// ---------------------------------------------------------------------------

async function pushRecord(page, actions, depth, screenshotUrl, isTerminal, reasoning) {
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
    isTerminal,
    reasoning,
    timestamp: new Date().toISOString(),
  });
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
    maxBranches = 6,
    waitAfterClick = 1000,
    viewportWidth = 1440,
    viewportHeight = 1080,
    anthropicApiKey,
    webhookUrl: inputWebhookUrl,
    runId: inputRunId,
  } = input;

  const webhookUrl = inputWebhookUrl || process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
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
    requestHandlerTimeoutSecs: 900,
    headless: true,
    launchContext: {
      launchOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    },

    async requestHandler({ page, request, log }) {
      const { actions = [], depth = 0, directUrl = null } = request.userData;
      const prefix = narrativePrefix(request.userData);

      await page.setViewportSize({ width: viewportWidth, height: viewportHeight });

      // Navigate: directUrl means Crawlee already navigated to the right page
      if (directUrl) {
        log.info(`${prefix} ${directUrl}`);
        await page.waitForTimeout(1000);
        await dismissPopups(page);
      } else {
        // Seed request (depth 0)
        log.info(`${prefix} ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(1000);
        await dismissPopups(page);
      }

      // Safety net: skip if already visited (redundant with enqueueBranches check, but
      // catches redirects and edge cases)
      const landingUrl = page.url().split('#')[0];
      if (globalVisitedUrls.has(landingUrl) && depth > 0) {
        log.info(`  Already visited ${landingUrl} — skipping`);
        return;
      }
      globalVisitedUrls.add(landingUrl);

      await triggerAnimations(page);
      await preparePageForCrawling(page);

      // --- Analysis loop ---
      const MAX_ITERATIONS = 50;
      const localSeenHashes = new Set();
      const localScreenshotHashes = new Set();
      const selectorAttempts = new Map();
      const reConsultState = { reConsultCount: 0, consecutiveTerminalCount: 0 };
      let forceSkipCache = false;
      let previousHash = null;
      let previousUrl = '';

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        await dismissPopups(page);
        await preparePageForCrawling(page);

        const currentUrl = page.url();

        // 1. Cycle detection
        const currentHash = await hashPageContent(page);
        if (localSeenHashes.has(currentHash)) {
          log.info('  Cycle detected — stopping');
          break;
        }
        localSeenHashes.add(currentHash);

        if (currentHash !== previousHash) {
          reConsultState.reConsultCount = 0;
        }
        previousHash = currentHash;

        const currentBaseUrl = currentUrl.split('#')[0];
        const previousBaseUrl = previousUrl.split('#')[0];
        if (currentBaseUrl !== previousBaseUrl) {
          selectorAttempts.clear();
        }
        previousUrl = currentUrl;

        // 2. Screenshot
        await maybeScreenshot(page, currentHash, currentUrl, localScreenshotHashes, depth, actions, kvStore, iteration, log);

        // 3. Analyze
        const snapshot = await extractPageSnapshot(page);
        const analyzeOpts = forceSkipCache ? { skipCache: true } : {};
        forceSkipCache = false;
        const analysis = await analyzePage(snapshot, page.url(), depth, maxDepth, analyzeOpts);

        const source = analysis.reasoning.startsWith('[cached') ? 'cached' : 'analyzed';
        log.info(`  ${source} as ${analysis.pageType}: ${analysis.reasoning}`);

        // 4. Terminal with actions → stop
        if (analysis.isTerminal && analysis.actions.length > 0) {
          log.info(`  Terminal: ${analysis.reasoning}`);
          return;
        }

        // 5. No actions (loading / terminal-no-actions)
        if (analysis.actions.length === 0) {
          const result = await handleNoActions(page, analysis, currentHash, reConsultState, localSeenHashes, localScreenshotHashes, log);
          if (result === 'return') return;
          if (result === 'continue') { forceSkipCache = true; continue; }
        }
        reConsultState.consecutiveTerminalCount = 0;

        // 6. Separate actions
        const fills = analysis.actions.filter((a) => a.kind === 'fill');
        const branches = analysis.actions.filter((a) => a.kind === 'branch');
        const advances = analysis.actions.filter((a) => a.kind === 'advance');

        // Execute fills
        if (fills.length > 0) {
          log.info(`  Filling ${fills.length} field${fills.length > 1 ? 's' : ''}: ${fills.map((f) => f.label).join(', ')}`);
          for (const fill of fills) {
            await executeFillAction(page, fill, log);
          }
          await screenshotPostFill(page, currentHash, currentUrl, localScreenshotHashes, depth, actions, kvStore, iteration, log);
        }

        // Branches: enqueue each as separate request
        if (branches.length > 0) {
          const branchCtx = { actions, depth, maxBranches, maxDepth, crawler, startUrl, waitAfterClick, log };
          await enqueueBranches(page, branches, snapshot, branchCtx);
          return;
        }

        // Advances: execute and check for changes
        if (advances.length > 0) {
          const advanceCtx = { actions, depth, maxDepth, maxBranches, crawler, startUrl, waitAfterClick, kvStore, log };
          const result = await handleAdvances(page, advances, snapshot, selectorAttempts, reConsultState, localSeenHashes, localScreenshotHashes, currentHash, advanceCtx);
          if (result === 'return') return;
          forceSkipCache = true;
          continue;
        }

        // Only fills (no advance/branch) — done
        log.info('  Only fill actions on this page — moving on');
        return;
      }
    },

    async failedRequestHandler({ request, log }) {
      const { actions = [] } = request.userData;
      log.error(`Request failed: ${actions.map((a) => a.label).join(' > ') || '(start)'}`);
    },
  });

  // Seed the initial request
  await crawler.addRequests([{
    url: startUrl,
    uniqueKey: fingerprintActions([]),
    userData: { actions: [], depth: 0 },
  }]);

  await crawler.run();

  const stats = getCacheStats();
  console.log(`LLM stats: ${stats.cacheHits} cache hits, ${stats.cacheMisses} LLM calls`);

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
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': webhookSecret },
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
