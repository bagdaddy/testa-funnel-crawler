# Apify Actor: Quiz Funnel Screenshot Crawler

## Overview
Build a Node.js Apify actor that crawls ecommerce quiz funnels by clicking through all interactive buttons/options, taking a full-page screenshot at each step, and outputting a complete visual map of every possible path through the funnel.

## Tech Stack
- Node.js (ES modules)
- Apify SDK (`apify`)
- Crawlee (`crawlee`) with `PlaywrightCrawler`
- Playwright (Chromium)

## Project Structure
```
/
├── src/
│   └── main.js
├── .actor/
│   ├── actor.json
│   └── input_schema.json
├── package.json
└── Dockerfile  (use apify/actor-node-playwright-chrome base image)
```

## Actor Input Schema
The actor accepts the following inputs (define in `.actor/input_schema.json`):

```json
{
  "startUrl": "string, required — the first page of the funnel",
  "maxDepth": "integer, default 20 — max number of click steps before stopping a path",
  "maxBranches": "integer, default 5 — max number of clickable options to follow per page (prevents explosion on pages with many buttons)",
  "waitAfterClick": "integer, default 1000 — ms to wait after each click before screenshotting",
  "viewportWidth": "integer, default 390 — default to mobile since most funnels are mobile-first",
  "viewportHeight": "integer, default 844"
}
```

## Core Algorithm

### State Model
Each crawl state is an object:
```js
{
  path: [{ label: string, index: number }],  // sequence of clicks taken to reach this state
  depth: number
}
```

The crawler maintains a **queue of states to visit**. It starts with one state (empty path = start URL). For each state, it:
1. Opens a fresh browser page
2. Replays all clicks in `state.path` from the start URL to recreate the exact state
3. Screenshots the current page
4. Detects all clickable options on the page
5. Filters out non-business buttons (see below)
6. For each clickable option, enqueues a new state with that click appended to the path
7. Stops branching when no more quiz options are found (end of funnel)

### Replaying Clicks
To reach a given state, always start fresh from `startUrl` and replay clicks in order:
- After each click, wait for navigation or DOM settle (`networkidle` or a fixed `waitAfterClick` ms)
- Use `element index` (nth match of selector) to re-find buttons reliably across page reloads

### Button / Option Detection
Detect clickable elements using these selectors (in priority order):
1. `button:visible`
2. `[role="button"]:visible`
3. `input[type="button"]:visible`, `input[type="submit"]:visible`
4. `a[href]:visible` — only if they navigate within the same domain
5. `label:visible` — for quiz options that use radio/checkbox inputs

For each candidate element, extract:
- `label`: `innerText` trimmed, fallback to `aria-label`, fallback to `value` attribute
- `index`: its position among all matches of that selector on the page (0-based)

### Non-Business Page Filtering
Filter OUT any button/link if:
- Its `label` matches any of these patterns (case-insensitive):
  `privacy policy`, `terms of service`, `terms of use`, `cookie policy`, `refund policy`,
  `contact us`, `about us`, `faq`, `sign up`, `log in`, `login`, `register`,
  `unsubscribe`, `accessibility`, `sitemap`, `careers`, `press`, `blog`
- Its `href` (if it's an `<a>` tag) contains: `privacy`, `terms`, `cookie`, `refund`,
  `contact`, `about`, `faq`, `login`, `signup`, `register`, `sitemap`
- It navigates to a **different domain** than `startUrl`

### Navigation Buttons (Next / Continue)
Some buttons advance the funnel without being a quiz "choice" (e.g. "Next", "Continue", "Get Started", "See Results"). These should be:
- **Clicked automatically** without creating branches — just advance the current path
- Detected by label matching: `next`, `continue`, `get started`, `proceed`, `see my results`,
  `show results`, `submit`, `start`, `begin`, `go`, `confirm`

### Loop / Duplicate Detection
Track a set of **visited state fingerprints**. A fingerprint is a hash of the ordered click labels in the path. If a new state's fingerprint already exists, skip it to avoid infinite loops.

### End of Funnel Detection
A page is considered the **end of the funnel** (stop branching) when:
- No clickable quiz options are found after filtering
- The page contains typical offer/result page signals:
  - A price element (`$`, `€`, `£`, `/month`, `/year`, `checkout`, `add to cart`, `buy now`)
  - Or depth has reached `maxDepth`

## Screenshots
- Take a **full-page screenshot** at every step (including intermediate navigation button clicks)
- Use `page.screenshot({ fullPage: true })`
- Save to Apify **Key-Value Store** with key: `screenshot_<timestamp>_depth<N>_step<M>`
- Store the resulting URL in the dataset output

## Output Dataset
Push one record per unique page state visited:

```json
{
  "screenshotUrl": "https://api.apify.com/v2/...",
  "path": [
    { "label": "Lose Weight", "index": 0 },
    { "label": "Female", "index": 1 }
  ],
  "pathString": "Lose Weight > Female",
  "depth": 2,
  "pageTitle": "What is your goal?",
  "url": "https://example.com/quiz",
  "isEndOfFunnel": false,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Error Handling
- If a click replay fails (element not found), log a warning and skip that state
- If a page fails to load after a click, retry once then skip
- Wrap the entire actor in try/catch and always call `Actor.exit()` cleanly
- Use `Actor.fail()` if the start URL itself fails to load

## Performance Notes
- Run browser contexts **sequentially** (not concurrently) to keep memory low on Apify's free tier
- Reuse a single browser instance across all states, opening/closing pages as needed
- Set a reasonable navigation timeout: 30 seconds

## Notes on Ecommerce Quiz Funnels
- Most are mobile-first, so use a mobile viewport (390x844) by default
- Quiz options are often styled `<div>` or `<label>` elements, not native `<button>` elements
- Some funnels use URL hash changes (`#step2`) instead of full navigations — handle both
- After clicking, wait for either: navigation event OR new DOM content appearing (whichever comes first)
- Some funnels have overlays/popups on load (cookie banners, email captures) — attempt to dismiss them by looking for common close selectors: `[aria-label="close"]`, `.close`, `#close`, `[class*="dismiss"]`, `[class*="close"]`