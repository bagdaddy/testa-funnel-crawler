import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  '[class*="consent"] button',
  '[id*="cookie"] button',
  '[id*="consent"] button',
  'button[id*="accept"]',
  'button[id*="reject"]',
  '[class*="modal"] [class*="close"]',
  '[class*="overlay"] [class*="close"]',
  '[class*="privacy"] button',
];

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024; // 10 MB
const INITIAL_JPEG_QUALITY = 85;
const MIN_JPEG_QUALITY = 30;
const QUALITY_STEP = 15;
const MAX_ELEMENTS = 60;

// ---------------------------------------------------------------------------
// URL Validation
// ---------------------------------------------------------------------------

export function validateStartUrl(startUrl) {
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

export async function dismissPopups(page) {
  // Strategy 1: Click visible accept/reject/close buttons by text
  const acceptLabels = ['Accept All', 'Accept all', 'Accept Cookies', 'Accept cookies', 'Accept', 'Allow All', 'Allow all', 'I Accept', 'OK', 'Got it', 'Agree', 'Reject All', 'Reject all', 'Reject'];
  for (const label of acceptLabels) {
    try {
      const btn = page.getByRole('button', { name: label, exact: true }).first();
      if (await btn.isVisible({ timeout: 300 })) {
        await btn.click({ timeout: 1000 });
        await page.waitForTimeout(500);
        break;
      }
    } catch {
      // not found
    }
  }

  // Strategy 2: Click common close button selectors
  for (const selector of POPUP_CLOSE_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      }
    } catch {
      // popup element not present or not clickable
    }
  }

  // Strategy 3: Force-remove known overlay containers that block interaction
  // (e.g. OneTrust, CookieBot, etc. that persist even after accepting)
  await page.evaluate(() => {
    const overlaySelectors = [
      '#onetrust-consent-sdk',
      '#onetrust-banner-sdk',
      '#CybotCookiebotDialog',
      '[class*="cookie-consent"]',
      '[class*="cookie-banner"]',
      '[id*="gdpr"]',
      '.cc-window',
    ];
    for (const sel of overlaySelectors) {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Page Snapshot Extraction (for LLM)
// ---------------------------------------------------------------------------

export async function extractPageSnapshot(page) {
  return page.evaluate(() => {
    const MAX = 60;

    function getVisibleText(el) {
      return (el.innerText || el.textContent || '').trim();
    }

    function buildSelector(el) {
      // Prefer stable attributes
      if (el.id) return `#${CSS.escape(el.id)}`;

      const dataTestId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (dataTestId) return `[data-testid="${CSS.escape(dataTestId)}"]`;

      // Build nth-of-type chain
      const parts = [];
      let current = el;
      while (current && current !== document.body && parts.length < 4) {
        const parent = current.parentElement;
        if (!parent) break;
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName.toLowerCase() === tag
        );
        const idx = siblings.indexOf(current) + 1;
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
        current = parent;
      }
      return parts.join(' > ');
    }

    function isAboveFold(el) {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight;
    }

    function isVisible(node) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    }

    // Page metadata
    const title = document.title || '';
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .map((h) => getVisibleText(h))
      .filter(Boolean)
      .slice(0, 10);

    const bodyText = (document.body.innerText || '').slice(0, 1500);

    // Collect ALL candidate interactive elements, then prioritize
    const interactiveSelectors = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'label',
      '[role="button"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="option"]',
      '[class*="btn"]',
      '[class*="option"]',
      '[class*="choice"]',
      '[class*="chip"]',
      '[class*="pill"]',
      '[class*="tag"]',
      '[class*="toggle"]',
      '[onclick]',
    ];

    const seen = new Set();
    const candidates = [];

    for (const sel of interactiveSelectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (!isVisible(node)) continue;

        const tag = node.tagName.toLowerCase();
        const text = getVisibleText(node);
        const href = node.getAttribute('href') || null;
        const type = node.getAttribute('type') || null;
        const name = node.getAttribute('name') || null;
        const placeholder = node.getAttribute('placeholder') || null;
        const required = node.hasAttribute('required');

        // Skip elements with no text and no useful attributes
        if (!text && !placeholder && !name && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
          continue;
        }

        const aboveFold = isAboveFold(node);
        candidates.push({
          tag,
          type,
          text: text.slice(0, 100),
          href,
          name,
          placeholder,
          required,
          selector: buildSelector(node),
          aboveFold,
          // Sort priority: above-fold with text first
          _priority: (aboveFold ? 0 : 1000) + (text ? 0 : 500),
        });
      }
    }

    // Sort by priority (above-fold text-bearing elements first), cap at MAX
    candidates.sort((a, b) => a._priority - b._priority);
    const elements = candidates.slice(0, MAX).map(({ _priority, ...el }) => el);

    // Form structures
    const forms = Array.from(document.querySelectorAll('form')).slice(0, 5).map((form) => {
      const formFields = Array.from(form.querySelectorAll('input, select, textarea')).slice(0, 10).map((field) => ({
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute('type') || null,
        name: field.getAttribute('name') || null,
        placeholder: field.getAttribute('placeholder') || null,
        required: field.hasAttribute('required'),
        selector: buildSelector(field),
      }));
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      return {
        selector: buildSelector(form),
        fields: formFields,
        submitSelector: submitBtn ? buildSelector(submitBtn) : null,
      };
    });

    return { title, headings, bodyText, elements, forms };
  });
}

// ---------------------------------------------------------------------------
// Content Hashing (change detection)
// ---------------------------------------------------------------------------

export async function hashPageContent(page) {
  const url = page.url();
  const text = await page.evaluate(() => document.body.innerText || '');
  const raw = `${url}||${text}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Form Filling
// ---------------------------------------------------------------------------

export async function fillForm(page, fields, log) {
  for (const field of fields) {
    const fieldType = (field.type || '').toLowerCase();
    const label = field.value ? `${fieldType}="${field.value}"` : fieldType;
    try {
      const el = page.locator(field.selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);

      if (!visible) {
        if (log) log.warning(`Form field not visible: [${label}] selector="${field.selector}"`);
        continue;
      }

      if (fieldType === 'click') {
        if (log) log.info(`Form: clicking element selector="${field.selector}"`);
        await el.click({ timeout: 3000 });
      } else if (fieldType === 'select' || field.tag === 'select') {
        if (log) log.info(`Form: selecting "${field.value}" in selector="${field.selector}"`);
        await el.selectOption(field.value, { timeout: 3000 });
      } else if (fieldType === 'checkbox' || fieldType === 'radio') {
        if (log) log.info(`Form: checking ${fieldType} selector="${field.selector}"`);
        await el.check({ timeout: 3000 });
      } else {
        if (log) log.info(`Form: filling "${field.value}" in selector="${field.selector}"`);
        await el.fill(field.value || '', { timeout: 3000 });
      }

      await page.waitForTimeout(200);
    } catch (err) {
      if (log) log.warning(`Form field FAILED [${label}] selector="${field.selector}": ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Wait for Page to Settle
// ---------------------------------------------------------------------------

export async function waitForSettle(page, timeoutMs = 3000) {
  // Wait for network to go idle (critical for SPAs that fetch data after navigation)
  await page.waitForLoadState('networkidle', { timeout: timeoutMs + 5000 }).catch(() => {});

  // Also wait for any visible button/input/link to appear (content rendered)
  await page.waitForSelector('button:visible, a:visible, input:visible, [role="button"]:visible', {
    timeout: timeoutMs,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export function fingerprintActions(actions) {
  const key = actions.map((a) => `${a.type}::${a.label}`).join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export async function takeScreenshot(page, kvStore, depth, actions) {
  const timestamp = Date.now();
  const pathHash = fingerprintActions(actions);
  const key = `screenshot_depth${depth}_${pathHash}_${timestamp}`;

  let quality = INITIAL_JPEG_QUALITY;
  let buffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality });

  while (buffer.length > MAX_SCREENSHOT_BYTES && quality > MIN_JPEG_QUALITY) {
    quality -= QUALITY_STEP;
    buffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality });
  }

  await kvStore.setValue(key, buffer, { contentType: 'image/jpeg' });

  const storeId = kvStore.id || process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID || 'default';
  return `https://api.apify.com/v2/key-value-stores/${storeId}/records/${key}`;
}
