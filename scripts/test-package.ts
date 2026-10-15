// Packs dist/, installs the tarball into a scratch project, and checks it
// the way a consumer would: a library specialized in Node, both plugins
// loading, and the types resolving through `exports` with nothing but what
// a Vite project has installed.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const dir = await mkdtemp(join(tmpdir(), "severan-package-"));

try {
  await $`bun run build`.cwd(root).quiet();

  const manifest = JSON.parse(
    await readFile(join(root, "dist/package.json"), "utf8"),
  );
  for (const field of ["dependencies", "peerDependencies"]) {
    if (manifest[field]) throw new Error(`dist/package.json has ${field}`);
  }

  // The plugins load the parser only when a build starts: nothing their
  // entries import statically may hold it.
  const RELATIVE_IMPORT = /\bfrom\s*"(\.\/[^"]+)"/g;
  for (const entry of ["vite.js", "webpack.js"]) {
    const seen = new Set<string>();
    const pending = [entry];
    for (let file = pending.pop(); file; file = pending.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      // biome-ignore lint/performance/noAwaitInLoops: a few small files, read in turn
      const code = await readFile(join(root, "dist", file), "utf8");
      if (code.includes("svelte:boundary")) {
        throw new Error(`dist/${entry} loads the parser (through ${file})`);
      }
      for (const [, next] of code.matchAll(RELATIVE_IMPORT)) {
        pending.push(next.slice(2));
      }
    }
  }

  const packed = await $`npm pack --pack-destination ${dir} --silent`
    .cwd(join(root, "dist"))
    .text();
  const tarball = join(dir, packed.trim());

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  await $`npm install ${tarball} vite @types/node --no-audit --no-fund --silent`.cwd(
    dir,
  );

  // A library whose Button branches on `kind`, and an app that only ever
  // passes "ghost".
  const lib = join(dir, "node_modules/mylib");
  await mkdir(join(lib, "src"), { recursive: true });
  await writeFile(
    join(lib, "package.json"),
    JSON.stringify({
      name: "mylib",
      version: "1.0.0",
      svelte: "./src/index.js",
    }),
  );
  await writeFile(
    join(lib, "src/index.js"),
    `export { default as Button } from "./Button.svelte";`,
  );
  await writeFile(
    join(lib, "src/Button.svelte"),
    `<script>export let kind = "primary";</script>
{#if kind === "ghost"}<button class="ghost"><slot /></button>{:else}<button><slot /></button>{/if}`,
  );
  await mkdir(join(dir, "src"));
  await writeFile(
    join(dir, "src/App.svelte"),
    `<script>import { Button } from "mylib";</script>
<Button kind="ghost">Go</Button>`,
  );

  await writeFile(
    join(dir, "smoke.js"),
    `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { specializeFiles } from "severan";
import { severan } from "severan/vite";
import { SeveranPlugin } from "severan/webpack";

const library = {
  name: "mylib",
  srcDir: "src",
  barrel: "index.js",
  componentPackages: [],
  contextKeyPrefix: "mylib:",
  label: "mylib",
  tool: "severan",
};
const file = new URL("./src/App.svelte", import.meta.url).pathname;
const result = await specializeFiles({
  library,
  projectRoot: process.cwd(),
  files: [{ file, code: readFileSync(file, "utf8") }],
  failure: { feature: "severan", fallback: "unchanged" },
});
assert.ok(!("warning" in result), result.warning);
const [button] = result.sources.values();
assert.ok(button.code.includes('class="ghost"'));
assert.ok(!button.code.includes("{:else}"));
assert.equal(button.map.version, 3);

assert.equal(severan(library).name, "severan");
assert.equal(typeof new SeveranPlugin(library).apply, "function");
`,
  );
  await $`node smoke.js`.cwd(dir);

  await writeFile(
    join(dir, "consumer.ts"),
    `import { type LibrarySpec, type SeveranOptions, specializeFiles } from "severan";
import { severan } from "severan/vite";
import { SeveranPlugin } from "severan/webpack";
import type { Plugin } from "vite";

const library: LibrarySpec = {
  name: "mylib",
  srcDir: "src",
  barrel: "index.js",
  componentPackages: [],
  contextKeyPrefix: "mylib:",
  label: "mylib",
  tool: "severan",
};
const options: SeveranOptions = { content: ["src/**/*.svelte"], report: true };
const plugin: Plugin = severan(library, options);
const webpackPlugin = new SeveranPlugin(library, options);
void specializeFiles;
void plugin;
void webpackPlugin;
`,
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        lib: ["esnext"],
        skipLibCheck: false,
        types: ["node"],
      },
      files: ["consumer.ts"],
    }),
  );
  const tsc = join(root, "node_modules/.bin/tsc");
  await $`${tsc} -p tsconfig.json`.cwd(dir);

  console.log(
    "✓ Specializes in Node; severan/vite and severan/webpack load; types check for consumers",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
