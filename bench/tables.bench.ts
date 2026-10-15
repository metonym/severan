import path from "node:path";
import { group, task } from "ostia";
import { specializeFiles } from "../src/analysis";
import { libraryAt } from "../src/library";
import { createComponentOptimizer, DEFAULT_NAMES } from "../src/optimizer";
import { writeTailwindSources } from "../src/tailwind-sources";
import { scanVariantTables } from "../src/variant-tables";
import { COMPONENTS, TABLES, writeTablesProject } from "./fixtures/tables";

/**
 * tailwind-variants tables and the sources written for Tailwind, on a
 * library shaped like flowbite-svelte (see `fixtures/tables.ts`) with
 * `tailwindcss` installed: the app renders half its components.
 */
const root = path.join(
  import.meta.dirname,
  "../node_modules/.cache/bench-tables",
);
const { app } = writeTablesProject(root);
const library = libraryAt(TABLES, path.join(root, "node_modules", TABLES.name));
const FAILURE = { feature: "severan", fallback: "nothing was rewritten" };

const specialize = () =>
  specializeFiles({
    library: TABLES,
    failure: FAILURE,
    projectRoot: root,
    files: [app],
  });
// Measures nothing new if the tables went unrewritten.
const result = await specialize();
if (
  "warning" in result ||
  result.tables.pruned === 0 ||
  result.tables.emptied === 0
) {
  throw new Error("the bench library's tables weren't rewritten");
}

group(
  `tailwind-variants tables: ${COMPONENTS} components, ${COMPONENTS / 2} rendered`,
  () => {
    // Component models and the table scan cached, as on a watch rebuild.
    task("specializeFiles", async () => {
      await specialize();
    });
    task("scanVariantTables (cold)", async () => {
      await scanVariantTables(library);
    });
  },
);

group("Tailwind sources", () => {
  // Every file already as it should be: a rebuild that changed nothing.
  task("writeTailwindSources: unchanged", async () => {
    await writeTailwindSources(library, root, {
      sources: result.sources,
      liveComponents: result.renderable,
    });
  });
});

const options = { silent: true, content: ["src/*.svelte"] };
group("plugin: prepare with tables and Tailwind", () => {
  task("cold: a new build", async () => {
    await createComponentOptimizer(TABLES, options, DEFAULT_NAMES).prepare(
      root,
    );
  });
  const warm = createComponentOptimizer(TABLES, options, DEFAULT_NAMES);
  task("watch rebuild: `content` unchanged", async () => {
    await warm.prepare(root);
  });
});
