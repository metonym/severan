import path from "node:path";
import { exampleConfig } from "../vite.shared.js";

// svelte-5-ui-lib 0.12.6 ships `dist/package.json` ("main": "dist/index.js"),
// so its own `from '.'`, `'..'` and `'../..'` resolve to files that don't exist.
const DIRECTORY = /^\.\.?(?:\/\.\.)*\/?$/;
const indexImports = {
  name: "svelte-5-ui-lib-index",
  enforce: "pre",
  resolveId(source, importer) {
    if (
      DIRECTORY.test(source) &&
      importer?.includes("/svelte-5-ui-lib/dist/")
    ) {
      return path.resolve(path.dirname(importer), source, "index.js");
    }
  },
};

export default exampleConfig(import.meta.dirname, { plugins: [indexImports] });
