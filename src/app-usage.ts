import type { Expression } from "sveast/walk";
import {
  appScope,
  collectSourceUsage,
  collectSvelteUsage,
  indexAppComponents,
  isAppComponent,
  type ModuleConstants,
  type ModuleUsage,
} from "./call-sites";
import {
  buildComponentModel,
  buildModuleModel,
  type ComponentModel,
} from "./component-model";
import { createScope, evaluate, type Scope } from "./evaluate";
import type { Library } from "./library";
import {
  addCallSite,
  type CallSite,
  type ComponentUsage,
  checkTarget,
  newComponentUsage,
} from "./usage";
import { isObject, UNKNOWN, type Value } from "./values";

const MODULE_FILE = /\.[cm]?[jt]s$/;
const TS_FILE = /\.[cm]?ts$/;

/** Exported primitives only: an importer could change an exported object. */
function moduleConstants(
  modules: ReadonlyArray<{ file: string; code: string }>,
): ModuleConstants {
  const sources = new Map<string, string>();
  for (const { file, code } of modules) {
    if (MODULE_FILE.test(file) && code.includes("export")) {
      sources.set(file, code);
    }
  }
  const constants = new Map<string, ReadonlyMap<string, Value> | undefined>();
  return (file) => {
    if (!constants.has(file)) {
      const code = sources.get(file);
      constants.set(
        file,
        code === undefined ? undefined : readConstants(file, code),
      );
    }
    return constants.get(file);
  };
}

function readConstants(
  file: string,
  code: string,
): ReadonlyMap<string, Value> | undefined {
  let model: ComponentModel;
  try {
    model = buildModuleModel(code, file, undefined, TS_FILE.test(file));
  } catch {
    return undefined;
  }
  const usage = newComponentUsage(true);
  const scope = createScope(model, usage, () => UNKNOWN);
  const values = new Map<string, Value>();
  for (const [exported, local] of exportedNames(model)) {
    const value = evaluate(
      { type: "Identifier", name: local } as Expression,
      scope,
    );
    if (value === UNKNOWN || [...value].some(isObject)) continue;
    values.set(exported, value);
  }
  return values.size > 0 ? values : undefined;
}

function exportedNames(
  model: ComponentModel,
): Array<readonly [exported: string, local: string]> {
  const names: Array<readonly [string, string]> = [];
  for (const statement of model.ast.module?.content.body ?? []) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source) {
      continue;
    }
    const { declaration } = statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier") {
          names.push([declarator.id.name, declarator.id.name]);
        }
      }
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.local.type === "Identifier" &&
        specifier.exported.type === "Identifier"
      ) {
        names.push([specifier.exported.name, specifier.local.name]);
      }
    }
  }
  return names;
}

export type AppUsage = {
  /** Every module's library call sites, ready for `analyzeUsage`. */
  modules: ModuleUsage[];
  /** Each analyzed file as first read: see `readLibraryImport`. */
  read: ReadonlyMap<string, ModuleUsage>;
  /**
   * Props read from call sites alone: sound only if nothing unanalyzed
   * renders them, which the build plugins check against the module graph.
   */
  closed: Set<string>;
  /** With merged usage; `undefined` unless closed and modeled. */
  scopeFor(file: string): Scope | undefined;
};

/**
 * Evaluates app components with the props their call sites pass, until no
 * usage grows, so props flow through wrappers to library call sites. One
 * never imported (a route), used by a script, or imported dynamically or
 * through an alias renders with any props.
 */
export function collectAppUsage(
  files: Iterable<{ file: string; code: string }>,
  library: Library,
  /** Aliased `.svelte` imports the bundler resolved; see `AppComponents`. */
  resolved?: ReadonlyMap<string, string>,
): AppUsage {
  const sources = new Map<string, string>();
  const others: Array<{ file: string; code: string }> = [];
  for (const entry of files) {
    if (entry.file.endsWith(".svelte")) sources.set(entry.file, entry.code);
    else others.push(entry);
  }
  const apps = indexAppComponents(sources.keys(), resolved);

  const models = new Map<string, ComponentModel | undefined>();
  const modelOf = (key: string): ComponentModel | undefined => {
    if (!models.has(key)) {
      let model: ComponentModel | undefined;
      try {
        model = buildComponentModel(sources.get(key) ?? "", key);
      } catch {
        // Unparseable: its sites still come from its imports.
      }
      models.set(key, model);
    }
    return models.get(key);
  };
  const constants = moduleConstants(others);
  const collect = (key: string, usage?: ComponentUsage) =>
    collectSvelteUsage(sources.get(key) ?? "", key, library, {
      apps,
      usage,
      model: modelOf(key),
      constants,
    });

  // Which app components some analyzed file refers to at all; the rest are
  // rendered by something the analysis can't see.
  const statics = others.map(({ file, code }) =>
    collectSourceUsage(code, file, library, apps),
  );
  const referenced = new Set<string>();
  const read = new Map<string, ModuleUsage>();
  let openApps = false;
  for (const module of [
    ...statics,
    ...[...sources.keys()].map((key) => collect(key)),
  ]) {
    if (module.file) read.set(module.file, module);
    openApps ||= module.openApps === true;
    for (const site of module.sites) {
      if (isAppComponent(site.component)) referenced.add(site.component);
    }
  }

  const usages = new Map<string, ComponentUsage>();
  const latest = new Map<string, ModuleUsage>();
  const queue = new Set<string>();
  const enqueue = (site: CallSite) => {
    if (!sources.has(site.component)) return;
    let usage = usages.get(site.component);
    if (!usage) {
      usage = newComponentUsage();
      usages.set(site.component, usage);
    }
    const model = modelOf(site.component);
    const merged = openApps
      ? { ...site, open: true }
      : model
        ? checkTarget(site, model)
        : site;
    const propNames = model?.propNames.values() ?? [];
    if (addCallSite(usage, merged, propNames, library.svelteMajor)) {
      queue.add(site.component);
    }
  };

  for (const key of sources.keys()) {
    if (openApps || !referenced.has(key)) {
      enqueue({ component: key, open: true, props: new Map(), slots: null });
    }
  }
  for (const module of statics) {
    for (const site of module.sites) {
      if (isAppComponent(site.component)) enqueue(site);
    }
  }
  for (const key of queue) {
    queue.delete(key);
    const module = collect(key, usages.get(key));
    latest.set(key, module);
    for (const site of module.sites) {
      if (isAppComponent(site.component)) enqueue(site);
    }
  }

  const libraryOnly = (module: ModuleUsage): ModuleUsage => ({
    ...module,
    sites: module.sites.filter((site) => !isAppComponent(site.component)),
  });
  const closed = new Set(
    [...usages].filter(([, usage]) => !usage.open).map(([key]) => key),
  );
  return {
    modules: [...statics, ...latest.values()].map(libraryOnly),
    read,
    closed,
    scopeFor(file) {
      const usage = usages.get(file);
      const model = modelOf(file);
      return closed.has(file) && usage && model
        ? appScope(model, file, usage, constants, library)
        : undefined;
    },
  };
}
