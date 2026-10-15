/**
 * Builds each app in `examples/` with Vite, without severan and with it
 * (the package as built in `dist/`), client and SSR, and compares what
 * changed with the app's `snapshot.json`: shipped JS and CSS, what severan
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
const VARIANTS = ["original", "severan"] as const;
type Variant = (typeof VARIANTS)[number];

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
  const env = { SEVERAN: variant === "severan" ? "1" : "0" };
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
  return { js: shipped(client, ".js"), css: shipped(client, ".css"), html };
}

const percent = (before: number, after: number) =>
  `${(((before - after) / before) * 100).toFixed(1)}%`;

async function snapshot(dir: string) {
  const library = JSON.parse(
    readFileSync(path.join(dir, "library.json"), "utf8"),
  );
  const { version } = JSON.parse(
    readFileSync(
      path.join(EXAMPLES, "node_modules", library.name, "package.json"),
      "utf8",
    ),
  );
  // One at a time: severan writes the example's `node_modules/.severan`.
  const original = await build(dir, "original");
  const severan = await build(dir, "severan");

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
    failure: { feature: "severan", fallback: "nothing was rewritten" },
    options: { unwrap: true },
  });
  if ("warning" in result) throw new Error(result.warning);

  const sizes = (key: "js" | "css") => ({
    original: original[key],
    severan: severan[key],
    gzipSmallerBy: percent(original[key].gzip, severan[key].gzip),
  });
  const identical = original.html === severan.html;
  let at = 0;
  while (at < original.html.length && original.html[at] === severan.html[at]) {
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
    css: sizes("css"),
    html: {
      identical,
      bytes: original.html.length,
      sha1: createHash("sha1").update(original.html).digest("hex"),
      ...(!identical && {
        firstDifference: {
          original: original.html.slice(Math.max(0, at - 80), at + 80),
          severan: severan.html.slice(Math.max(0, at - 80), at + 80),
        },
      }),
    },
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
    existsSync(path.join(EXAMPLES, name, "library.json")) &&
    (!args.only || args.only.split(",").includes(name)),
);
// The examples build in parallel, each in its own directory.
const snapshots = await Promise.all(
  names.map((name) => snapshot(path.join(EXAMPLES, name))),
);
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
    `${name.padEnd(18)} JS ${current.js.gzipSmallerBy.padStart(6)}  CSS ${current.css.gzipSmallerBy.padStart(6)}  HTML ${current.html.identical ? "identical" : "DIFFERENT"}`,
  );
  if (!current.html.identical) {
    failed = true;
    console.error(
      `${name}: renders differently with severan\n  original: …${current.html.firstDifference?.original}…\n  severan:  …${current.html.firstDifference?.severan}…`,
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
