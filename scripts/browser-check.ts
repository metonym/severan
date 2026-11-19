/**
 * Runs an example's two client builds in Chromium and compares them: the
 * errors each page throws or logs, and its DOM once it settles, after
 * loading and after clicking each button on a fresh page. SSR can't show
 * what only runs in the browser (actions, effects, handlers); this does.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");

/** At most this many buttons are clicked, each on a fresh page. */
const MAX_CLICKS = 40;

// Structural subset of Playwright: it's installed in `examples/` only.
type Page = {
  goto(url: string): Promise<unknown>;
  on(event: string, listener: (value: never) => void): void;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  close(): Promise<void>;
  locator(selector: string): {
    count(): Promise<number>;
    nth(index: number): { click(options: object): Promise<void> };
  };
  keyboard: { press(key: string): Promise<void> };
};
type Context = {
  newPage(): Promise<Page>;
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
};
export type Browser = {
  newContext(options: object): Promise<Context>;
  close(): Promise<void>;
};

export async function launchBrowser(): Promise<Browser> {
  const entry = path.join(EXAMPLES, "node_modules/playwright/index.mjs");
  if (!existsSync(entry)) {
    throw new Error("Install the examples first: cd examples && bun install");
  }
  const { chromium } = (await import(entry)) as {
    chromium: { launch(): Promise<Browser> };
  };
  return chromium.launch();
}

/** The same ids and randomness as the SSR render. */
const SEED = `
let n = 0;
crypto.randomUUID = () => \`00000000-0000-4000-8000-\${String(n++).padStart(12, "0")}\`;
let seed = 1;
Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
`;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function serve(dir: string) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      // Chromium asks for one whatever the page says.
      if (pathname === "/favicon.ico")
        return new Response(null, { status: 204 });
      const file = path.join(dir, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(dir) || !existsSync(file)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(readFileSync(file), {
        headers: {
          "content-type":
            CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        },
      });
    },
  });
}

/**
 * `<body>` as HTML with attributes sorted and comments and whitespace
 * collapsed: a rewrite may set an attribute statically that the original
 * set at runtime, which changes their order but not the element.
 */
function serializeBody(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
  for (const element of [clone, ...clone.querySelectorAll("*")]) {
    const attributes = [...element.attributes]
      .map(({ name, value }) => [name, value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name] of attributes) element.removeAttribute(name);
    for (const [name, value] of attributes) element.setAttribute(name, value);
  }
  return clone.outerHTML.replace(/\s+/g, " ").replace(/> </g, "><");
}

/**
 * Resolves once no finite animation runs (Svelte's transitions are Web
 * Animations, which change no DOM until they end) and the DOM stops
 * changing for a while, or after a limit. Runs in the page, so it's
 * self-contained.
 */
async function settle(): Promise<void> {
  const deadline = Date.now() + 4000;
  const running = () =>
    document
      .getAnimations()
      .filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity,
      );
  const quiet = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        clearTimeout(limit);
        observer.disconnect();
        resolve();
      };
      let timer = setTimeout(done, 150);
      const limit = setTimeout(done, 2000);
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, 150);
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
  for (;;) {
    await Promise.all(
      running().map((animation) => animation.finished.catch(() => {})),
    );
    await quiet();
    if (running().length === 0 || Date.now() > deadline) return;
  }
}

type Step = { name: string; dom: string; errors: string[] };

const BUTTONS = "button:visible:not([disabled])";

async function run(browser: Browser, dir: string): Promise<Step[]> {
  const server = serve(dir);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(SEED);
  const url = `http://localhost:${server.port}/`;
  const steps: Step[] = [];
  /** Loads the page, runs `act`, and records what it settles into. */
  const step = async (name: string, act?: (page: Page) => Promise<void>) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: { type(): string; text(): string }) => {
      // A failed request is recorded by URL below.
      if (
        message.type() === "error" &&
        !message.text().startsWith("Failed to load resource")
      ) {
        errors.push(message.text());
      }
    });
    page.on("response", (response: { status(): number; url(): string }) => {
      if (response.status() >= 400) {
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });
    await page.goto(url);
    await page.evaluate(settle, undefined);
    if (act) {
      await act(page);
      await page.evaluate(settle, undefined);
    }
    steps.push({
      name,
      dom: await page.evaluate(serializeBody, undefined),
      errors,
    });
    await page.close();
  };
  try {
    await step("load");
    const counter = await context.newPage();
    await counter.goto(url);
    await counter.evaluate(settle, undefined);
    const buttons = Math.min(
      await counter.locator(BUTTONS).count(),
      MAX_CLICKS,
    );
    await counter.close();
    for (let i = 0; i < buttons; i++) {
      await step(`click button ${i + 1}`, async (page) => {
        await page.locator(BUTTONS).nth(i).click({ timeout: 2000 });
      });
    }
  } finally {
    await context.close();
    server.stop(true);
  }
  return steps;
}

export type BrowserResult = {
  /** Pages compared: the load, then one per button clicked. */
  steps: number;
  identical: boolean;
  /** What differs, for the first step that does. */
  firstDifference?: { step: string; original: string; pruned: string };
};

/** Compares `<example>/.out/{original,pruned}/client` in `browser`. */
export async function browserCheck(
  browser: Browser,
  dir: string,
): Promise<BrowserResult> {
  const out = path.join(dir, ".out");
  const original = await run(browser, path.join(out, "original", "client"));
  const pruned = await run(browser, path.join(out, "pruned", "client"));
  if (original.length !== pruned.length) {
    return {
      steps: original.length,
      identical: false,
      firstDifference: {
        step: "count buttons",
        original: `${original.length - 1} buttons`,
        pruned: `${pruned.length - 1} buttons`,
      },
    };
  }
  for (const [i, before] of original.entries()) {
    const after = pruned[i];
    // How often a resource is requested is timing, not behavior.
    const errors = (step: Step) => [...new Set(step.errors)].sort().join(" | ");
    if (errors(before) !== errors(after)) {
      return {
        steps: original.length,
        identical: false,
        firstDifference: {
          step: `${before.name}: errors`,
          original: errors(before) || "none",
          pruned: errors(after) || "none",
        },
      };
    }
    if (before.dom !== after.dom) {
      let at = 0;
      while (at < before.dom.length && before.dom[at] === after.dom[at]) at++;
      return {
        steps: original.length,
        identical: false,
        firstDifference: {
          step: `${before.name}: DOM`,
          original: before.dom.slice(Math.max(0, at - 80), at + 80),
          pruned: after.dom.slice(Math.max(0, at - 80), at + 80),
        },
      };
    }
  }
  return { steps: original.length, identical: true };
}
