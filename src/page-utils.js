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
];

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024; // 10 MB
const INITIAL_JPEG_QUALITY = 85;
const MIN_JPEG_QUALITY = 30;
const QUALITY_STEP = 15;
const MAX_ELEMENTS = 30;

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
  for (const selector of POPUP_CLOSE_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      }
    } catch {
      // popup element not present or not clickable
    }
  }
}

// ---------------------------------------------------------------------------
// Page Snapshot Extraction (for LLM)
// ---------------------------------------------------------------------------

export async function extractPageSnapshot(page) {
  return page.evaluate(() => {
    const MAX = 30;

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

    // Page metadata
    const title = document.title || '';
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .map((h) => getVisibleText(h))
      .filter(Boolean)
      .slice(0, 10);

    const bodyText = (document.body.innerText || '').slice(0, 1500);

    // Interactive elements
    const interactiveSelectors = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'label',
      '[role="button"]',
      '[class*="btn"]',
      '[class*="option"]',
      '[class*="choice"]',
    ];

    const seen = new Set();
    const elements = [];

    for (const sel of interactiveSelectors) {
      if (elements.length >= MAX) break;
      const nodes = document.querySelectorAll(sel);

      for (const node of nodes) {
        if (elements.length >= MAX) break;
        if (seen.has(node)) continue;
        seen.add(node);

        // Skip invisible elements
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

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

        elements.push({
          tag,
          type,
          text: text.slice(0, 100),
          href,
          name,
          placeholder,
          required,
          selector: buildSelector(node),
          aboveFold: isAboveFold(node),
        });
      }
    }

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

export async function fillForm(page, fields) {
  for (const field of fields) {
    try {
      const el = page.locator(field.selector).first();
      const fieldType = (field.type || '').toLowerCase();

      if (fieldType === 'select' || field.tag === 'select') {
        await el.selectOption(field.value, { timeout: 3000 });
      } else if (fieldType === 'checkbox' || fieldType === 'radio') {
        await el.check({ timeout: 3000 });
      } else {
        await el.fill(field.value || '', { timeout: 3000 });
      }

      await page.waitForTimeout(200);
    } catch {
      // Some fields may be optional or already filled
    }
  }
}

// ---------------------------------------------------------------------------
// Wait for Page to Settle
// ---------------------------------------------------------------------------

export async function waitForSettle(page, timeoutMs = 3000) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {}),
    page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {}),
    page.waitForTimeout(timeoutMs),
  ]);
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export function fingerprintActions(actions) {
  const key = actions.map((a) => `${a.type}::${a.label}::${a.selector || ''}`).join('|');
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
