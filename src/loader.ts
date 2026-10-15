import type { ComponentOptimizer } from "./optimizer";

const KEY = Symbol.for("severan.optimizers");

/**
 * Optimizers by id: loader options must be plain data under Rspack, and
 * the loader may load as its own copy of this module, so the map lives on
 * `globalThis`.
 */
export function optimizerRegistry(): Map<string, ComponentOptimizer> {
  const scope = globalThis as { [KEY]?: Map<string, ComponentOptimizer> };
  scope[KEY] ??= new Map();
  return scope[KEY];
}

type LoaderContext = {
  resourcePath: string;
  resourceQuery: string;
  getOptions(): { id: string };
  addDependency(file: string): void;
  callback(error: null, code: string, map?: unknown): void;
};

/** The pre-loader `SeveranPlugin` adds on `.svelte` files: serves the ones it rewrote. */
export default function severanLoader(
  this: LoaderContext,
  source: string,
  map?: unknown,
): void {
  const optimizer = optimizerRegistry().get(this.getOptions().id);
  // Rewritten for what `content` held: rebuild when any of it changes.
  if (optimizer?.rewritable(this.resourcePath)) {
    for (const file of optimizer.analyzed) this.addDependency(file);
  }
  const rewritten = optimizer?.load(this.resourcePath + this.resourceQuery);
  if (rewritten) this.callback(null, rewritten.code, rewritten.map);
  else this.callback(null, source, map);
}
