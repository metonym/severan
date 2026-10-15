import type { Plugin } from "vite";
import type { LibrarySpec } from "./library-paths";
import { libraryImports } from "./module-graph";
import {
  createComponentOptimizer,
  DEFAULT_NAMES,
  type PluginNames,
  type SeveranOptions,
  writeOriginalsForTailwind,
} from "./optimizer";

/**
 * Vite, Rollup and Rolldown plugin that rewrites each component of
 * `library` the app renders for the props it passes: values that never
 * change become literals, and branches that can't run go, along with the
 * components only they render. The app's own components are rewritten
 * too when every call site is in `content`.
 *
 * Runs on production builds only, before Svelte compiles. Rewritten
 * components come with source maps back to their original source. With
 * Tailwind installed, every build (the dev server's included) writes what
 * of the library can render to `node_modules/.severan/<name>`, for Tailwind
 * to scan instead of the package.
 */
export function severan(
  library: LibrarySpec,
  options?: SeveranOptions,
  /** How it names itself in messages; `id` is its name in the bundler. */
  names: PluginNames & { id: string } = { ...DEFAULT_NAMES, id: "severan" },
): Plugin {
  let root = process.cwd();
  // Never rewrite for the dev server: HMR would leave rewritten components
  // stale, and `buildEnd` needs the complete module graph. Rollup and
  // Rolldown have no `configResolved`, so there it's up to the config.
  let serving = false;
  const optimizer = createComponentOptimizer(library, options, names);

  return {
    name: names.id,
    // Before the Svelte plugin: the first `load` that returns wins, and
    // `transform` must read app modules before a preprocessor changes them.
    // Rollup and Rolldown go by array order instead.
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      serving = config.command === "serve";
    },
    async buildStart() {
      if (serving) {
        const warning = await writeOriginalsForTailwind(library, root, names);
        if (warning) this.warn(warning);
        return;
      }
      const { warning, info, report } = await optimizer.prepare(
        root,
        async (source, importer) =>
          (await this.resolve(source, importer, { skipSelf: true }))?.id,
      );
      if (warning) this.warn(warning);
      if (info) this.info?.(info);
      for (const line of report ?? []) console.log(line);
    },
    load(id) {
      return serving ? undefined : optimizer.load(id);
    },
    transform(code, id) {
      if (!serving) optimizer.check(id, code);
    },
    async buildEnd() {
      if (serving) return;
      for (const edge of await libraryImports(library, this)) {
        optimizer.checkLibraryImport(edge);
      }
      for (const id of this.getModuleIds()) {
        if (optimizer.load(id) && id.endsWith(".js")) {
          const info = this.getModuleInfo(id);
          optimizer.checkScriptImporters(id, [
            ...(info?.importers ?? []),
            ...(info?.dynamicImporters ?? []),
          ]);
        }
        if (!optimizer.isClosed(id)) continue;
        const info = this.getModuleInfo(id);
        if (!info) continue;
        // An entry is mounted by something outside the module graph.
        const importers: Array<string | undefined> = [...info.importers];
        if (info.isEntry) importers.push(undefined);
        optimizer.checkImporters(
          id,
          importers,
          info.dynamicImporters.length > 0,
        );
      }
      const error = optimizer.error();
      if (error) this.error(error);
    },
  };
}
