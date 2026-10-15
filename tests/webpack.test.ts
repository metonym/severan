import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpack from "webpack";
import type { LibrarySpec } from "../src/library-paths";
import { optimizerRegistry } from "../src/loader";
import { SeveranPlugin } from "../src/webpack";
import { CARBON } from "./helpers/carbon";
import { createFakeProject } from "./helpers/fake-project";
import { resolvePackageRoot } from "./helpers/resolve-package-root";
import { installTableLibrary, TVLIB } from "./helpers/tailwind-variants";

const IMPORT_BUTTON = `import { Button } from "carbon-components-svelte";`;
const SVELTE_FILE = /\.svelte$/;
const SVELTE_LOADER = path.join(
  import.meta.dir,
  "helpers/svelte-source-loader.cjs",
);
const CARD_ESCAPED =
  /read the props of src[\\/]Card\.svelte from its call sites in `content`, but lib[\\/]extra\.js also renders it\./;
const UNREAD_MODAL =
  /can't read how src[\\/]App\.svelte imports `@carbon\/src\/Modal\/Modal\.svelte`/;
const MISSED_TOOLBAR =
  /severan rewrote Carbon components before seeing lib[\\/]toolbar\.js/;
const TABLE_IMPORTED =
  /rewrote the tailwind-variants tables in node_modules[\\/]tvlib[\\/]src[\\/]theme\.js .* but src[\\/]index\.js imports it directly/;

/**
 * Builds `files` under a fake project with real webpack. `.svelte` files
 * are bundled as their source text (see `svelte-source-loader.cjs`), so the
 * bundle shows what Svelte would have compiled.
 */
async function build(
  files: Record<string, string>,
  mode: "production" | "development" | undefined = "production",
  resolve: webpack.Configuration["resolve"] = {},
  library: LibrarySpec = CARBON,
) {
  const project = createFakeProject();
  if (library === CARBON) project.linkCarbon();
  else installTableLibrary(project.root);
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(project.root, file)), { recursive: true });
    writeFileSync(path.join(project.root, file), code);
  }
  const compiler = webpack({
    mode,
    context: project.root,
    entry: "./src/index.js",
    output: { path: path.join(project.root, "out") },
    module: { rules: [{ test: SVELTE_FILE, loader: SVELTE_LOADER }] },
    resolve,
    optimization: { minimize: false },
    devtool: false,
    plugins: [new SeveranPlugin(library, { silent: true })],
    infrastructureLogging: { level: "none" },
  });
  const stats = await new Promise<webpack.Stats>((resolve, reject) =>
    compiler.run((error, result) =>
      error || !result ? reject(error) : resolve(result),
    ),
  );
  await new Promise((resolve) => compiler.close(resolve));
  const bundle = path.join(project.root, "out", "main.js");
  return {
    stats,
    code: stats.hasErrors() ? "" : readFileSync(bundle, "utf8"),
    dispose: project.dispose,
  };
}

const APP = {
  "src/App.svelte": `<script>${IMPORT_BUTTON}</script>\n<Button kind="tertiary">Save</Button>`,
  "src/index.js": `import App from "./App.svelte";\nconsole.log(App);`,
};

describe("SeveranPlugin", () => {
  test("hands the next loader Carbon rewritten for the app", async () => {
    const { stats, code, dispose } = await build(APP);
    try {
      expect(stats.hasErrors()).toBe(false);
      expect(code).toContain(String.raw`\"bx--btn--tertiary\"`);
      expect(code).not.toContain("<ButtonSkeleton");
    } finally {
      dispose();
    }
  });

  test("a config without `mode` builds for production, like webpack", async () => {
    const before = optimizerRegistry().size;
    const { stats, code, dispose } = await build(APP, undefined);
    try {
      expect(stats.hasErrors()).toBe(false);
      expect(code).not.toContain("<ButtonSkeleton");
      // Closing the compiler forgets its optimizer.
      expect(optimizerRegistry().size).toBe(before);
    } finally {
      dispose();
    }
  });

  test("leaves development builds alone", async () => {
    const { code, dispose } = await build(APP, "development");
    try {
      expect(code).toContain("<ButtonSkeleton");
    } finally {
      dispose();
    }
  });

  test("follows a wrapper's props, unless something outside `content` renders it", async () => {
    const files = {
      "src/App.svelte": `<script>import Card from "./Card.svelte";</script>\n<Card tone="danger" />`,
      "src/Card.svelte": `<script>${IMPORT_BUTTON}\nexport let tone = "primary";</script>\n<Button kind={tone} />`,
      "src/index.js": `import App from "./App.svelte";\nconsole.log(App);`,
    };
    const wrapped = await build(files);
    try {
      expect(wrapped.stats.hasErrors()).toBe(false);
      expect(wrapped.code).toContain(String.raw`\"bx--btn--danger\"`);
      // The wrapper itself, rewritten for its one call site.
      expect(wrapped.code).toContain(String.raw`kind={\"danger\"}`);
    } finally {
      wrapped.dispose();
    }

    const escaped = await build({
      ...files,
      "src/index.js": `${files["src/index.js"]}\nimport "../lib/extra.js";`,
      "lib/extra.js": `import Card from "../src/Card.svelte";\nconsole.log(Card);`,
    });
    try {
      const errors = escaped.stats.toJson({ errors: true }).errors ?? [];
      expect(errors.map((error) => error.message).join("\n")).toMatch(
        CARD_ESCAPED,
      );
    } finally {
      escaped.dispose();
    }
  });

  test("fails the build on an import of Carbon the analysis can't read", async () => {
    const { stats, dispose } = await build(
      {
        ...APP,
        "src/App.svelte": `<script>${IMPORT_BUTTON}\nimport Modal from "@carbon/src/Modal/Modal.svelte";</script>\n<Button kind="tertiary">Save</Button><Modal open />`,
      },
      "production",
      { alias: { "@carbon": resolvePackageRoot("carbon-components-svelte") } },
    );
    try {
      const errors = stats.toJson({ errors: true }).errors ?? [];
      expect(errors.map((error) => error.message).join("\n")).toMatch(
        UNREAD_MODAL,
      );
    } finally {
      dispose();
    }
  });

  test("fails the build when a module outside `content` renders Carbon", async () => {
    const { stats, dispose } = await build({
      ...APP,
      "src/index.js": `${APP["src/index.js"]}\nimport "../lib/toolbar.js";`,
      "lib/toolbar.js": `${IMPORT_BUTTON}\nconsole.log(Button);`,
    });
    try {
      const errors = stats.toJson({ errors: true }).errors ?? [];
      expect(errors.map((error) => error.message).join("\n")).toMatch(
        MISSED_TOOLBAR,
      );
    } finally {
      dispose();
    }
  });

  test("serves tailwind-variants tables rewritten for the app", async () => {
    const files = {
      "src/App.svelte": `<script>import { Button } from "tvlib";</script>\n<Button color="red" />`,
      // The source loader doesn't follow `.svelte` imports: bundle the barrel.
      "src/index.js": `import "tvlib";\nimport App from "./App.svelte";\nconsole.log(App);`,
    };
    const served = await build(files, "production", {}, TVLIB);
    try {
      expect(served.stats.hasErrors()).toBe(false);
      expect(served.code).toContain("bg-red");
      expect(served.code).not.toContain("bg-green");
    } finally {
      served.dispose();
    }

    const aliased = await build(
      {
        ...files,
        "src/index.js": `${files["src/index.js"]}\nimport { button } from "@theme";\nconsole.log(button);`,
      },
      "production",
      { alias: { "@theme": "tvlib/theme.js" } },
      TVLIB,
    );
    try {
      const errors = aliased.stats.toJson({ errors: true }).errors ?? [];
      expect(errors.map((error) => error.message).join("\n")).toMatch(
        TABLE_IMPORTED,
      );
    } finally {
      aliased.dispose();
    }
  });
});
