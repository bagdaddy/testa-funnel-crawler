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
const MAX_ELEMENTS = 40;

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

  // Strategy 3: Press Escape to dismiss modal dialogs
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  // Strategy 4: Force-remove known overlay containers that block interaction
  // (e.g. OneTrust, CookieBot, login modals, etc.)
  await page.evaluate(() => {
    const overlaySelectors = [
      '#onetrust-consent-sdk',
      '#onetrust-banner-sdk',
      '#CybotCookiebotDialog',
      '[class*="cookie-consent"]',
      '[class*="cookie-banner"]',
      '[id*="gdpr"]',
      '.cc-window',
      // Login/auth modals (common patterns)
      '[class*="modal"][class*="login"]',
      '[class*="modal"][class*="auth"]',
      '[class*="modal"][class*="register"]',
    ];
    for (const sel of overlaySelectors) {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }

    // Also remove any full-screen overlay divs that block pointer events
    // (common pattern: fixed/absolute positioned divs with high z-index)
    document.querySelectorAll('[class*="overlay"], [class*="backdrop"]').forEach((el) => {
      const style = window.getComputedStyle(el);
      if ((style.position === 'fixed' || style.position === 'absolute') &&
          parseInt(style.zIndex || '0') > 100) {
        el.remove();
      }
    });
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Page Snapshot Extraction (for LLM)
// ---------------------------------------------------------------------------

export async function extractPageSnapshot(page) {
  return page.evaluate(() => {
    const MAX = 40;

    function getVisibleText(el) {
      return (el.innerText || el.textContent || '').trim();
    }

    function buildSelector(el) {
      // Prefer stable attributes
      if (el.id) return `#${CSS.escape(el.id)}`;

      const dataTestId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (dataTestId) return `[data-testid="${CSS.escape(dataTestId)}"]`;

      // For <a> tags with meaningful href, use href attribute for precision
      if (el.tagName === 'A' && el.getAttribute('href')) {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('mailto:') && !href.startsWith('tel:') && href !== '#') {
          const selector = `a[href="${CSS.escape(href)}"]`;
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
      }

      // Build nth-of-type chain with uniqueness verification
      const parts = [];
      let current = el;
      while (current && current !== document.body && parts.length < 8) {
        const parent = current.parentElement;
        if (!parent) break;
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName.toLowerCase() === tag
        );
        const idx = siblings.indexOf(current) + 1;
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);

        // Check if current selector is already unique
        const candidate = parts.join(' > ');
        if (parts.length >= 3 && document.querySelectorAll(candidate).length === 1) {
          return candidate;
        }

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

    const bodyText = (document.body.innerText || '').slice(0, 800);

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

    function addCandidate(node) {
      if (seen.has(node)) return;
      seen.add(node);
      if (!isVisible(node)) return;
      // Skip aria-hidden elements (custom UI hides native inputs behind styled wrappers)
      if (node.getAttribute('aria-hidden') === 'true') return;

      const tag = node.tagName.toLowerCase();
      const text = getVisibleText(node);
      const href = node.getAttribute('href') || null;
      const type = node.getAttribute('type') || null;
      const name = node.getAttribute('name') || null;
      const placeholder = node.getAttribute('placeholder') || null;
      const required = node.hasAttribute('required');

      // Skip elements with no text and no useful attributes
      if (!text && !placeholder && !name && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
        return;
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

    // Pass 1: Standard interactive selectors
    for (const sel of interactiveSelectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        addCandidate(node);
      }
    }

    // Pass 2: Cursor-pointer elements (catches Framer, Webflow, custom React components)
    // Only scan above-fold to avoid pulling in hundreds of styled elements
    const allElements = document.body.querySelectorAll('*');
    for (const node of allElements) {
      if (seen.has(node)) continue;
      const style = window.getComputedStyle(node);
      if (style.cursor !== 'pointer') continue;
      if (!isVisible(node)) continue;
      if (!isAboveFold(node)) continue;
      const rect = node.getBoundingClientRect();
      // Skip very large containers (likely wrappers, not buttons)
      if (rect.height > 150 || rect.width > 350) continue;
      const text = getVisibleText(node);
      if (!text || text.length > 100) continue;
      // Skip if a parent with the same text is already captured
      let parentCaptured = false;
      let parent = node.parentElement;
      while (parent) {
        if (seen.has(parent)) { parentCaptured = true; break; }
        parent = parent.parentElement;
      }
      if (parentCaptured) continue;
      addCandidate(node);
    }

    // Sort by priority (above-fold text-bearing elements first), cap at MAX
    candidates.sort((a, b) => a._priority - b._priority);
    const elements = candidates.slice(0, MAX).map(({ _priority, ...el }) => el);

    // Form structures
    const forms = Array.from(document.querySelectorAll('form')).slice(0, 5).map((form) => {
      const formFields = Array.from(form.querySelectorAll('input, select, textarea'))
        .filter((field) => field.getAttribute('aria-hidden') !== 'true')
        .slice(0, 10)
        .map((field) => ({
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

    // Collect same-origin <a> tags as explicit link targets for the LLM
    const currentOrigin = window.location.origin;
    const seenHrefs = new Set();
    const links = [];
    const allLinks = document.querySelectorAll('a[href]');
    for (const a of allLinks) {
      if (links.length >= 15) break;
      try {
        const href = new URL(a.href, window.location.href).href;
        // Same-origin only, skip anchors/mailto/tel/javascript
        if (!href.startsWith(currentOrigin)) continue;
        if (href === window.location.href) continue;
        const pathname = new URL(href).pathname;
        if (pathname === '/' && window.location.pathname === '/') continue;
        if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
        if (seenHrefs.has(href)) continue;
        seenHrefs.add(href);
        const text = getVisibleText(a);
        if (!text || text.length > 100) continue;
        if (!isVisible(a)) continue;
        links.push({
          href,
          text: text.slice(0, 80),
          selector: buildSelector(a),
          aboveFold: isAboveFold(a),
        });
      } catch { /* invalid URL */ }
    }

    return { title, headings, bodyText, elements, forms, links };
  });
}

// ---------------------------------------------------------------------------
// Trigger Lazy Content & Animations
// ---------------------------------------------------------------------------

/**
 * Scroll through the page to trigger IntersectionObserver-based animations
 * and lazy-loaded content, then scroll back to top.
 * Call once before the first extractPageSnapshot() in the analysis loop.
 */
export async function triggerAnimations(page) {
  await page.evaluate(async () => {
    const scrollHeight = document.body.scrollHeight;
    const viewportHeight = window.innerHeight;
    const step = Math.floor(viewportHeight * 0.7);

    for (let y = 0; y < scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }

    // Scroll back to top
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Snapshot Diff (structural change detection)
// ---------------------------------------------------------------------------

/**
 * Compare two page snapshots structurally.
 * Returns { structureChanged, summary } where summary is human-readable.
 * Used after advance clicks to distinguish real page transitions from
 * dynamic content updates (lottery numbers, timers, ads).
 */
export function snapshotDiff(before, after) {
  const diffs = [];

  // Compare headings
  const headingsBefore = (before.headings || []).join('|');
  const headingsAfter = (after.headings || []).join('|');
  if (headingsBefore !== headingsAfter) {
    diffs.push('headings changed');
  }

  // Compare element labels (sorted for order-independence)
  const labelsBefore = (before.elements || []).map((e) => e.text).filter(Boolean).sort().join('|');
  const labelsAfter = (after.elements || []).map((e) => e.text).filter(Boolean).sort().join('|');
  if (labelsBefore !== labelsAfter) {
    const countBefore = (before.elements || []).length;
    const countAfter = (after.elements || []).length;
    if (countBefore !== countAfter) {
      diffs.push(`element count ${countBefore} → ${countAfter}`);
    } else {
      diffs.push('element labels changed');
    }
  }

  // Compare form field count
  const formFieldsBefore = (before.forms || []).reduce((n, f) => n + (f.fields || []).length, 0);
  const formFieldsAfter = (after.forms || []).reduce((n, f) => n + (f.fields || []).length, 0);
  if (formFieldsBefore !== formFieldsAfter) {
    diffs.push(`form fields ${formFieldsBefore} → ${formFieldsAfter}`);
  }

  // Compare links (if present)
  const linksBefore = (before.links || []).map((l) => l.href).sort().join('|');
  const linksAfter = (after.links || []).map((l) => l.href).sort().join('|');
  if (linksBefore !== linksAfter) {
    diffs.push('links changed');
  }

  const structureChanged = diffs.length > 0;
  const summary = structureChanged
    ? diffs.join(', ')
    : 'same page structure';

  return { structureChanged, summary };
}

// ---------------------------------------------------------------------------
// Content Hashing (change detection)
// ---------------------------------------------------------------------------

export async function hashPageContent(page) {
  const url = page.url();
  const text = await page.evaluate(() => (document.body.innerText || '').trim());
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

/**
 * Prepare page for a clean full-page screenshot.
 * Only injects CSS to freeze animations — does NOT scroll (scrolling
 * triggers IntersectionObservers that can advance quiz/funnel state).
 */
async function prepareForScreenshot(page) {
  // Force-finish all CSS animations/transitions so hidden content appears
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        animation-play-state: paused !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });

  // Force visibility on elements hidden by animation initial state
  await page.evaluate(() => {
    const els = document.querySelectorAll('[style*="opacity: 0"], [style*="opacity:0"]');
    for (const el of els) {
      el.style.opacity = '1';
    }
  });

  await page.waitForTimeout(200);
}

export async function takeScreenshot(page, kvStore, depth, actions, { seq = 0 } = {}) {
  await prepareForScreenshot(page);

  const seqStr = String(seq).padStart(3, '0');

  // Include sanitized URL path + query in the screenshot key
  let urlSlug = '';
  try {
    const parsed = new URL(page.url());
    const raw = (parsed.pathname + parsed.search).replace(/^\//, '');
    urlSlug = raw
      .replace(/[^a-zA-Z0-9_\-]/g, '_')  // sanitize for KV store key
      .replace(/_+/g, '_')                 // collapse multiple underscores
      .replace(/^_|_$/g, '')               // trim leading/trailing underscores
      .slice(0, 80);                       // cap length
    if (urlSlug) urlSlug = `_${urlSlug}`;
  } catch { /* ignore URL parse errors */ }

  const key = `${seqStr}_depth${depth}${urlSlug}`;

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
