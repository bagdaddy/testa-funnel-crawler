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
2. For forms, generate realistic but fake test data (e.g. "Jane Smith", "jane@test.com", "555-0123").
3. Navigation buttons include: "Get Started", "Next", "Continue", "Start", "Begin", "See Results", "Show Results", "Submit", "Proceed", "Take the Quiz", etc.
4. End-of-funnel signals: pricing ($, €, £), "add to cart", "buy now", "checkout", product recommendations with prices, subscription plans.
5. If you see both quiz choices AND a navigation button, classify as "quiz_choices" — the nav button will be handled after a choice is made.
6. Only include elements that are actually visible and interactive in your response. Use the exact CSS selectors provided in the snapshot.
7. For quiz choices, only include the actual answer options, not the question text or other UI elements.`;

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
          required: ['selector', 'value'],
          properties: {
            selector: { type: 'string', description: 'CSS selector for the form field' },
            value: { type: 'string', description: 'Value to fill in' },
            type: { type: 'string', description: 'Field type (text, email, select, checkbox, radio)' },
          },
        },
        description: 'Form fields to fill (only for form type)',
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
// Analyze Page
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

export async function analyzePage(snapshot, currentUrl, startUrl, depth, maxDepth) {
  if (!client) {
    throw new Error('LLM client not initialized. Call initLlmClient() first.');
  }

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
    return {
      pageType: result.pageType || 'other',
      reasoning: result.reasoning || '',
      isEndOfFunnel: result.isEndOfFunnel ?? false,
      quizChoices: result.quizChoices || [],
      formFields: result.formFields || [],
      navButtons: result.navButtons || [],
      submitSelector: result.submitSelector || null,
    };
  } catch (err) {
    return { ...EMPTY_RESULT, reasoning: `LLM error: ${err.message}` };
  }
}
