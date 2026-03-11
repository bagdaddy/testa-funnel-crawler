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
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert at analyzing web pages that are part of ecommerce quiz funnels, lead generation forms, and product recommendation flows.

Given a page snapshot (title, headings, body text, interactive elements, forms), classify the page and decide what actions the crawler should take.

Page types:
- "quiz_choices": The page presents multiple options/choices for the user to pick from (e.g. "What's your skin type?" with options). The crawler should branch on each choice.
- "form": The page has form fields that need filling (email, name, phone, etc.) before proceeding. The crawler should fill the form with realistic test data and submit.
- "navigation": The page has a clear "continue" or "get started" button but no meaningful choices. The crawler should click it to advance.
- "end_of_funnel": The page shows results, pricing, product recommendations, checkout, or a final offer. The crawler should screenshot and stop.
- "other": The page doesn't fit any funnel pattern (e.g. a blog, about page, homepage with no funnel). The crawler should screenshot and stop.

Important rules:
1. Quiz choices are ONLY options that represent different user preferences/answers. Do NOT treat navigation links, footer links, header menus, or social media buttons as quiz choices.
2. For forms, be THOROUGH — include ALL interactions needed to submit successfully:
   - Fill fields with realistic fake test data using REALISTIC non-zero values:
     Height: "5" feet "8" inches, or "172" cm
     Current weight: "180" lbs or "82" kg (NEVER use 0)
     Desired/target weight: "150" lbs or "68" kg (must be LESS than current weight for weight-loss funnels)
     Age: "28"
     Email: "qa+1234@kilo.health", Name: "Jane Smith", Phone: "555-012-3456", Zip: "90210"
     For any numeric field, always use a realistic non-zero value appropriate for the context.
   - IMPORTANT: Include terms/conditions checkboxes, privacy policy agreements, consent toggles, and "I agree" buttons in formFields. These are often required before submit is enabled. Use type "click" for these — the crawler will click them. They may be buttons, divs, labels, or custom toggle elements, not just input checkboxes.
   - Include ALL required interactions in formFields in the correct order: fill inputs first, then click agreements/checkboxes, then the crawler will click submit.
3. Navigation buttons include: "Get Started", "Next", "Continue", "Start", "Begin", "See Results", "Show Results", "Submit", "Proceed", "Take the Quiz", etc.
4. End-of-funnel signals: pricing ($, €, £), "add to cart", "buy now", "checkout", product recommendations with prices, subscription plans.
5. If the page shows quiz choices that have NOT yet been selected and there is no "Continue"/"Next" button, classify as "quiz_choices". If a "Continue" or "Next" button is visible (suggesting a choice was already made), classify as "navigation" — the crawler will click Continue to advance.
6. Only include elements that are actually visible and interactive in your response. Use the exact CSS selectors provided in the snapshot.
7. For quiz choices, only include the actual answer options, not the question text or other UI elements.
8. MULTI-SELECT pages ("select all that apply", ingredient pickers, preference selectors with many options) are NOT branching choices — all selections lead to the same next page. Classify these as "navigation". For navButtons, return the buttons to click IN ORDER: first a "Select all"/"Select everything" checkbox/button if available, then the "Continue"/"Next" button. IMPORTANT: if there is NO select-all option, you MUST still include at least one selectable option/checkbox BEFORE the Continue button — many pages disable Continue until at least one option is selected. Pick the first available option.
9. Only classify as "quiz_choices" when each option leads to a DIFFERENT path through the funnel (e.g. "What's your gender?" Male/Female, "What's your goal?" Lose weight/Gain muscle). Typically these have 2-6 mutually exclusive options. Pages with 7+ selectable items are almost always multi-select preference pages, not branching choices.`;

// ---------------------------------------------------------------------------
// Tool Definition for Structured Output
// ---------------------------------------------------------------------------

const ANALYZE_TOOL = {
  name: 'analyze_page',
  description: 'Report the analysis of the current page state',
  input_schema: {
    type: 'object',
    required: ['pageType', 'reasoning', 'isEndOfFunnel'],
    properties: {
      pageType: {
        type: 'string',
        enum: ['quiz_choices', 'form', 'navigation', 'end_of_funnel', 'other'],
        description: 'Classification of the current page',
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of why this page type was chosen',
      },
      isEndOfFunnel: {
        type: 'boolean',
        description: 'Whether this is the final page in the funnel',
      },
      quizChoices: {
        type: 'array',
        items: {
          type: 'object',
          required: ['selector', 'label'],
          properties: {
            selector: { type: 'string', description: 'CSS selector for the choice element' },
            label: { type: 'string', description: 'Visible text of the choice' },
          },
        },
        description: 'Quiz choice options to branch on (only for quiz_choices type)',
      },
      formFields: {
        type: 'array',
        items: {
          type: 'object',
          required: ['selector', 'type'],
          properties: {
            selector: { type: 'string', description: 'CSS selector for the form field or clickable element' },
            value: { type: 'string', description: 'Value to fill in (required for text/email/select fields, omit for click/checkbox/radio)' },
            type: { type: 'string', description: 'Field type: "text", "email", "select", "checkbox", "radio", or "click". Use "click" for terms/consent/agreement buttons, toggles, and any non-input element that must be clicked before submit.' },
          },
        },
        description: 'ALL form interactions needed before submit, in order. Include text inputs, selects, AND clickable elements like terms/privacy checkboxes, consent toggles, agreement buttons.',
      },
      navButtons: {
        type: 'array',
        items: {
          type: 'object',
          required: ['selector', 'label'],
          properties: {
            selector: { type: 'string', description: 'CSS selector for the navigation button' },
            label: { type: 'string', description: 'Visible text of the button' },
          },
        },
        description: 'Navigation buttons to click (only for navigation type)',
      },
      submitSelector: {
        type: ['string', 'null'],
        description: 'CSS selector for the form submit button (only for form type)',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Analyze Page (with caching)
// ---------------------------------------------------------------------------

const EMPTY_RESULT = {
  pageType: 'other',
  reasoning: 'LLM call failed — fallback to other',
  isEndOfFunnel: false,
  quizChoices: [],
  formFields: [],
  navButtons: [],
  submitSelector: null,
};

// Cache LLM responses keyed by page headings + element labels
// (same question page = same analysis, regardless of URL hash)
const analysisCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function buildCacheKey(snapshot) {
  const headings = (snapshot.headings || []).join('|');
  const elementLabels = (snapshot.elements || [])
    .filter((e) => e.aboveFold && e.text)
    .map((e) => e.text)
    .sort()
    .join('|');
  return `${headings}::${elementLabels}`;
}

export function getCacheStats() {
  return {
    cacheHits,
    cacheMisses,
    cacheSize: analysisCache.size,
  };
}

// ---------------------------------------------------------------------------
// Screenshot Worthiness Check
// ---------------------------------------------------------------------------

const WORTHINESS_SYSTEM_PROMPT =
  'You decide whether a web page is useful funnel content worth screenshotting. ' +
  'Useful: quiz questions, form results, pricing, product recommendations, checkout, results pages, landing page offers. ' +
  'Not useful: terms & conditions, privacy policy, about us, blog posts, cookie policy, generic info pages, contact pages, careers, press, legal notices.';

const WORTHINESS_TOOL = {
  name: 'judge_screenshot',
  description: 'Decide if this page is worth screenshotting',
  input_schema: {
    type: 'object',
    required: ['worthy'],
    properties: {
      worthy: {
        type: 'boolean',
        description: 'true if the page contains useful funnel content worth capturing, false if it is junk',
      },
    },
  },
};

/**
 * Lightweight LLM check to decide if a page is worth screenshotting.
 * Fail-open: returns true on any error so we never lose screenshots due to API issues.
 */
export async function isWorthScreenshot(title, url, bodySnippet) {
  if (!client) return true; // no client → fail-open

  const userMessage = `Page title: ${title}\nURL: ${url}\nBody (first 500 chars): ${bodySnippet.slice(0, 500)}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: WORTHINESS_SYSTEM_PROMPT,
      tools: [WORTHINESS_TOOL],
      tool_choice: { type: 'tool', name: 'judge_screenshot' },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolBlock) return true; // fail-open
    return toolBlock.input.worthy !== false; // fail-open: default true unless explicitly false
  } catch (err) {
    console.warn(`Screenshot worthiness check failed (fail-open): ${err.message}`);
    return true; // fail-open on any error
  }
}

// ---------------------------------------------------------------------------
// Analyze Page (with caching)
// ---------------------------------------------------------------------------

export async function analyzePage(snapshot, currentUrl, startUrl, depth, maxDepth) {
  if (!client) {
    throw new Error('LLM client not initialized. Call initLlmClient() first.');
  }

  // 1. Try exact content cache (same headings + labels = same page)
  const cacheKey = buildCacheKey(snapshot);
  if (analysisCache.has(cacheKey)) {
    cacheHits++;
    const cached = analysisCache.get(cacheKey);
    return { ...cached, reasoning: `[cached] ${cached.reasoning}` };
  }
  cacheMisses++;

  // 2. Fall back to LLM call
  const userMessage = `Analyze this page and decide what the crawler should do.

Current URL: ${currentUrl}
Start URL: ${startUrl}
Current depth: ${depth} / ${maxDepth}

Page snapshot:
${JSON.stringify(snapshot, null, 2)}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [ANALYZE_TOOL],
      tool_choice: { type: 'tool', name: 'analyze_page' },
      messages: [{ role: 'user', content: userMessage }],
    });

    // Extract tool_use result
    const toolBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolBlock) {
      return { ...EMPTY_RESULT, reasoning: 'No tool_use block in LLM response' };
    }

    const result = toolBlock.input;
    const analysis = {
      pageType: result.pageType || 'other',
      reasoning: result.reasoning || '',
      isEndOfFunnel: result.isEndOfFunnel ?? false,
      quizChoices: result.quizChoices || [],
      formFields: result.formFields || [],
      navButtons: result.navButtons || [],
      submitSelector: result.submitSelector || null,
    };

    // Cache the exact result
    analysisCache.set(cacheKey, analysis);

    return analysis;
  } catch (err) {
    return { ...EMPTY_RESULT, reasoning: `LLM error: ${err.message}` };
  }
}
