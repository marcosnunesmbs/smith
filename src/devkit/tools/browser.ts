import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolContext } from '../types.js';
import { truncateOutput } from '../utils.js';
import { registerToolFactory } from '../registry.js';
import type { Browser, Page } from 'puppeteer-core';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

// ─── Local path resolution (standalone Smith, no Morpheus PATHS) ────────────
const SMITH_HOME = process.env.SMITH_HOME ?? path.join(os.homedir(), '.smith');
const BROWSER_CACHE = path.join(SMITH_HOME, 'cache', 'browser');

// ─── Module-level browser singleton ────────────────────────────────────────
let browserInstance: Browser | null = null;
let pageInstance: Page | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let installPromise: Promise<string> | null = null;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Common User Agents (rotated to avoid detection) ───────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Retry helper with exponential backoff ──────────────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

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
  async ({ url, wait_until, timeout_ms, return_html, wait_for_selector, extract_readable }) => {
    try {
      const { page } = await acquireBrowser();
      
      // Set a realistic user agent
      await page.setUserAgent(getRandomUserAgent());
      
      // Set extra headers to appear more like a real browser
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      });

      await withRetry(async () => {
        await page.goto(url, {
          waitUntil: (wait_until ?? 'domcontentloaded') as any,
          timeout: timeout_ms ?? 30_000,
        });
      }, 2);

      // Wait for specific selector if requested
      if (wait_for_selector) {
        await page.waitForSelector(wait_for_selector, { timeout: timeout_ms ?? 30_000 });
      }

      const title = await page.title();
      const htmlContent = await page.content();
      
      let text: string;
      let articleTitle: string | null = null;
      let articleByline: string | null = null;
      let articleExcerpt: string | null = null;
      
      // Use Readability for cleaner content extraction
      if (extract_readable !== false) {
        try {
          const dom = new JSDOM(htmlContent, { url });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();
          if (article) {
            articleTitle = article.title || null;
            articleByline = article.byline || null;
            articleExcerpt = article.excerpt || null;
            text = article.textContent || '';
          } else {
            text = await page.evaluate(() => document.body.innerText);
          }
        } catch {
          text = await page.evaluate(() => document.body.innerText);
        }
      } else {
        text = await page.evaluate(() => document.body.innerText);
      }

      const result: Record<string, unknown> = {
        success: true,
        url,
        current_url: page.url(),
        title: articleTitle || title,
        byline: articleByline,
        excerpt: articleExcerpt,
        text: truncateOutput(text),
      };
      
      if (return_html) {
        result.html = truncateOutput(htmlContent);
      }
      
      return JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ success: false, url, error: err.message });
    }
  },
  {
    name: 'browser_navigate',
    description:
      'Navigate to a URL in a real browser (executes JavaScript). Use for SPAs, JS-heavy pages, or sites requiring interaction. ' +
      'Automatically extracts clean readable content using Mozilla Readability. Returns page title, byline, excerpt, and text content.',
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
      wait_for_selector: z
        .string()
        .optional()
        .describe('CSS selector to wait for before extracting content (useful for dynamic content)'),
      extract_readable: z
        .boolean()
        .optional()
        .describe('Use Readability to extract clean article content. Default: true'),
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
 * Enhanced with better parsing, intent detection, and fallbacks.
 */
const browserSearchTool = tool(
  async ({ query, num_results, language, search_type }) => {
    try {
      const max = Math.min(num_results ?? 10, 20);
      const year = new Date().getFullYear().toString();
      const lang = language ?? "pt";
      const qLower = query.toLowerCase();

      // ─── Enhanced Intent Detection (multilingual) ───────────────────────
      type SearchIntent = "news" | "official" | "documentation" | "price" | "academic" | "how-to" | "general";
      let intent: SearchIntent = "general";

      // News patterns (PT/EN)
      if (/(hoje|ontem|último|resultado|placar|próximos|futebol|eleição|202\d|today|yesterday|latest|breaking|election)/i.test(qLower)) {
        intent = "news";
      }
      // Official/Government patterns
      else if (/(site oficial|gov\.|receita federal|ministério|official site|government)/i.test(qLower)) {
        intent = "official";
      }
      // Documentation patterns
      else if (/(api|sdk|npm|pypi|docs|documentação|documentation|reference|tutorial|example)/i.test(qLower)) {
        intent = "documentation";
      }
      // Price patterns
      else if (/(preço|valor|quanto custa|price|cost|pricing|buy)/i.test(qLower)) {
        intent = "price";
      }
      // Academic patterns
      else if (/(research|paper|study|journal|artigo|pesquisa|científico|scientific)/i.test(qLower)) {
        intent = "academic";
      }
      // How-to patterns
      else if (/(como|how to|tutorial|guia|guide|passo a passo|step by step)/i.test(qLower)) {
        intent = "how-to";
      }

      // ─── Smart Query Refinement ──────────────────────────────────────────
      let refinedQuery = query;
      const refinements: string[] = [];

      switch (intent) {
        case "news":
          refinements.push(year);
          break;
        case "official":
          // Don't modify - let user's query stand
          break;
        case "documentation":
          // Only add if not already present
          if (!/docs|documentation|github/i.test(qLower)) {
            refinements.push("documentation");
          }
          break;
        case "price":
          refinements.push(year);
          if (lang === "pt" || lang === "br") refinements.push("Brasil");
          break;
        case "academic":
          refinements.push("site:scholar.google.com OR site:arxiv.org OR site:researchgate.net");
          break;
        case "how-to":
          // Don't add noise, how-to queries are usually specific enough
          break;
      }

      if (refinements.length > 0) {
        refinedQuery = `${query} ${refinements.join(" ")}`;
      }

      // ─── Region Mapping ──────────────────────────────────────────────────
      const regionMap: Record<string, string> = {
        pt: "br-pt",
        br: "br-pt",
        en: "us-en",
        us: "us-en",
        uk: "uk-en",
        es: "es-es",
        fr: "fr-fr",
        de: "de-de",
      };
      const kl = regionMap[lang] ?? lang;

      // ─── Execute Search with Retry ───────────────────────────────────────
      const searchResult = await withRetry(async () => {
        const body = new URLSearchParams({ q: refinedQuery, kl }).toString();
        
        const res = await fetch("https://lite.duckduckgo.com/lite/", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": getRandomUserAgent(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": lang === "pt" ? "pt-BR,pt;q=0.9,en;q=0.8" : "en-US,en;q=0.9",
          },
          body,
          signal: AbortSignal.timeout(20000),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        return res.text();
      }, 3);

      const html = searchResult;

      // ─── Improved Parsing (handles both quote styles) ────────────────────
      // Match links with either single or double quotes
      const linkPattern = /href=["'](https?:\/\/[^"']+)["'][^>]*class=["']result-link["'][^>]*>([^<]+)<\/a>/gi;
      const snippetPattern = /class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;

      const links = [...html.matchAll(linkPattern)];
      const snippets = [...html.matchAll(snippetPattern)];

      if (!links.length) {
        // Try alternative pattern (DuckDuckGo sometimes changes format)
        const altLinkPattern = /<a[^>]+class=["']result-link["'][^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]+)<\/a>/gi;
        const altLinks = [...html.matchAll(altLinkPattern)];
        
        if (!altLinks.length) {
          return JSON.stringify({
            success: false,
            query: refinedQuery,
            error: "No results found. Try a different search term.",
            hint: intent !== "general" ? `Detected intent: ${intent}. Try a more specific query.` : undefined,
          });
        }
        links.push(...altLinks);
      }

      // ─── Helper Functions ────────────────────────────────────────────────
      function normalizeUrl(url: string): string {
        try {
          const u = new URL(url);
          // Remove tracking parameters
          ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'fbclid', 'gclid'].forEach(p => u.searchParams.delete(p));
          return u.toString();
        } catch {
          return url;
        }
      }

      function getDomain(url: string): string {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      }

      // ─── Enhanced Domain Scoring ─────────────────────────────────────────
      const domainScores: Record<string, number> = {
        // High authority
        "github.com": 8,
        "stackoverflow.com": 8,
        "wikipedia.org": 7,
        "docs.python.org": 8,
        "developer.mozilla.org": 8,
        "npmjs.com": 7,
        "pypi.org": 7,
        // News
        "bbc.com": 6,
        "reuters.com": 6,
        "cnn.com": 5,
        "globo.com": 5,
        "uol.com.br": 4,
        "g1.globo.com": 6,
        // Brazilian official
        "gov.br": 7,
        // Tech blogs
        "medium.com": 3,
        "dev.to": 4,
        "hashnode.dev": 3,
        // Academic
        "arxiv.org": 7,
        "scholar.google.com": 7,
        "researchgate.net": 6,
      };

      const penalizedPatterns = [
        /login|signin|signup/i,
        /assine|subscribe|paywall/i,
        /compre|buy now|add to cart/i,
        /pinterest\.com/i,
        /facebook\.com/i,
        /instagram\.com/i,
      ];

      function scoreResult(result: { title: string; url: string; snippet: string }): number {
        let score = 0;
        const domain = getDomain(result.url);

        // Domain-based scoring
        for (const [d, s] of Object.entries(domainScores)) {
          if (domain.includes(d) || domain.endsWith(d)) {
            score += s;
            break;
          }
        }

        // Intent-based bonuses
        if (intent === "documentation") {
          if (/github|docs|reference|api/i.test(domain)) score += 4;
          if (/example|tutorial|guide/i.test(result.title)) score += 2;
        }
        if (intent === "news") {
          if (/(globo|uol|cnn|bbc|reuters|g1)/i.test(domain)) score += 4;
          if (new RegExp(year).test(result.snippet)) score += 2;
        }
        if (intent === "official" && /gov\.|\.gov|official/i.test(domain)) {
          score += 5;
        }
        if (intent === "academic" && /arxiv|scholar|research/i.test(domain)) {
          score += 5;
        }
        if (intent === "how-to" && /tutorial|guide|how/i.test(result.title)) {
          score += 3;
        }

        // Title relevance
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const titleLower = result.title.toLowerCase();
        const matchedWords = queryWords.filter(w => titleLower.includes(w));
        score += Math.min(matchedWords.length * 1.5, 5);

        // Snippet quality
        if (result.snippet.length > 100) score += 1;
        if (result.snippet.length > 200) score += 1;

        // Penalties
        for (const pattern of penalizedPatterns) {
          if (pattern.test(result.url) || pattern.test(result.snippet)) {
            score -= 4;
          }
        }

        return Math.max(0, score);
      }

      // ─── Process Results ─────────────────────────────────────────────────
      const domainSeen = new Set<string>();
      const results: {
        title: string;
        url: string;
        snippet: string;
        domain: string;
        score: number;
      }[] = [];

      for (let i = 0; i < links.length; i++) {
        const rawUrl = links[i][1];
        if (rawUrl.includes("duckduckgo.com")) continue;

        const url = normalizeUrl(rawUrl);
        const domain = getDomain(url);

        // Skip if we already have this domain (dedupe)
        if (domainSeen.has(domain)) continue;
        domainSeen.add(domain);

        const title = links[i][2].trim().replace(/\s+/g, " ");
        const snippet = snippets[i]
          ? snippets[i][1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
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

      // Sort by score and take top results
      results.sort((a, b) => b.score - a.score);
      const topResults = results.slice(0, max);

      // Calculate confidence
      const avgScore = topResults.reduce((acc, r) => acc + r.score, 0) / topResults.length;
      const confidence = avgScore >= 6 ? "high" : avgScore >= 3 ? "medium" : "low";

      return JSON.stringify({
        success: true,
        original_query: query,
        refined_query: refinedQuery !== query ? refinedQuery : undefined,
        intent,
        confidence,
        result_count: topResults.length,
        results: topResults.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          domain: r.domain,
          score: r.score,
        })),
      });
    } catch (err: any) {
      return JSON.stringify({ 
        success: false, 
        error: err.message,
        hint: "Search failed. Try simplifying your query or check your internet connection."
      });
    }
  },
  {
    name: "browser_search",
    description:
      "Intelligent web search with automatic intent detection (news, documentation, how-to, academic, etc.), " +
      "smart query refinement, domain authority scoring, and confidence levels. Uses DuckDuckGo Lite for privacy. " +
      "Returns ranked results with relevance scores.",
    schema: z.object({
      query: z.string().describe("Search query. Be specific for better results."),
      num_results: z.number().int().min(1).max(20).optional().describe("Max results to return. Default: 10"),
      language: z.enum(["pt", "br", "en", "us", "uk", "es", "fr", "de"]).optional().describe("Search region/language. Default: pt"),
      search_type: z.enum(["web", "news"]).optional().describe("Type of search. Default: web (news not yet implemented)"),
    }),
  }
);

/**
 * Lightweight content fetcher - uses fetch + Readability instead of Puppeteer.
 * Much faster for static pages, articles, documentation, etc.
 */
const browserFetchContentTool = tool(
  async ({ url, timeout_ms, include_links }) => {
    try {
      const result = await withRetry(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout_ms ?? 30_000);
        
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': getRandomUserAgent(),
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
              'Accept-Encoding': 'gzip, deflate, br',
              'Cache-Control': 'no-cache',
            },
          });
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          
          const contentType = response.headers.get('content-type') || '';
          
          // Handle JSON responses directly
          if (contentType.includes('application/json')) {
            const json = await response.json();
            return {
              success: true,
              url,
              content_type: 'json',
              data: json,
            };
          }
          
          const html = await response.text();
          return { html, response };
        } finally {
          clearTimeout(timer);
        }
      }, 3);
      
      // If it was JSON, return early
      if ('content_type' in result && result.content_type === 'json') {
        return JSON.stringify(result);
      }
      
      const { html } = result as { html: string; response: Response };
      
      // Parse with JSDOM and extract with Readability
      const dom = new JSDOM(html, { url });
      const document = dom.window.document;
      
      // Extract metadata
      const title = document.querySelector('title')?.textContent?.trim() || '';
      const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || 
                          document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
      const author = document.querySelector('meta[name="author"]')?.getAttribute('content') || '';
      
      // Use Readability for main content
      const reader = new Readability(document.cloneNode(true) as Document);
      const article = reader.parse();
      
      // Extract links if requested
      let links: { text: string; href: string }[] = [];
      if (include_links) {
        const anchors = document.querySelectorAll('a[href]');
        const seen = new Set<string>();
        anchors.forEach((a) => {
          const href = a.getAttribute('href');
          const text = a.textContent?.trim();
          if (href && text && !seen.has(href) && href.startsWith('http')) {
            seen.add(href);
            links.push({ text: text.slice(0, 100), href });
          }
        });
        links = links.slice(0, 50); // Limit to 50 links
      }
      
      const output: Record<string, unknown> = {
        success: true,
        url,
        title: article?.title || title,
        description,
        author: article?.byline || author,
        excerpt: article?.excerpt || description,
        content: truncateOutput(article?.textContent || document.body?.textContent || ''),
        word_count: article?.textContent?.split(/\s+/).length || 0,
      };
      
      if (include_links && links.length > 0) {
        output.links = links;
      }
      
      return JSON.stringify(output);
    } catch (err: any) {
      return JSON.stringify({ 
        success: false, 
        url, 
        error: err.message,
        hint: 'If this is a JavaScript-heavy site, try browser_navigate instead.'
      });
    }
  },
  {
    name: 'browser_fetch_content',
    description:
      'Fast, lightweight content fetcher for static pages, articles, documentation, and APIs. ' +
      'Uses HTTP fetch + Readability (no browser needed). Much faster than browser_navigate. ' +
      'Use this for: documentation pages, blog posts, news articles, API endpoints. ' +
      'For JavaScript-heavy SPAs, use browser_navigate instead.',
    schema: z.object({
      url: z.string().describe('Full URL to fetch (must include https://)'),
      timeout_ms: z.number().optional().describe('Timeout in ms. Default: 30000'),
      include_links: z.boolean().optional().describe('Extract and return all links from the page. Default: false'),
    }),
  }
);

/**
 * Screenshot tool - useful for visual verification and debugging
 */
const browserScreenshotTool = tool(
  async ({ selector, full_page }) => {
    try {
      const { page } = await acquireBrowser();
      
      let screenshot: Buffer;
      if (selector) {
        const element = await page.$(selector);
        if (!element) {
          return JSON.stringify({ success: false, error: `Element not found: ${selector}` });
        }
        screenshot = await element.screenshot({ encoding: 'binary' }) as Buffer;
      } else {
        screenshot = await page.screenshot({ 
          fullPage: full_page ?? false,
          encoding: 'binary'
        }) as Buffer;
      }
      
      const base64 = screenshot.toString('base64');
      
      return JSON.stringify({
        success: true,
        current_url: page.url(),
        title: await page.title(),
        screenshot_base64: base64,
        size_bytes: screenshot.length,
      });
    } catch (err: any) {
      return JSON.stringify({ success: false, error: err.message });
    }
  },
  {
    name: 'browser_screenshot',
    description:
      'Take a screenshot of the current page or a specific element. ' +
      'Useful for visual verification and debugging. Returns base64-encoded PNG.',
    schema: z.object({
      selector: z.string().optional().describe('CSS selector of element to screenshot. Omit for full viewport.'),
      full_page: z.boolean().optional().describe('Capture full scrollable page. Default: false (viewport only)'),
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
    browserFetchContentTool,
    browserScreenshotTool,
  ];
}

registerToolFactory(createBrowserTools, 'browser');
