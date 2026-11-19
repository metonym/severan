/**
 * Builds each app in `examples/` with Vite, without svelte-prune and with it
 * (the package as built in `dist/`), client and SSR, and compares what
 * changed with the app's `snapshot.json`: shipped JS and CSS, what svelte-prune
 * rewrote, and the rendered HTML, which must be the same both ways.
 *
 *   bun run examples              # fail on any change from the snapshots
 *   bun run examples --update     # write the snapshots
 *   bun run examples --only flowbite-svelte
 *
 * Needs `bun run build` and `bun install` in `examples/`.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { filterCss } from "caligula";
import { requiredClasses, splitSelectorList } from "caligula/selector";
import { wrappedList } from "../src/styles";
import { type Browser, browserCheck, launchBrowser } from "./browser-check";

const { values: args } = parseArgs({
  options: {
    update: { type: "boolean" },
    only: { type: "string" },
    // Skip `bun run build`, when `dist/` is fresh.
    "no-build": { type: "boolean" },
  },
});

const ROOT = path.join(import.meta.dirname, "..");
const EXAMPLES = path.join(ROOT, "examples");
const VITE = path.join(EXAMPLES, "node_modules/vite/bin/vite.js");
type Variant = "original" | "pruned";

if (!existsSync(VITE)) {
  console.error("Install the examples first: cd examples && bun install");
  process.exit(2);
}
if (!args["no-build"]) {
  const built = spawnSync("bun", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const exec = promisify(execFile);

async function run(command: string, argv: string[], cwd: string, env = {}) {
  try {
    const { stdout } = await exec(command, argv, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const { stdout = "", stderr = "" } = error as {
      stdout?: string;
      stderr?: string;
    };
    throw new Error(
      `${command} ${argv.join(" ")} failed in ${cwd}:\n${stdout}${stderr}`,
      { cause: error },
    );
  }
}

type Size = { bytes: number; gzip: number };

/** Every file of a type a client build ships, summed. */
function shipped(dir: string, extension: string): Size {
  const size: Size = { bytes: 0, gzip: 0 };
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(extension)) continue;
    const code = readFileSync(path.join(dir, file));
    size.bytes += code.length;
    size.gzip += gzipSync(code).length;
  }
  return size;
}

/** SSR HTML, ids and randomness fixed, hydration markers out. */
const RENDER = `
let n = 0;
crypto.randomUUID = () => \`00000000-0000-4000-8000-\${String(n++).padStart(12, "0")}\`;
let seed = 1;
Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
Date.now = () => 1700000000000;
const { default: render } = await import(process.argv[1]);
process.stdout.write(render().replace(/<!(?:--[^>]*--)?>/g, ""));
`;

async function build(dir: string, variant: Variant) {
  const out = path.join(dir, ".out", variant);
  rmSync(out, { recursive: true, force: true });
  const env = { SVELTE_PRUNE: variant === "pruned" ? "1" : "0" };
  await run("node", [VITE, "build"], dir, {
    ...env,
    OUT: path.join(out, "client"),
  });
  await run("node", [VITE, "build", "--ssr", "src/entry-server.js"], dir, {
    ...env,
    OUT: path.join(out, "server"),
  });
  const server = readdirSync(path.join(out, "server")).find((file) =>
    file.startsWith("entry-server."),
  );
  if (!server) throw new Error(`no SSR entry in ${out}`);
  const html = await run(
    "node",
    ["--input-type=module", "-e", RENDER, path.join(out, "server", server)],
    dir,
  );
  const client = path.join(out, "client");
  return {
    js: shipped(client, ".js"),
    css: shipped(client, ".css"),
    cssText: readdirSync(client, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(path.join(client, file), "utf8"))
      .join("\n"),
    html,
  };
}

/** Each selector of `css`'s rules, lists split. */
function selectorsOf(css: string): string[] {
  const found: string[] = [];
  filterCss(css, {
    discardEmpty: false,
    rule: ({ parsed }) => {
      for (const { text } of parsed) found.push(text);
    },
  });
  return found;
}

const CLASS_ATTRIBUTE = /\sclass="([^"]*)"/g;
const WHITESPACE = /\s+/;

/**
 * Selectors of `original` that svelte-prune's CSS lost though every class they
 * require is on some element of `html`: each must be zero, since a class
 * that renders is never pruned.
 */
function lostSelectors(original: string, pruned: string, html: string) {
  const rendered = new Set(
    Array.from(html.matchAll(CLASS_ATTRIBUTE), ([, list]) =>
      list.split(WHITESPACE),
    ).flat(),
  );
  const kept = new Set(selectorsOf(pruned));
  // Some branch of a wrapping `:is()` list requires only rendered classes.
  const renders = (selector: string): boolean => {
    const list = wrappedList(selector);
    if (list !== undefined) return splitSelectorList(list).some(renders);
    const classes = requiredClasses(selector);
    return classes.length > 0 && classes.every((cls) => rendered.has(cls));
  };
  return selectorsOf(original).filter(
    (selector) => !kept.has(selector) && renders(selector),
  );
}

const percent = (before: number, after: number) =>
  `${(((before - after) / before) * 100).toFixed(1)}%`;

async function snapshot(dir: string, browser: Browser) {
  const { loadLibrary } = await import(path.join(EXAMPLES, "vite.shared.js"));
  const library = await loadLibrary(dir);
  const { version } = JSON.parse(
    readFileSync(
      path.join(EXAMPLES, "node_modules", library.name, "package.json"),
      "utf8",
    ),
  );
  // One at a time: svelte-prune writes the example's `node_modules/.svelte-prune`.
  const original = await build(dir, "original");
  const pruned = await build(dir, "pruned");
  const inBrowser = await browserCheck(browser, dir);

  // What the plugin rewrote, from the same analysis.
  const { specializeFiles } = await import(path.join(ROOT, "dist/index.js"));
  const src = path.join(dir, "src");
  const files = readdirSync(src)
    .filter((file) => file.endsWith(".svelte"))
    .map((file) => ({
      file: path.join(src, file),
      code: readFileSync(path.join(src, file), "utf8"),
    }));
  const result = await specializeFiles({
    library,
    projectRoot: dir,
    files,
    failure: { feature: "svelte-prune", fallback: "nothing was rewritten" },
    options: { unwrap: true },
  });
  if ("warning" in result) throw new Error(result.warning);

  const sizes = (key: "js" | "css") => ({
    original: original[key],
    pruned: pruned[key],
    gzipSmallerBy: percent(original[key].gzip, pruned[key].gzip),
  });
  const lost = lostSelectors(original.cssText, pruned.cssText, pruned.html);
  if (lost.length > 0) {
    console.error(
      `${path.basename(dir)}: svelte-prune's CSS lost selectors the page renders: ${lost.slice(0, 5).join(" | ")}`,
    );
  }
  const identical = original.html === pruned.html;
  let at = 0;
  while (at < original.html.length && original.html[at] === pruned.html[at]) {
    at++;
  }
  return {
    library: `${library.name}@${version}`,
    rewritten: {
      components: result.sources.size - result.apps - result.tables.modules,
      edits: result.edits,
      tables: {
        pruned: result.tables.pruned,
        emptied: result.tables.emptied,
        variantKeys: result.tables.keys,
        compoundVariants: result.tables.compounds,
      },
    },
    js: sizes("js"),
    css: { ...sizes("css"), renderedSelectorsLost: lost.length },
    html: {
      identical,
      bytes: original.html.length,
      sha1: createHash("sha1").update(original.html).digest("hex"),
      ...(!identical && {
        firstDifference: {
          original: original.html.slice(Math.max(0, at - 80), at + 80),
          pruned: pruned.html.slice(Math.max(0, at - 80), at + 80),
        },
      }),
    },
    browser: inBrowser,
  };
}

/** `a.b.c: old -> new` for each leaf that differs. */
function differences(before: unknown, after: unknown, at = ""): string[] {
  if (
    typeof before === "object" &&
    before !== null &&
    typeof after === "object" &&
    after !== null
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      differences(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        at ? `${at}.${key}` : key,
      ),
    );
  }
  return before === after
    ? []
    : [`${at}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
}

const names = readdirSync(EXAMPLES).filter(
  (name) =>
    (existsSync(path.join(EXAMPLES, name, "library.json")) ||
      existsSync(path.join(EXAMPLES, name, "library.js"))) &&
    (!args.only || args.only.split(",").includes(name)),
);
// The examples build in parallel, each in its own directory, and share
// one browser.
const browser = await launchBrowser();
const snapshots = await Promise.all(
  names.map((name) => snapshot(path.join(EXAMPLES, name), browser)),
).finally(() => browser.close());
let failed = false;
const rows: string[] = [];
for (const [i, name] of names.entries()) {
  const dir = path.join(EXAMPLES, name);
  const current = snapshots[i];
  const file = path.join(dir, "snapshot.json");
  const recorded = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : undefined;
  const changed = differences(recorded, current);
  rows.push(
    `${name.padEnd(18)} JS ${current.js.gzipSmallerBy.padStart(6)}  CSS ${current.css.gzipSmallerBy.padStart(6)}  HTML ${current.html.identical ? "identical" : "DIFFERENT"}  browser ${current.browser.identical ? `identical (${current.browser.steps} pages)` : "DIFFERENT"}`,
  );
  if (!current.browser.identical) {
    failed = true;
    const { step, original, pruned } = current.browser.firstDifference ?? {};
    console.error(
      `${name}: behaves differently with svelte-prune in the browser (${step})\n  original: …${original}…\n  pruned:   …${pruned}…`,
    );
  }
  if (current.css.renderedSelectorsLost > 0) failed = true;
  if (!current.html.identical) {
    failed = true;
    console.error(
      `${name}: renders differently with svelte-prune\n  original: …${current.html.firstDifference?.original}…\n  pruned:   …${current.html.firstDifference?.pruned}…`,
    );
  }
  if (args.update) {
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  } else if (changed.length > 0) {
    failed = true;
    console.error(
      `${name}: differs from snapshot.json\n${changed.map((line) => `  ${line}`).join("\n")}`,
    );
  }
}
console.log(rows.join("\n"));
if (failed && !args.update) {
  console.error(
    "\nIf the changes are expected, update the snapshots: bun run examples --update",
  );
}
process.exit(failed ? 1 : 0);
