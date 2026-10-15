import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "bun";
import { bundleDts } from "./bundle-dts";

const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "dist");
const entries = {
  index: resolve(root, "src/index.ts"),
  vite: resolve(root, "src/vite.ts"),
  webpack: resolve(root, "src/webpack.ts"),
  // An entry of its own: `SeveranPlugin` hands webpack and Rspack its path.
  loader: resolve(root, "src/loader.ts"),
  // Unstable, for carbon-preprocess-svelte: `internal` never loads the
  // parser, `internal-analysis` does.
  internal: resolve(root, "src/internal.ts"),
  "internal-analysis": resolve(root, "src/internal-analysis.ts"),
};
const SVELTE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']svelte/;

await rm(outDir, { recursive: true, force: true });

// One build, so the entries share the analysis instead of each bundling it.
const result = await build({
  entrypoints: Object.values(entries),
  outdir: outDir,
  naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
  format: "esm",
  target: "node",
  minify: true,
  splitting: true,
  // Never bundle Svelte: an import of it fails the check below instead.
  external: ["svelte", "svelte/*"],
});
if (!result.success) {
  console.error(result.logs.join("\n"));
  process.exit(1);
}

// sveast parses components, so nothing may import svelte: it would load
// the consumer's compiler, or fail where none resolves.
for (const file of await readdir(outDir)) {
  if (!file.endsWith(".js")) continue;
  // biome-ignore lint/performance/noAwaitInLoops: a few files, failing on the first
  if (SVELTE_IMPORT.test(await readFile(resolve(outDir, file), "utf8"))) {
    console.error(`dist/${file} imports svelte`);
    process.exit(1);
  }
}

// One declaration file per public entry, holding only what its exports
// reference: the analysis's own types (and sveast's) stay out.
await Promise.all(
  (["index", "vite", "webpack", "internal", "internal-analysis"] as const).map(
    (name) =>
      bundleDts({
        root,
        source: entries[name],
        outFile: resolve(outDir, `${name}.d.ts`),
      }),
  ),
);

await Promise.all(
  ["README.md", "LICENSE"].map((file) =>
    cp(resolve(root, file), resolve(outDir, file)),
  ),
);

const manifest = await Bun.file(resolve(root, "package.json")).json();
const pkg = Object.fromEntries(
  Object.entries(manifest).filter(
    ([key]) => key !== "devDependencies" && key !== "scripts",
  ),
);
const types = "./index.d.ts";
await writeFile(
  resolve(outDir, "package.json"),
  `${JSON.stringify(
    {
      ...pkg,
      main: "./index.js",
      types,
      exports: {
        ".": { types, import: "./index.js", default: "./index.js" },
        "./vite": {
          types: "./vite.d.ts",
          import: "./vite.js",
          default: "./vite.js",
        },
        "./webpack": {
          types: "./webpack.d.ts",
          import: "./webpack.js",
          default: "./webpack.js",
        },
        "./internal": {
          types: "./internal.d.ts",
          import: "./internal.js",
          default: "./internal.js",
        },
        "./internal/analysis": {
          types: "./internal-analysis.d.ts",
          import: "./internal-analysis.js",
          default: "./internal-analysis.js",
        },
      },
    },
    null,
    2,
  )}\n`,
);

console.log("✓ Build completed");
