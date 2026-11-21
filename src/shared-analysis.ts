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

const KEY = Symbol.for("svelte-prune.analyses");

/**
 * Plugins to their analysis, so far: `undefined` before a build has
 * prepared one (or one that doesn't rewrite, such as the dev server's).
 * On `globalThis`, like the loader's registry: the plugin and its reader
 * may be different copies of this package.
 */
function registry(): WeakMap<object, () => SharedAnalysis | undefined> {
  const scope = globalThis as {
    [KEY]?: WeakMap<object, () => SharedAnalysis | undefined>;
  };
  scope[KEY] ??= new WeakMap();
  return scope[KEY];
}

export function shareAnalysis(
  plugin: object,
  current: () => SharedAnalysis | undefined,
): void {
  registry().set(plugin, current);
}

/**
 * The analysis of the plugin in `plugins` (Vite's resolved `config.plugins`,
 * webpack's `compiler.options.plugins`) that rewrites `library`, read when
 * called: from `generateBundle` or `processAssets` on, it's this build's.
 * `undefined` when no such plugin is there.
 */
export function siblingAnalysis(
  plugins: Iterable<unknown>,
  library: string,
): (() => SharedAnalysis | undefined) | undefined {
  const analyses = registry();
  const found: Array<() => SharedAnalysis | undefined> = [];
  for (const plugin of plugins) {
    if (typeof plugin !== "object" || plugin === null) continue;
    const current = analyses.get(plugin);
    if (current) found.push(current);
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
