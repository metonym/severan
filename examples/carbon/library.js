// carbon-components-svelte's spec. A module, not JSON: `classTokens` reads
// only Carbon's `bx--` classes, so a `startsWith("bx--")` in its code isn't
// read as a prefix every class shares.

const CLASS = /(?<![\w-])bx--[\w-]+/g;
const TOKEN = /bx--[A-Za-z0-9_-]+/g;

export default {
  name: "carbon-components-svelte",
  srcDir: "src",
  barrel: "index.js",
  componentPackages: ["carbon-icons-svelte", "carbon-pictograms-svelte"],
  contextKeyPrefix: "carbon:",
  label: "Carbon",
  tool: "severan",
  classTokens: {
    marker: "bx--",
    text: (text) => Array.from(text.matchAll(CLASS), ([token]) => `.${token}`),
    script(code, into) {
      if (!code.includes("bx--")) return;
      for (const [token] of code.matchAll(TOKEN)) into.add(`.${token}`);
    },
  },
  styles: { stylesheets: ["carbon-components-svelte/css/*.css"] },
};
