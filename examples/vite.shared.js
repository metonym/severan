import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { severan } from "../dist/vite.js";

const EXAMPLES = import.meta.dirname;

/**
 * Svelte hashes a component's filename into its scoped class, and Vite
 * names files outside the root (`node_modules` here) by absolute path:
 * hash the path from `examples/`, the same on every machine.
 */
function cssHash({ filename, css, hash }) {
  const file = filename?.startsWith(EXAMPLES)
    ? path.relative(EXAMPLES, filename)
    : (filename ?? css);
  return `svelte-${hash(file.split(path.sep).join("/"))}`;
}

/**
 * One example's Vite config. `SEVERAN=1` adds severan (the built package in
 * `../dist`) and, with Tailwind, swaps `src/app.css` for
 * `src/app.severan.css`, which scans `node_modules/.severan` instead of the
 * library: the one line an app changes. `OUT` is the output directory.
 */
export function exampleConfig(dir, { plugins = [] } = {}) {
  const library = JSON.parse(
    readFileSync(path.join(dir, "library.json"), "utf8"),
  );
  const optimized = process.env.SEVERAN === "1";
  const severanCss = path.join(dir, "src/app.severan.css");
  const tailwind = existsSync(severanCss);
  return {
    root: dir,
    logLevel: "warn",
    plugins: [
      ...plugins,
      ...(optimized ? [severan(library, { silent: true })] : []),
      svelte({ compilerOptions: { cssHash } }),
      ...(tailwind ? [tailwindcss()] : []),
    ],
    resolve: {
      alias: {
        "~app.css":
          optimized && tailwind ? severanCss : path.join(dir, "src/app.css"),
      },
    },
    build: {
      outDir: process.env.OUT ?? "dist",
      emptyOutDir: true,
      // Measured as shipped, but not split: one number per asset type.
      modulePreload: false,
      reportCompressedSize: false,
    },
  };
}
