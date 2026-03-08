import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUDED_LABELS = [
  /privacy\s*policy/i,
  /terms\s*of\s*(service|use)/i,
  /cookie\s*policy/i,
  /refund\s*policy/i,
  /contact\s*us/i,
  /about\s*us/i,
  /\bfaq\b/i,
  /sign\s*up/i,
  /\blog\s*in\b/i,
  /\blogin\b/i,
  /\bregister\b/i,
  /\bunsubscribe\b/i,
  /\baccessibility\b/i,
  /\bsitemap\b/i,
  /\bcareers\b/i,
  /\bpress\b/i,
  /\bblog\b/i,
];

const EXCLUDED_HREFS = [
  'privacy', 'terms', 'cookie', 'refund',
  'contact', 'about', 'faq', 'login',
  'signup', 'register', 'sitemap',
];

const NAV_LABELS = [
  /^next$/i,
  /^continue$/i,
  /^get\s*started$/i,
  /^proceed$/i,
  /^see\s*my\s*results$/i,
  /^show\s*results$/i,
  /^submit$/i,
  /^start$/i,
  /^begin$/i,
  /^go$/i,
  /^confirm$/i,
];

const END_OF_FUNNEL_SIGNALS = [
  /\$\d/,
  /\u20AC\d/,   // €
  /\u00A3\d/,   // £
  /\/month/i,
  /\/year/i,
  /\bcheckout\b/i,
  /\badd\s*to\s*cart\b/i,
  /\bbuy\s*now\b/i,
];

const POPUP_CLOSE_SELECTORS = [
  '[aria-label="close"]',
  '[aria-label="Close"]',
  'button.close',
  '#close',
  '[class*="dismiss"]',
  '[class*="close-button"]',
  '[class*="closeButton"]',
  '[class*="cookie"] button',
  '[class*="banner"] button',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fingerprintPath(path) {
  const key = path.map((s) => `${s.label}::${s.index}`).join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function isExcluded(label, href) {
  const trimmed = label.trim();
  if (EXCLUDED_LABELS.some((re) => re.test(trimmed))) return true;
  if (href && EXCLUDED_HREFS.some((h) => href.toLowerCase().includes(h))) return true;
  return false;
}

function isNavButton(label) {
  return NAV_LABELS.some((re) => re.test(label.trim()));
}

function hasEndOfFunnelSignals(text) {
  return END_OF_FUNNEL_SIGNALS.some((re) => re.test(text));
}

function validateStartUrl(startUrl) {
  if (!startUrl) {
    throw new Error('Missing required input: startUrl');
  }
  try {
    const parsed = new URL(startUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('startUrl must use http or https protocol');
    }
    return parsed.hostname;
  } catch (err) {
    throw new Error(`Invalid startUrl "${startUrl}": ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Popup Dismissal
// ---------------------------------------------------------------------------

async function dismissPopups(page) {
  for (const selector of POPUP_CLOSE_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      }
    } catch {
      // ignore — popup element not present or not clickable
    }
  }
}

// ---------------------------------------------------------------------------
// Button Detection
// ---------------------------------------------------------------------------

const BUTTON_DETECT_TIMEOUT_MS = 10_000;

async function detectButtons(page, startDomain, maxBranches) {
  const selectors = [
    'button:visible',
    '[role="button"]:visible',
    'input[type="button"]:visible',
    'input[type="submit"]:visible',
    'a[href]:visible',
    'label:visible',
  ];

  const seen = new Set();
  const buttons = [];
  const startTime = Date.now();

  for (const selector of selectors) {
    if (buttons.length >= maxBranches) break;
    if (Date.now() - startTime > BUTTON_DETECT_TIMEOUT_MS) break;

    const elements = page.locator(selector);
    const count = await elements.count();

    for (let i = 0; i < count && buttons.length < maxBranches; i++) {
      if (Date.now() - startTime > BUTTON_DETECT_TIMEOUT_MS) break;

      const el = elements.nth(i);

      try {
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;

        const box = await el.boundingBox().catch(() => null);
        if (!box || box.width === 0 || box.height === 0) continue;

        const label = (
          (await el.innerText().catch(() => '')) ||
          (await el.getAttribute('aria-label').catch(() => '')) ||
          (await el.getAttribute('value').catch(() => '')) ||
          ''
        ).trim();

        if (!label) continue;
        if (seen.has(label)) continue;

        const href = await el.getAttribute('href').catch(() => null);

        // Filter links by domain
        if (href) {
          try {
            const absoluteUrl = new URL(href, page.url());
            if (!['http:', 'https:'].includes(absoluteUrl.protocol) && !href.startsWith('#') && !href.startsWith('/') && !href.startsWith('?')) {
              continue;
            }
            if (['http:', 'https:'].includes(absoluteUrl.protocol) && absoluteUrl.hostname !== startDomain) {
              continue;
            }
          } catch {
            continue;
          }
        }

        if (isExcluded(label, href)) continue;

        seen.add(label);
        buttons.push({ label, index: i, selector });
      } catch {
        // element became stale, skip
      }
    }
  }

  return buttons;
}

// ---------------------------------------------------------------------------
// Click Replay
// ---------------------------------------------------------------------------

async function replayClicks(page, startUrl, path, waitAfterClick, log) {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1000);
  await dismissPopups(page);

  for (const step of path) {
    try {
      const elements = page.locator(step.selector);
      const el = elements.nth(step.index);

      await el.waitFor({ state: 'visible', timeout: 5000 });
      await el.click({ timeout: 5000 });

      // Wait for navigation or DOM settle
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitAfterClick + 2000 }).catch(() => {}),
        page.waitForTimeout(waitAfterClick),
      ]);
    } catch (err) {
      log.warning(`Replay failed at step "${step.label}" (index ${step.index}): ${err.message}`);
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Screenshot Helpers
// ---------------------------------------------------------------------------

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024; // 10 MB
const INITIAL_JPEG_QUALITY = 85;
const MIN_JPEG_QUALITY = 30;
const QUALITY_STEP = 15;

async function takeScreenshot(page, kvStore, depth, path) {
  const timestamp = Date.now();
  const pathHash = fingerprintPath(path);
  const key = `screenshot_depth${depth}_${pathHash}_${timestamp}`;

  let quality = INITIAL_JPEG_QUALITY;
  let buffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality });

  while (buffer.length > MAX_SCREENSHOT_BYTES && quality > MIN_JPEG_QUALITY) {
    quality -= QUALITY_STEP;
    buffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality });
  }

  await kvStore.setValue(key, buffer, { contentType: 'image/jpeg' });

  const storeId = kvStore.id || process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID || 'default';
  const screenshotUrl = `https://api.apify.com/v2/key-value-stores/${storeId}/records/${key}`;
  return screenshotUrl;
}

async function pushRecord(page, path, depth, screenshotUrl, isEndOfFunnel) {
  const pageTitle = await page.title().catch(() => '');
  const url = page.url();
  const pathString = path.map((s) => s.label).join(' > ');

  await Actor.pushData({
    screenshotUrl,
    path,
    pathString,
    depth,
    pageTitle,
    url,
    isEndOfFunnel,
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
    maxBranches = 5,
    waitAfterClick = 1000,
    viewportWidth = 390,
    viewportHeight = 844,
  } = input;

  const startDomain = validateStartUrl(startUrl);
  const kvStore = await Actor.openKeyValueStore();

  const crawler = new PlaywrightCrawler({
    maxConcurrency: 1,
    maxRequestRetries: 1,
    maxRequestsPerCrawl: 1000,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 120,
    headless: true,
    launchContext: {
      launchOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    },

    async requestHandler({ page, request, log }) {
      const { path = [], depth = 0 } = request.userData;

      await page.setViewportSize({ width: viewportWidth, height: viewportHeight });

      // Replay clicks to reach the current state
      if (path.length > 0) {
        const success = await replayClicks(page, startUrl, path, waitAfterClick, log);
        if (!success) {
          log.warning(`Skipping state — replay failed for path: ${path.map((s) => s.label).join(' > ')}`);
          return;
        }
      } else {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(1000);
        await dismissPopups(page);
      }

      // Screenshot current state
      let screenshotUrl;
      try {
        screenshotUrl = await takeScreenshot(page, kvStore, depth, path);
      } catch (err) {
        log.error(`Screenshot failed at depth ${depth}: ${err.message}`);
        screenshotUrl = null;
      }

      // Advance through nav buttons (Next/Continue) to reach the next
      // decision point. This handles two common quiz patterns:
      //   a) Page has ONLY nav buttons (no choices) — e.g. a "Get Started" splash
      //   b) A choice was just replayed and a "Next" button appeared alongside
      //      the still-visible choice buttons — click Next to advance past them
      let navLoopCount = 0;
      const maxNavLoops = 10;
      const seenNavUrls = new Set();
      let advancedViaNav = true;

      while (advancedViaNav && navLoopCount < maxNavLoops) {
        advancedViaNav = false;

        let buttons = await detectButtons(page, startDomain, maxBranches);
        const navButtons = buttons.filter((b) => isNavButton(b.label));

        if (navButtons.length === 0) break;

        const currentUrl = page.url();
        if (seenNavUrls.has(currentUrl) && navLoopCount > 0) {
          log.warning('Detected navigation cycle, stopping auto-click');
          break;
        }
        seenNavUrls.add(currentUrl);

        const nav = navButtons[0];
        log.info(`Auto-clicking nav button: "${nav.label}"`);

        try {
          const el = page.locator(nav.selector).nth(nav.index);
          await el.click({ timeout: 5000 });
          await Promise.race([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitAfterClick + 2000 }).catch(() => {}),
            page.waitForTimeout(waitAfterClick),
          ]);

          // Screenshot after nav click
          try {
            screenshotUrl = await takeScreenshot(page, kvStore, depth, [...path, { label: nav.label, index: nav.index }]);
          } catch (err) {
            log.error(`Nav screenshot failed: ${err.message}`);
          }

          advancedViaNav = true;
          navLoopCount++;
        } catch (err) {
          log.warning(`Nav button click failed: ${err.message}`);
          break;
        }
      }

      // Now detect the actual choice buttons at this decision point
      let buttons = await detectButtons(page, startDomain, maxBranches);
      let choiceButtons = buttons.filter((b) => !isNavButton(b.label));

      // Check end-of-funnel
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const maxDepthReached = depth >= maxDepth;
      const hasPricing = hasEndOfFunnelSignals(bodyText);
      const noMoreChoices = choiceButtons.length === 0;
      const isEndOfFunnel = maxDepthReached || (noMoreChoices && hasPricing) || (noMoreChoices && depth > 0);

      // Push record for this state
      await pushRecord(page, path, depth, screenshotUrl, isEndOfFunnel);

      // Enqueue child states for each choice button
      if (!isEndOfFunnel && depth < maxDepth) {
        for (const button of choiceButtons) {
          const childPath = [...path, { label: button.label, index: button.index, selector: button.selector }];
          const uniqueKey = fingerprintPath(childPath);

          await crawler.addRequests([{
            url: startUrl,
            uniqueKey,
            userData: {
              path: childPath,
              depth: depth + 1,
            },
          }]);
        }
      }

      if (isEndOfFunnel) {
        log.info(`End of funnel at depth ${depth}: ${path.map((s) => s.label).join(' > ') || '(start)'}`);
      }
    },

    async failedRequestHandler({ request, log }) {
      const { path = [] } = request.userData;
      log.error(`Request failed: ${path.map((s) => s.label).join(' > ') || '(start)'}`);
    },
  });

  // Seed the initial state
  await crawler.addRequests([{
    url: startUrl,
    uniqueKey: fingerprintPath([]),
    userData: { path: [], depth: 0 },
  }]);

  await crawler.run();
} catch (err) {
  await Actor.fail(`Actor failed: ${err.message}`);
}

await Actor.exit();
