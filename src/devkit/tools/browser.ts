import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { truncateOutput } from '../utils.js';
import { registerToolFactory } from '../registry.js';
import type { Browser, Page } from 'puppeteer-core';

// ─── Local path resolution (standalone Smith, no Morpheus PATHS) ────────────
const SMITH_HOME = process.env.SMITH_HOME ?? path.join(os.homedir(), '.smith');
const BROWSER_CACHE = path.join(SMITH_HOME, 'cache', 'browser');

// ─── Module-level browser singleton ────────────────────────────────────────
let browserInstance: Browser | null = null;
let pageInstance: Page | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let installPromise: Promise<string> | null = null;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Ensures Chromium is downloaded to ~/.smith/cache/browser/.
 * Downloads only once; subsequent calls return the cached executablePath.
 */
async function ensureChromium(): Promise<string> {
  const {
    install,
    resolveBuildId,
    detectBrowserPlatform,
    computeExecutablePath,
    Browser: PBrowser,
  } = await import('@puppeteer/browsers');

  const platform = detectBrowserPlatform()!;
  const buildId = await resolveBuildId(PBrowser.CHROME, platform, 'stable');

  // Check if already installed
  const execPath = computeExecutablePath({
    browser: PBrowser.CHROME,
    buildId,
    cacheDir: BROWSER_CACHE,
  });

  const { default: fs } = await import('fs-extra');
  if (await fs.pathExists(execPath)) {
    return execPath;
  }

  // Download with progress indicator
  process.stdout.write('[Smith] Installing Chromium for browser tools (first run, ~150MB)...\n');
  const installed = await install({
    browser: PBrowser.CHROME,
    buildId,
    cacheDir: BROWSER_CACHE,
    downloadProgressCallback: (downloaded: number, total: number) => {
      const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
      process.stdout.write(`\r[Smith] Downloading Chromium: ${pct}%   `);
    },
  });
  process.stdout.write('\n[Smith] Chromium installed successfully.\n');
  return installed.executablePath;
}

/**
 * Returns (or creates) the browser singleton, resetting the idle timer.
 * Handles Chromium lazy-install with a lock to prevent concurrent downloads.
 */
async function acquireBrowser(): Promise<{ browser: Browser; page: Page }> {
  const { launch } = await import('puppeteer-core');

  const needsLaunch = !browserInstance || !browserInstance.connected;

  if (needsLaunch) {
    if (!installPromise) {
      installPromise = ensureChromium().finally(() => {
        installPromise = null;
      });
    }
    const executablePath = await installPromise;

    // Re-check after awaiting (another caller may have launched already)
    if (!browserInstance || !browserInstance.connected) {
      browserInstance = await launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      });
      pageInstance = await browserInstance.newPage();
    }
  } else if (!pageInstance || pageInstance.isClosed()) {
    pageInstance = await browserInstance!.newPage();
  }

  // Reset idle timeout
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    try { await pageInstance?.close(); } catch { /* ignore */ }
    try { await browserInstance?.close(); } catch { /* ignore */ }
    pageInstance = null;
    browserInstance = null;
    idleTimer = null;
  }, IDLE_TIMEOUT_MS);

  return { browser: browserInstance!, page: pageInstance! };
}

// Best-effort cleanup on process exit
process.on('exit', () => {
  try { (browserInstance as any)?.process()?.kill(); } catch { /* ignore */ }
});

// ─── Tool Definitions ───────────────────────────────────────────────────────

const browserNavigateTool = tool(
  async ({ url, wait_until, timeout_ms, return_html }) => {
    try {
      const { page } = await acquireBrowser();
      await page.goto(url, {
        waitUntil: (wait_until ?? 'domcontentloaded') as any,
        timeout: timeout_ms ?? 30_000,
      });
      const title = await page.title();
      const text: string = await page.evaluate(() => document.body.innerText);
      const result: Record<string, unknown> = {
        success: true,
        url,
        current_url: page.url(),
        title,
        text: truncateOutput(text),
      };
      if (return_html) {
        result.html = truncateOutput(await page.content());
      }
      return JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ success: false, url, error: err.message });
    }
  },
  {
    name: 'browser_navigate',
    description:
      'Navigate to a URL in a real browser (executes JavaScript). Use instead of http_request for SPAs, JS-heavy pages, or sites requiring interaction. Returns page title and text content.',
    schema: z.object({
      url: z.string().describe('Full URL to navigate to (must include https://)'),
      wait_until: z
        .enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
        .optional()
        .describe('Wait condition. Default: domcontentloaded. Use networkidle0 for SPAs.'),
      timeout_ms: z.number().optional().describe('Navigation timeout in ms. Default: 30000'),
      return_html: z
        .boolean()
        .optional()
        .describe('Also return raw HTML in response. Default: false'),
    }),
  }
);

const browserGetDomTool = tool(
  async ({ selector, include_attributes }) => {
    try {
      const { page } = await acquireBrowser();
      const includeAttrs = include_attributes ?? true;

      const dom = await page.evaluate(
        ({ sel, attrs }: { sel: string | null; attrs: boolean }) => {
          const root: Element | null = sel
            ? document.querySelector(sel)
            : document.body;
          if (!root) return null;

          const RELEVANT_ATTRS = [
            'href', 'src', 'type', 'name', 'value',
            'placeholder', 'action', 'id', 'role', 'aria-label',
          ];

          function serialize(el: Element, depth: number): object {
            const hasChildren = el.children.length > 0;
            const node: Record<string, unknown> = {
              tag: el.tagName.toLowerCase(),
            };
            if (el.id) node.id = el.id;
            if (el.className) node.class = el.className;
            if (!hasChildren) {
              const txt = el.textContent?.trim();
              if (txt) node.text = txt.slice(0, 120);
            }
            if (attrs && el.attributes.length > 0) {
              const attrMap: Record<string, string> = {};
              for (const attr of el.attributes) {
                if (RELEVANT_ATTRS.includes(attr.name)) {
                  attrMap[attr.name] = attr.value;
                }
              }
              if (Object.keys(attrMap).length) node.attrs = attrMap;
            }
            if (depth < 6 && hasChildren) {
              node.children = Array.from(el.children)
                .slice(0, 40)
                .map((c) => serialize(c, depth + 1));
            }
            return node;
          }

          return serialize(root, 0);
        },
        { sel: selector ?? null, attrs: includeAttrs }
      );

      if (!dom) {
        return JSON.stringify({ success: false, error: `Element not found: ${selector}` });
      }

      return JSON.stringify({ success: true, current_url: page.url(), dom: truncateOutput(JSON.stringify(dom, null, 2)) });
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err.message });
    }
  },
  {
    name: 'browser_get_dom',
    description:
      'Get a simplified DOM tree of the current page or a specific element. ' +
      'ALWAYS call this BEFORE browser_click or browser_fill to inspect page structure and identify the correct CSS selectors. ' +
      'Never guess selectors — analyze the DOM first.',
    schema: z.object({
      selector: z
        .string()
        .optional()
        .describe('CSS selector to scope the DOM tree to. Omit to get the full body.'),
      include_attributes: z
        .boolean()
        .optional()
        .describe(
          'Include relevant attributes (href, src, type, name, value, placeholder, role, aria-label). Default: true'
        ),
    }),
  }
);

const browserClickTool = tool(
  async ({ selector, text, timeout_ms, wait_after_ms }) => {
    try {
      const { page } = await acquireBrowser();

      if (!selector && !text) {
        return JSON.stringify({ success: false, error: 'Provide either selector or text' });
      }

      const clickTimeout = timeout_ms ?? 10_000;
      if (text) {
        await page.locator(`::-p-text(${text})`).setTimeout(clickTimeout).click();
      } else {
        await page.locator(selector!).setTimeout(clickTimeout).click();
      }

      if (wait_after_ms) {
        await new Promise((r) => setTimeout(r, wait_after_ms));
      }

      return JSON.stringify({
        success: true,
        current_url: page.url(),
        title: await page.title(),
      });
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err.message });
    }
  },
  {
    name: 'browser_click',
    description:
      'Click an element on the current browser page by CSS selector or visible text. ' +
      'The page must already be loaded via browser_navigate. ' +
      'Always inspect the DOM with browser_get_dom first to find the correct selector.',
    schema: z.object({
      selector: z
        .string()
        .optional()
        .describe('CSS selector of the element to click (e.g. "button#submit", ".btn-login")'),
      text: z
        .string()
        .optional()
        .describe('Click element containing this visible text (alternative to selector)'),
      timeout_ms: z
        .number()
        .optional()
        .describe('Timeout to wait for the element in ms. Default: 10000'),
      wait_after_ms: z
        .number()
        .optional()
        .describe('Wait this many ms after clicking (for page transitions/animations). Default: 0'),
    }),
  }
);

const browserFillTool = tool(
  async ({ selector, value, press_enter, timeout_ms }) => {
    try {
      const { page } = await acquireBrowser();
      await page.locator(selector).setTimeout(timeout_ms ?? 10_000).fill(value);
      if (press_enter) {
        await page.keyboard.press('Enter');
      }
      return JSON.stringify({ success: true, selector, filled: true });
    } catch (err: any) {
      return JSON.stringify({ success: false, selector, error: err.message });
    }
  },
  {
    name: 'browser_fill',
    description:
      'Fill a form input or textarea field with a value. Clears any existing content first. ' +
      'Always inspect the DOM with browser_get_dom first to identify the correct CSS selector.',
    schema: z.object({
      selector: z.string().describe('CSS selector of the input/textarea element'),
      value: z.string().describe('Value to type into the field'),
      press_enter: z
        .boolean()
        .optional()
        .describe('Press Enter after filling (triggers form submit in many cases). Default: false'),
      timeout_ms: z
        .number()
        .optional()
        .describe('Timeout to find the element in ms. Default: 10000'),
    }),
  }
);

/**
 * Search via DuckDuckGo Lite (plain HTML, no JS, no bot detection).
 */
const browserSearchTool = tool(
  async ({ query, num_results, language }) => {
    try {
      const max = Math.min(num_results ?? 10, 20);
      const year = new Date().getFullYear().toString();
      const lang = language ?? "pt";

      const qLower = query.toLowerCase();

      let intent: "news" | "official" | "documentation" | "price" | "general" = "general";

      if (/(hoje|último|resultado|placar|próximos|futebol|202\d)/.test(qLower)) intent = "news";
      if (/(site oficial|gov|receita federal|ministério)/.test(qLower)) intent = "official";
      if (/(api|sdk|npm|docs|documentação)/.test(qLower)) intent = "documentation";
      if (/(preço|valor|quanto custa)/.test(qLower)) intent = "price";

      let refinedQuery = query;

      if (intent === "news") {
        refinedQuery = `${query} ${year}`;
      }
      if (intent === "official") {
        refinedQuery = `${query} site:gov.br OR site:org`;
      }
      if (intent === "documentation") {
        refinedQuery = `${query} documentation OR docs OR github`;
      }
      if (intent === "price") {
        refinedQuery = `${query} preço ${year} Brasil`;
      }

      const regionMap: Record<string, string> = {
        pt: "br-pt",
        br: "br-pt",
        en: "us-en",
        us: "us-en",
      };

      const kl = regionMap[lang] ?? lang;
      const body = new URLSearchParams({ q: refinedQuery, kl }).toString();

      const res = await fetch("https://lite.duckduckgo.com/lite/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        body,
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        return JSON.stringify({ success: false, error: `HTTP ${res.status}` });
      }

      const html = await res.text();

      const linkPattern =
        /href="(https?:\/\/[^"]+)"[^>]*class='result-link'>([^<]+)<\/a>/g;

      const snippetPattern =
        /class='result-snippet'>([\s\S]*?)<\/td>/g;

      const links = [...html.matchAll(linkPattern)];
      const snippets = [...html.matchAll(snippetPattern)];

      if (!links.length) {
        return JSON.stringify({
          success: false,
          query: refinedQuery,
          error: "No results found",
        });
      }

      function normalizeUrl(url: string) {
        try {
          const u = new URL(url);
          u.search = "";
          return u.toString();
        } catch {
          return url;
        }
      }

      function getDomain(url: string) {
        try {
          return new URL(url).hostname.replace("www.", "");
        } catch {
          return "";
        }
      }

      const trustedDomains = [
        "gov.br", "bbc.com", "reuters.com", "globo.com",
        "uol.com", "cnn.com", "github.com", "npmjs.com", "com.br",
      ];

      function scoreResult(
        result: { title: string; url: string; snippet: string }
      ) {
        let score = 0;
        const domain = getDomain(result.url);
        if (trustedDomains.some((d) => domain.includes(d))) score += 5;
        if (intent === "official" && domain.includes("gov")) score += 5;
        if (intent === "documentation" && domain.includes("github")) score += 4;
        if (intent === "news" && /(globo|uol|cnn|bbc)/.test(domain)) score += 3;
        if (result.title.toLowerCase().includes(query.toLowerCase())) score += 2;
        if (result.snippet.length > 120) score += 1;
        if (/login|assine|subscribe|paywall/i.test(result.snippet)) score -= 3;
        return score;
      }

      const domainSeen = new Set<string>();
      const results: {
        title: string; url: string; snippet: string; domain: string; score: number;
      }[] = [];

      for (let i = 0; i < links.length; i++) {
        const rawUrl = links[i][1];
        if (rawUrl.startsWith("https://duckduckgo.com/")) continue;
        const url = normalizeUrl(rawUrl);
        const domain = getDomain(url);
        if (domainSeen.has(domain)) continue;
        domainSeen.add(domain);
        const title = links[i][2].trim();
        const snippet = snippets[i]
          ? snippets[i][1].replace(/<[^>]+>/g, "").trim()
          : "";
        const result = { title, url, snippet };
        const score = scoreResult(result);
        results.push({ ...result, domain, score });
      }

      if (!results.length) {
        return JSON.stringify({
          success: false,
          query: refinedQuery,
          error: "No valid results after filtering",
        });
      }

      results.sort((a, b) => b.score - a.score);
      const topResults = results.slice(0, max);
      const avgScore = topResults.reduce((acc, r) => acc + r.score, 0) / topResults.length;

      if (avgScore < 2 && intent !== "general") {
        return JSON.stringify({
          success: false,
          query: refinedQuery,
          warning: "Low confidence results. Consider refining query further.",
          results: topResults,
        });
      }

      return JSON.stringify({
        success: true,
        original_query: query,
        refined_query: refinedQuery,
        intent,
        results: topResults.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          score: r.score,
        })),
      });
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err.message });
    }
  },
  {
    name: "browser_search",
    description:
      "Enhanced internet search with query refinement, ranking, deduplication, and confidence scoring. Uses DuckDuckGo Lite.",
    schema: z.object({
      query: z.string(),
      num_results: z.number().int().min(1).max(20).optional(),
      language: z.string().optional(),
    }),
  }
);

// ─── Factory ────────────────────────────────────────────────────────────────

export function createBrowserTools(_ctx: ToolContext): StructuredTool[] {
  if (process.env.SMITH_BROWSER_ENABLED === 'false') {
    return [];
  }
  return [
    browserNavigateTool,
    browserGetDomTool,
    browserClickTool,
    browserFillTool,
    browserSearchTool,
  ];
}

registerToolFactory(createBrowserTools, 'browser');
