/**
 * What the analysis says renders: self-contained, so declarations that
 * reference it don't take the analysis's own types with them.
 */
export type RenderedUsage = {
  /** Export names of the library's components that can render (`Button`). */
  readonly liveComponents: ReadonlySet<string>;
  /** Whether no live component can apply class `cls` (`.x--btn--danger`). */
  isPruned(cls: string): boolean;
};

/**
 * What a `sveltePrune` or `SveltePrunePlugin` build's analysis read, for a
 * sibling plugin in the same build: the call sites its rewrite is for, and
 * the `content` files it read them from. `warning` when it failed.
 */
export type SharedAnalysis =
  | {
      /** The library whose components it rewrote. */
      library: string;
      usage: RenderedUsage;
      files: ReadonlyArray<{ file: string; code: string }>;
    }
  | { library: string; warning: string };

type Current = () => SharedAnalysis | undefined;

const KEY = Symbol.for("svelte-prune.analyses");

/**
 * Plugins, and the builds they're in (Vite's resolved config, a webpack
 * compiler), to their analyses so far: `undefined` before a build has
 * prepared one, or for one that doesn't rewrite (the dev server). On
 * `globalThis`, like the loader's registry: the plugin and its reader may
 * be different copies of this package.
 */
function registry(): WeakMap<object, Current[]> {
  const scope = globalThis as { [KEY]?: WeakMap<object, Current[]> };
  scope[KEY] ??= new WeakMap();
  return scope[KEY];
}

/** Registers `current` under `key`: a plugin, or the build it's in. */
export function shareAnalysis(key: object, current: Current): void {
  const analyses = registry();
  const found = analyses.get(key) ?? [];
  if (!found.includes(current)) found.push(current);
  analyses.set(key, found);
}

/**
 * The analysis that the svelte-prune plugin rewriting `library` in `build`
 * made, read when called: from `generateBundle` or `processAssets` on,
 * it's that build's. `build` is Vite's resolved config (in
 * `configResolved`), a webpack or Rspack compiler (in `apply`), or a list
 * of plugins (Rollup's, Rolldown's). The config or compiler finds a plugin
 * another plugin wraps. `undefined` when there's no such plugin.
 */
export function siblingAnalysis(
  build: object,
  library: string,
): Current | undefined {
  const analyses = registry();
  const found = [...(analyses.get(build) ?? [])];
  if (Symbol.iterator in build) {
    for (const plugin of build as Iterable<unknown>) {
      if (typeof plugin !== "object" || plugin === null) continue;
      found.push(...(analyses.get(plugin) ?? []));
    }
  }
  if (found.length === 0) return undefined;
  return () => {
    for (const current of found) {
      const analysis = current();
      if (analysis?.library === library) return analysis;
    }
    return undefined;
  };
}
