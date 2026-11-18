import { appRendering, prunedStyles } from "./helpers/render-library";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeFiles } from "../src/analysis";
import {
  createStylePruner,
  definedClasses,
  isSafelisted,
  libraryStylePruner,
  stylesheetFiles,
} from "../src/styles";
import { CARBON, FAILURE } from "./helpers/carbon";

const BTN_G = /^\.btn-g/;
const BX_BTN_DANGER = /^\.bx--btn--danger/;

const rules = (css: string) =>
  css
    .split("}")
    .map((rule) => rule.split("{")[0].trim())
    .filter(Boolean);

describe("createStylePruner", () => {
  const prune = createStylePruner((cls) => cls.startsWith("gone"));

  test.each([
    [".gone", false],
    [".kept", true],
    [".kept .gone", false],
    [".kept.gone:hover", false],
    [".kept:not(.gone)", true],
    [".kept:has(.gone)", true],
    // Kept: caligula lists only the classes every `:is()` branch shares.
    [".kept:is(.gone, .gone-too)", true],
    [".kept:is(.gone, .other)", true],
    [":is(.gone .x, .kept .y)", true],
    [":where(.gone .x, .gone-too)", false],
    ["div > p", true],
    [".gone\\:x", false],
  ])("%s survives: %p", (selector, survives) => {
    const { css } = prune(`${selector}{color:red}`);
    expect(css.includes("color:red")).toBe(survives);
  });

  test("trims a selector list and counts what it removes", () => {
    const result = prune(".kept, .gone, .gone-too { a: b }\n.gone { c: d }");
    expect(rules(result.css)).toEqual([".kept"]);
    expect(result.rules).toBe(1);
    expect(result.selectors).toBe(2);
  });

  test("drops at-rules it leaves empty, and leaves the rest alone", () => {
    const { css } = prune(
      "@media (min-width: 1px) { .gone { a: b } }\n@keyframes spin { to { c: d } }\n@font-face { font-family: x }",
    );
    expect(css).not.toContain("@media");
    expect(css).toContain("@keyframes spin");
    expect(css).toContain("@font-face");
  });
});

test("definedClasses reads required and negated classes", () => {
  const found = new Set<string>();
  definedClasses(".a .b:not(.c), .d:is(.e, .f) { x: y }", found);
  expect([...found].sort()).toEqual(["a", "b", "c", "d"]);
});

// A library whose styles.css styles every class its components can render;
// what the app renders decides which rules stay.

const LIBRARY = {
  "Button.svelte": `<script>
  export let kind = "primary";
  export let size = "md";
</script>
<button class="btn btn-{size} {kind === 'ghost' ? 'btn-ghost' : 'btn-primary'}"><slot /></button>`,
  "Alert.svelte": `<script>
  export let tone = undefined;
</script>
<div class="alert alert-{tone}"><slot /></div>`,
  "Card.svelte": `<script>
  import { cardClass } from "./card.js";
</script>
<div class={cardClass}><slot /></div>`,
  "card.js": `export const cardClass = "card card-raised";`,
  "Unused.svelte": `<div class="unused"></div>`,
};

const CSS = `.btn { a: 1 }
.btn-md { a: 2 }
.btn-lg { a: 3 }
.btn-primary { a: 4 }
.btn-ghost { a: 5 }
.alert { a: 6 }
.alert-danger { a: 7 }
.card { a: 8 }
.card-raised { a: 9 }
.unused { a: 10 }`;

const pruned = async (markup: string, script = "", styles = {}) =>
  rules(
    await prunedStyles(
      { lib: LIBRARY, app: appRendering(markup, script) },
      CSS,
      styles,
    ),
  );

describe("pruneStyles", () => {
  test("drops what no live branch or component renders", async () => {
    const kept = await pruned("<Button>Go</Button>");
    expect(kept).toContain(".btn");
    expect(kept).toContain(".btn-md");
    expect(kept).toContain(".btn-primary");
    expect(kept).not.toContain(".btn-ghost");
    expect(kept).not.toContain(".btn-lg");
    expect(kept).not.toContain(".alert");
    expect(kept).not.toContain(".unused");
  });

  test("keeps every class a template may build from an unknown value", async () => {
    const kept = await pruned(
      "<Alert tone={tone}>Hi</Alert>",
      "export let tone;",
    );
    expect(kept).toContain(".alert-danger");
  });

  test("keeps classes a script module names", async () => {
    const kept = await pruned("<Card>Hi</Card>");
    expect(kept).toContain(".card");
    expect(kept).toContain(".card-raised");
  });

  test("keeps classes the app's own files name", async () => {
    const kept = await pruned('<div class="unused btn-lg">x</div><Button />');
    expect(kept).toContain(".unused");
    expect(kept).toContain(".btn-lg");
  });

  test("keeps `keep` and `safelist`, and classes it doesn't define", async () => {
    const kept = await pruned("<Button />", "", {
      keep: ["alert"],
      safelist: ["btn-ghost"],
      emitted: `${CSS}\n.page { a: 11 }`,
    });
    expect(kept).toContain(".alert");
    expect(kept).toContain(".btn-ghost");
    expect(kept).toContain(".page");
  });

  test("keeps a selector `safelist` matches whole", async () => {
    const kept = await pruned("<Button />", "", {
      safelist: [".alert-danger", BTN_G],
      emitted: `${CSS}\n.alert .alert-danger { a: 12 }`,
    });
    // A class keeps every selector it's in, even with classes that go.
    expect(kept).toContain(".alert-danger");
    expect(kept).toContain(".alert .alert-danger");
    expect(kept).not.toContain(".alert");
    expect(kept).toContain(".btn-ghost");
    expect(kept).not.toContain(".btn-lg");
  });

  test("keeps classes outside the namespace `classTokens` reads", async () => {
    const css =
      ".my-btn { a: 1 }\n.my-btn.up-icon { a: 2 }\n.my-ghost { a: 3 }";
    const kept = rules(
      await prunedStyles(
        {
          lib: {
            "Button.svelte": `<script>export let ghost = false;</script>
<button class="my-btn up-icon {ghost ? 'my-ghost' : ''}"></button>`,
          },
          app: appRendering("<Button />"),
        },
        css,
        {
          classTokens: {
            marker: "my-",
            text: (text) =>
              Array.from(text.matchAll(/my-[\w-]+/g), ([token]) => `.${token}`),
            script() {},
          },
        },
      ),
    );
    expect(kept).toEqual([".my-btn", ".my-btn.up-icon"]);
  });

  test("keeps every variant of a component used as a value", async () => {
    const kept = await pruned(
      "<svelte:component this={Button} />",
      'import { Button } from "mylib";',
    );
    expect(kept).toContain(".btn-ghost");
    expect(kept).toContain(".btn-lg");
  });
});

describe("stylesheetFiles", () => {
  test("finds a package's files, `*` within a segment", () => {
    const files = stylesheetFiles(
      ["carbon-components-svelte/css/*.css"],
      process.cwd(),
    );
    expect(files.some((file) => file.endsWith("css/white.css"))).toBe(true);
  });

  test.each([
    ["carbon-components-svelte/css/none.css", "matches no file"],
    ["carbon-components-svelte", "not a file in a package"],
  ])("rejects %s", (stylesheet, message) => {
    expect(() => stylesheetFiles([stylesheet], process.cwd())).toThrow(message);
  });
});

test.each([
  [".x--grid:hover", ["x--grid"], true],
  ["div.x--grid", [".x--grid"], true],
  [".x--grid-narrow", ["x--grid"], false],
  [".sm\\:p-4", ["sm:p-4"], true],
  [".x--tag--red", [/^\.x--tag--/g], true],
  [".x--tag--red", [/^\.x--tag--/g], true],
] as const)("isSafelisted(%p, %p) is %p", (selector, safelist, expected) => {
  expect(isSafelisted(selector, safelist)).toBe(expected);
});

test("libraryStylePruner prunes with an analysis made without `specializeFiles`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "styles-"));
  try {
    const file = join(dir, "App.svelte");
    const code = `<script>import { Button } from "carbon-components-svelte";</script>\n<Button kind="tertiary">Hi</Button>`;
    writeFileSync(file, code);
    const library = {
      ...CARBON,
      styles: { stylesheets: ["carbon-components-svelte/css/white.css"] },
    };
    const result = await analyzeFiles({
      library,
      failure: FAILURE,
      projectRoot: process.cwd(),
      files: [{ file, code }],
      components: ["Button"],
      options: {},
    });
    if ("warning" in result) throw new Error(result.warning);
    const prune = libraryStylePruner({
      spec: library,
      projectRoot: process.cwd(),
      isPruned: result.isPruned,
      files: [{ code }],
      safelist: [BX_BTN_DANGER],
    });
    const { css } = prune?.(
      ".bx--btn--tertiary{a:1}.bx--btn--ghost{a:2}.bx--btn--danger{a:3}",
    ) ?? { css: "" };
    expect(css).toBe(".bx--btn--tertiary{a:1}.bx--btn--danger{a:3}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
