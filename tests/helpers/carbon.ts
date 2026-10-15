import type { LibrarySpec } from "../../src/library-paths";
import { DEFAULT_NAMES } from "../../src/optimizer";
import { requirePackageDir } from "../../src/package";

// carbon-components-svelte: the reference library the tests run against.

const CARBON_CLASS_TOKEN = /(?<![\w-])bx--[\w-]+/g;
const CARBON_TOKEN = /bx--[A-Za-z0-9_-]+/g;

export const CARBON: LibrarySpec = {
  name: "carbon-components-svelte",
  srcDir: "src",
  barrel: "index.js",
  componentPackages: ["carbon-icons-svelte", "carbon-pictograms-svelte"],
  contextKeyPrefix: "carbon:",
  label: "Carbon",
  tool: "severan",
  classTokens: {
    marker: "bx--",
    text: (text) =>
      [...text.matchAll(CARBON_CLASS_TOKEN)].map(([t]) => `.${t}`),
    script(code, into) {
      if (!code.includes("bx--")) return;
      for (const [token] of code.matchAll(CARBON_TOKEN)) {
        into.add(`.${token}`);
      }
    },
  },
};

export const FAILURE = DEFAULT_NAMES.failure;

/** Directory of the installed `carbon-components-svelte`. */
export function resolveCarbonRoot(from: string = process.cwd()): string {
  return requirePackageDir(CARBON.name, from);
}
