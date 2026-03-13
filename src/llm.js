import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Client Init
// ---------------------------------------------------------------------------

let client = null;

export function initLlmClient(apiKey) {
  client = new Anthropic({ apiKey });
  return client;
}

// ---------------------------------------------------------------------------
// Focused Prompts (selected per-page by heuristic)
// ---------------------------------------------------------------------------

const LANDING_PROMPT = `You analyze web pages to help a crawler screenshot every distinct page.

Your PRIMARY OBJECTIVE: identify all distinct navigable sections/products/categories on this page and return them as branch actions so the crawler can explore each one.

Action kinds:
1. "fill" — Form field (text, select, checkbox, consent). Use fillType "click" for toggles/consent.
2. "advance" — Single forward click (CTA, "Get Started", "Learn More"). Use when there is ONE clear forward path.
3. "branch" — Multiple DISTINCT destinations worth separate exploration.
   CRITICAL: For branch actions, strongly prefer selectors from the "links" section of the snapshot.
   These have resolved absolute hrefs that enable reliable direct navigation.
   If a link is not in the "links" section, you may still use its selector as a branch action.
   Maximum 6 branches.

What to branch on:
- Product category links ("Men", "Women", "Electronics", "Supplements")
- Product entry points ("Buy Product A", "Shop Now", "Take the Quiz")
- Distinct service/feature pages ("For Business", "For Personal")
- Top-level navigation categories on e-commerce sites
- "Register" / "Sign up" links (valuable to screenshot even if terminal)

What to IGNORE (never branch, never advance):
- Social media links, language selectors, login links (NOT register)
- FAQ, blog, terms, privacy, help/support, footer links
- Links to the same page (anchors, hashes)

RULES:
1. Use exact CSS selectors from the snapshot. NEVER use :contains(), :has-text(), or jQuery pseudo-selectors.
2. If nothing meaningful to click → isTerminal=true, empty actions.
3. Loading/spinner pages → pageType="loading", isTerminal=false, empty actions.
4. Pages with "Buy Now"/"Subscribe"/"Add to Cart" are NOT terminal — advance or branch.
5. Actual payment forms (credit card fields, Stripe embed) → isTerminal=true.
6. Registration/login pages where the MAIN content is the auth form → isTerminal=true.
   But if a login modal exists alongside product links, it is NOT terminal — use the product links.`;

const FUNNEL_PROMPT = `You analyze web pages in online funnels. Your PRIMARY OBJECTIVE is to move FORWARD through the funnel as fast as possible, screenshotting every distinct page state.

Action kinds (ordered by preference):
1. "fill" — Form field to fill. Text inputs, dropdowns, checkboxes, consent toggles.
   For consent/agreement elements, use fillType "click".
   NOTE: Consent checkboxes are often styled as BUTTONS (not native inputs).

2. "advance" — Click to move forward. THE DEFAULT. Use for:
   - Quiz answers: pick the FIRST reasonable option and click it
   - CTA buttons: Continue, Next, Get Started, Buy Now, Add to Cart, Subscribe
   - When a page needs BOTH selecting an option AND clicking Continue/Next, return BOTH as separate advance actions (option first, then button).

3. "branch" — Almost NEVER use in funnels. Only use if the page has genuinely different product paths (e.g., "Men's Plan" vs "Women's Plan" on a landing page within the funnel).

NEVER branch on:
- Quiz/survey answers (they lead to the same next question!)
- Preference selections, goal selectors, body type pickers
- Options that collect user data (age range, activity level)
- Pricing plan buttons (just pick one and advance)

Fill data:
- Height: "5" feet "8" inches or "172" cm
- Current weight: "180" lbs / "82" kg (NEVER 0)
- Target weight: "150" lbs / "68" kg
- Age: "28", Email: "qa+test@kilo.health", Name: "Jane Smith", Phone: "555-012-3456"
- For any numeric field, use a realistic non-zero value

RULES:
1. Fill actions come first, then advance.
2. Consent toggles / terms checkboxes → fill with fillType "click", BEFORE final advance.
3. Use exact CSS selectors from the snapshot. NEVER use :contains(), :has-text(), or jQuery pseudo-selectors.
4. Loading/spinner/progress pages ("calculating", "preparing", "analyzing", progress %) → pageType="loading", isTerminal=false, EMPTY actions. The crawler will wait.
5. On funnel pages (quiz, form, checkout, results): IGNORE header/footer nav entirely.
6. Terminal (isTerminal=true): order confirmation, thank-you, actual payment forms with card fields, dedicated registration/login pages.
   Do NOT fill or submit registration or login forms.
   Pages with "Buy Now"/"Subscribe"/"Add to Cart" are NOT terminal — advance.
7. If nothing meaningful to click and page shows final content → isTerminal=true, empty actions.`;

const CHECKOUT_PROMPT = `You analyze checkout and payment pages.

RULES:
1. If the page has credit card fields, Stripe/PayPal embed, or a payment form → isTerminal=true, empty actions.
2. If the page has a "Buy Now"/"Subscribe"/"Complete Purchase" button but NO payment fields yet → it is NOT terminal. Use advance to click the button.
3. Order confirmation / thank-you pages → isTerminal=true, empty actions.
4. Do NOT fill payment details (credit card, CVV, expiry).
5. Use exact CSS selectors from the snapshot. NEVER use :contains(), :has-text(), or jQuery pseudo-selectors.`;

// ---------------------------------------------------------------------------
// Prompt Selection Heuristic
// ---------------------------------------------------------------------------

/**
 * Select the most appropriate prompt based on page snapshot content.
 * No extra LLM call — pure heuristic.
 */
export function selectPrompt(snapshot) {
  const text = (snapshot.bodyText || '').toLowerCase();

  // Checkout detection: payment-related keywords
  if (/credit card|card number|cvv|cvc|stripe|paypal|payment method|billing address|expiry date|card details/i.test(text)) {
    return { prompt: CHECKOUT_PROMPT, promptName: 'checkout' };
  }

  // Funnel detection: forms with 2+ fields, or quiz/survey indicators
  const formFieldCount = (snapshot.forms || []).reduce((n, f) => n + (f.fields || []).length, 0);
  if (formFieldCount >= 2) {
    return { prompt: FUNNEL_PROMPT, promptName: 'funnel' };
  }

  // Quiz detection via element patterns (radio buttons, option chips)
  const elements = snapshot.elements || [];
  const radioCount = elements.filter((e) => e.type === 'radio').length;
  const optionLikeCount = elements.filter((e) =>
    e.tag === 'button' && e.text && e.text.length < 50 && !e.href
  ).length;
  if (radioCount >= 3 || (optionLikeCount >= 3 && optionLikeCount <= 8)) {
    return { prompt: FUNNEL_PROMPT, promptName: 'funnel' };
  }

  // Landing detection: 3+ links available
  const linkCount = (snapshot.links || []).length;
  if (linkCount >= 3) {
    return { prompt: LANDING_PROMPT, promptName: 'landing' };
  }

  // Default to funnel (safe: advance-first, fill forms)
  return { prompt: FUNNEL_PROMPT, promptName: 'funnel' };
}

// ---------------------------------------------------------------------------
// Tool Definition for Structured Output
// ---------------------------------------------------------------------------

const ANALYZE_TOOL = {
  name: 'analyze_page',
  description: 'Report the analysis of the current page state',
  input_schema: {
    type: 'object',
    required: ['pageType', 'actions', 'isTerminal', 'reasoning'],
    properties: {
      pageType: {
        type: 'string',
        enum: ['quiz', 'form', 'landing', 'product_listing', 'product', 'checkout', 'results', 'loading', 'other'],
        description: 'What type of page this is.',
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'selector', 'label'],
          properties: {
            kind: {
              type: 'string',
              enum: ['branch', 'advance', 'fill'],
              description: 'Action type: branch (enqueue each as separate path), advance (click to move forward), fill (fill form field)',
            },
            selector: {
              type: 'string',
              description: 'CSS selector for the element',
            },
            label: {
              type: 'string',
              description: 'Visible text or description of the element',
            },
            value: {
              type: 'string',
              description: 'Value to fill in (for fill actions with fillType text/email/select)',
            },
            fillType: {
              type: 'string',
              enum: ['text', 'email', 'select', 'checkbox', 'radio', 'click'],
              description: 'How to interact with the element (only for fill actions)',
            },
          },
        },
        description: 'Ordered list of actions for the crawler to execute',
      },
      isTerminal: {
        type: 'boolean',
        description: 'Whether this is a terminal page (payment form, confirmation, thank you). No more crawling needed.',
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of the page and chosen actions',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Analysis Cache
// ---------------------------------------------------------------------------

const EMPTY_RESULT = {
  pageType: 'other',
  actions: [],
  isTerminal: false,
  reasoning: 'LLM call failed',
};

const analysisCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function buildCacheKey(snapshot) {
  const headings = (snapshot.headings || []).join('|');
  const bodyPrefix = (snapshot.bodyText || '').slice(0, 300);
  const elementLabels = (snapshot.elements || [])
    .filter((e) => e.text)
    .map((e) => e.text)
    .sort()
    .join('|');
  return `${headings}::${bodyPrefix}::${elementLabels}`;
}

export function getCacheStats() {
  return {
    cacheHits,
    cacheMisses,
    cacheSize: analysisCache.size,
  };
}

// ---------------------------------------------------------------------------
// Analyze Page
// ---------------------------------------------------------------------------

export async function analyzePage(snapshot, currentUrl, depth, maxDepth, { skipCache = false, actionContext = '' } = {}) {
  if (!client) {
    throw new Error('LLM client not initialized. Call initLlmClient() first.');
  }

  // 1. Try exact content cache
  const cacheKey = buildCacheKey(snapshot);
  if (!skipCache && analysisCache.has(cacheKey)) {
    cacheHits++;
    const cached = analysisCache.get(cacheKey);
    return { ...cached, reasoning: `[cached] ${cached.reasoning}` };
  }
  cacheMisses++;

  // 2. Select prompt based on page content
  const { prompt: systemPrompt, promptName } = selectPrompt(snapshot);

  const contextPrefix = actionContext
    ? `IMPORTANT CONTEXT: ${actionContext}\n\n`
    : '';
  const userMessage = `${contextPrefix}Analyze this page and decide what the crawler should do.

Current URL: ${currentUrl}
Current depth: ${depth} / ${maxDepth}

Page snapshot:
${JSON.stringify(snapshot)}`;

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        tools: [ANALYZE_TOOL],
        tool_choice: { type: 'tool', name: 'analyze_page' },
        messages: [{ role: 'user', content: userMessage }],
      });

      const toolBlock = response.content.find((block) => block.type === 'tool_use');
      if (!toolBlock) {
        return { ...EMPTY_RESULT, reasoning: 'No tool_use block in LLM response' };
      }

      const result = toolBlock.input;
      const analysis = {
        pageType: result.pageType || 'other',
        actions: result.actions || [],
        isTerminal: result.isTerminal ?? false,
        reasoning: `[${promptName}] ${result.reasoning || ''}`,
      };

      if (!skipCache) {
        analysisCache.set(cacheKey, analysis);
      }

      return analysis;
    } catch (err) {
      const status = err?.status || err?.error?.status;
      if ((status === 429 || status === 529) && attempt < MAX_RETRIES) {
        const delay = Math.min(60_000, Math.pow(2, attempt + 2) * 1000);
        console.log(`Rate limited (${status}), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return { ...EMPTY_RESULT, reasoning: `LLM error: ${err.message}` };
    }
  }

  // Safety net: all retries exhausted without return
  return { ...EMPTY_RESULT, reasoning: 'All retries exhausted' };
}
