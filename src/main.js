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
import { initLlmClient, analyzePage } from './llm.js';

// ---------------------------------------------------------------------------
// Action Execution
// ---------------------------------------------------------------------------

async function executeAction(page, action, waitAfterClick) {
  try {
    if (action.type === 'click') {
      const el = page.locator(action.selector).first();
      await el.waitFor({ state: 'visible', timeout: 5000 });
      await el.click({ timeout: 5000 });
      await waitForSettle(page, waitAfterClick + 2000);
      return true;
    }

    if (action.type === 'fill_and_submit') {
      await fillForm(page, action.formFields || []);
      if (action.submitSelector) {
        const submitEl = page.locator(action.submitSelector).first();
        await submitEl.click({ timeout: 5000 });
        await waitForSettle(page, waitAfterClick + 2000);
      }
      return true;
    }

    return false;
  } catch (err) {
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
  } = input;

  const apiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing Anthropic API key. Provide anthropicApiKey in input or set ANTHROPIC_API_KEY env var.');
  }

  const startDomain = validateStartUrl(startUrl);
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

      // Navigate to start URL
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1000);
      await dismissPopups(page);

      // Replay all actions in path
      for (const action of actions) {
        const success = await executeAction(page, action, waitAfterClick);
        if (!success) {
          log.warning(`Replay failed at action "${action.label}" — skipping state`);
          return;
        }
      }

      // LLM analysis loop
      const MAX_ITERATIONS = 10;
      const seenHashes = new Set();
      let screenshotted = false;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        // Check for cycles
        const currentHash = await hashPageContent(page);
        if (seenHashes.has(currentHash)) {
          log.info('Detected content cycle, stopping analysis loop');
          break;
        }
        seenHashes.add(currentHash);

        // Extract snapshot and analyze with LLM
        const snapshot = await extractPageSnapshot(page);
        const analysis = await analyzePage(snapshot, page.url(), startUrl, depth, maxDepth);
        log.info(`LLM analysis [depth=${depth}, iter=${iteration}]: ${analysis.pageType} — ${analysis.reasoning}`);

        // --- end_of_funnel ---
        if (analysis.isEndOfFunnel || analysis.pageType === 'end_of_funnel') {
          let screenshotUrl = null;
          try {
            screenshotUrl = await takeScreenshot(page, kvStore, depth, actions);
          } catch (err) {
            log.error(`Screenshot failed: ${err.message}`);
          }
          await pushRecord(page, actions, depth, screenshotUrl, true, analysis.pageType, analysis.reasoning);
          screenshotted = true;
          return;
        }

        // --- form ---
        if (analysis.pageType === 'form') {
          const hashBefore = currentHash;

          const formAction = {
            type: 'fill_and_submit',
            formFields: analysis.formFields,
            submitSelector: analysis.submitSelector,
            label: 'Form submission',
          };
          const success = await executeAction(page, formAction, waitAfterClick);

          if (success) {
            const hashAfter = await hashPageContent(page);
            if (hashBefore !== hashAfter) {
              let screenshotUrl = null;
              try {
                screenshotUrl = await takeScreenshot(page, kvStore, depth, actions);
              } catch (err) {
                log.error(`Screenshot failed: ${err.message}`);
              }
              await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
              screenshotted = true;
              // Continue analyzing the new page state
              continue;
            }
          }
          log.warning('Form submission did not change page content');
          break;
        }

        // --- navigation ---
        if (analysis.pageType === 'navigation') {
          const navBtn = (analysis.navButtons || [])[0];
          if (!navBtn) {
            log.warning('Navigation type but no nav buttons found');
            break;
          }

          const hashBefore = currentHash;
          const navAction = { type: 'click', selector: navBtn.selector, label: navBtn.label };
          const success = await executeAction(page, navAction, waitAfterClick);

          if (success) {
            const hashAfter = await hashPageContent(page);
            if (hashBefore !== hashAfter) {
              let screenshotUrl = null;
              try {
                screenshotUrl = await takeScreenshot(page, kvStore, depth, actions);
              } catch (err) {
                log.error(`Screenshot failed: ${err.message}`);
              }
              await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
              screenshotted = true;
              // Continue analyzing the new page state
              continue;
            }
          }
          log.warning('Navigation click did not change page content');
          break;
        }

        // --- quiz_choices ---
        if (analysis.pageType === 'quiz_choices') {
          const choices = (analysis.quizChoices || []).slice(0, maxBranches);
          if (choices.length === 0) {
            log.warning('Quiz choices type but no choices found');
            break;
          }

          // Screenshot the question page
          let screenshotUrl = null;
          try {
            screenshotUrl = await takeScreenshot(page, kvStore, depth, actions);
          } catch (err) {
            log.error(`Screenshot failed: ${err.message}`);
          }
          await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
          screenshotted = true;

          // Enqueue child states for each choice
          if (depth < maxDepth) {
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
        // Not a funnel page — screenshot and stop
        let screenshotUrl = null;
        try {
          screenshotUrl = await takeScreenshot(page, kvStore, depth, actions);
        } catch (err) {
          log.error(`Screenshot failed: ${err.message}`);
        }
        await pushRecord(page, actions, depth, screenshotUrl, false, analysis.pageType, analysis.reasoning);
        screenshotted = true;
        return;
      }

      // Screenshot final state if not already captured
      if (!screenshotted) {
        let screenshotUrl = null;
        try {
          screenshotUrl = await takeScreenshot(page, kvStore, depth, actions);
        } catch (err) {
          log.error(`Screenshot failed: ${err.message}`);
        }
        await pushRecord(page, actions, depth, screenshotUrl, false, 'unknown', 'Loop exhausted without classification');
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
} catch (err) {
  await Actor.fail(`Actor failed: ${err.message}`);
}

await Actor.exit();
