/** The usage analysis and the rewrites it drives. The plugins load it lazily. */
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  analyzeUsage,
  type UsageAnalysis,
  type UsageOptions,
} from "./analyze-usage";
import { type AppUsage, collectAppUsage } from "./app-usage";
import { type ModuleUsage, readLibraryImport } from "./call-sites";
import type { Scope } from "./evaluate";
import { type Library, loadLibrary } from "./library";
import { type LibrarySpec, libraryPaths } from "./library-paths";
import { type SourceMap, toSourceMap } from "./mapped-text";
import {
  type Specialization,
  type SpecializeOptions,
  specializeComponent,
} from "./specialize";
import { errorMessage, realpath } from "./util";
import { formatValue, UNKNOWN } from "./values";

export type UsageResult = {
  analysis: UsageAnalysis;
  library: Library;
  /** Export names of the library's components that can render (`Button`). */
  liveComponents: Set<string>;
  isPruned(cls: string): boolean;
};

/** For a failed analysis's warning: the feature it turns off, and what happens instead. */
export type Failure = { feature: string; fallback: string };

function failure(
  spec: LibrarySpec,
  error: unknown,
  { feature, fallback }: Failure,
): string {
  return `${libraryPaths(spec).logPrefix} ${feature} could not analyze this build (${errorMessage(error)}); ${fallback}.`;
}

/** `components` (names or paths) is the bundle; one no file renders keeps every variant. */
export async function analyzeFiles(input: {
  library: LibrarySpec;
  projectRoot: string;
  files: Iterable<{ file: string; code: string }>;
  components: Iterable<string>;
  options: UsageOptions;
  failure: Failure;
  /** `collectAppUsage(files)`, if the caller already has it. */
  appUsage?: AppUsage;
}): Promise<UsageResult | { warning: string }> {
  try {
    const library = loadLibrary(input.library, input.projectRoot);
    const bundled: string[] = [];
    for (const component of input.components) {
      const key =
        library.moduleKey(component) ?? library.components.get(component);
      if (key) bundled.push(key);
    }
    return await analyzeBundle(
      library,
      (input.appUsage ?? collectAppUsage(input.files, library)).modules,
      bundled,
      input.options,
    );
  } catch (error) {
    return { warning: failure(input.library, error, input.failure) };
  }
}

/** A `bundled` key no module renders keeps every variant. */
async function analyzeBundle(
  library: Library,
  modules: readonly ModuleUsage[],
  bundled: Iterable<string>,
  options: UsageOptions,
): Promise<UsageResult> {
  const rendered = new Set(
    modules.flatMap((module) => module.sites.map((site) => site.component)),
  );
  const keys = new Set(bundled);
  const unseen: ModuleUsage = {
    sites: [],
    openAll: false,
    providedContexts: new Set(),
  };
  for (const component of keys) {
    if (!rendered.has(component)) {
      unseen.sites.push({
        component,
        open: true,
        props: new Map(),
        slots: null,
        reason: "not found in `content`",
      });
    }
  }
  const analysis = await analyzeUsage({
    library,
    bundled: keys,
    modules: [...modules, unseen],
    options,
  });
  return {
    analysis,
    library,
    liveComponents: new Set(
      [...analysis.liveComponents].map((key) => path.posix.parse(key).name),
    ),
    isPruned: analysis.isPruned,
  };
}

function nameOf(result: UsageResult, key: string): string {
  for (const [name, component] of result.library.components) {
    if (component === key) return name;
  }
  return path.posix.parse(key).name;
}

function formatCallSites(result: UsageResult, root: string): string[] {
  const lines: string[] = [];
  const relative = (file: string) =>
    path.isAbsolute(file) ? path.relative(root, file) : file;

  const entries = [...result.analysis.usages]
    .filter(([, usage]) => usage.appSites.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [key, usage] of entries) {
    const name = nameOf(result, key);
    const sites = usage.appSites.length;
    lines.push(`    ${name} (${sites} call site${sites === 1 ? "" : "s"})`);
    const open = usage.appSites.find((site) => site.open);
    if (open) {
      const where = open.location
        ? ` at ${relative(open.location.file)}:${open.location.line}`
        : "";
      lines.push(`      every variant kept: ${open.reason ?? "open"}${where}`);
      continue;
    }
    if (usage.open) {
      lines.push(`      every variant kept: ${usage.openReason ?? "open"}`);
      continue;
    }
    const propNames = new Set(
      usage.appSites.flatMap((site) => [...site.props.keys()]),
    );
    const why = (prop: string) => {
      const reason = usage.unknownBecause.get(prop);
      return reason ? `: ${reason}` : "";
    };
    for (const prop of [...propNames].sort()) {
      const value = usage.props.get(prop);
      if (value === undefined) continue;
      const omitted = usage.omitted.has(prop) ? " (+ default)" : "";
      const reason = value === UNKNOWN ? why(prop) : "";
      lines.push(
        `      ${prop.padEnd(16)} ${formatValue(value)}${omitted}${reason}`,
      );
    }
    // Props the app doesn't pass that something else leaves unknown.
    for (const [prop, value] of [...usage.props].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (propNames.has(prop) || value !== UNKNOWN) continue;
      if (!usage.unknownBecause.has(prop)) continue;
      lines.push(`      ${prop.padEnd(16)} dynamic${why(prop)}`);
    }
  }
  return lines;
}

export type RewrittenSource = { code: string; map: SourceMap };

/** Library components rewritten for an app, by real path of their source. */
export type SpecializedComponents = {
  sources: Map<string, RewrittenSource>;
  edits: number;
  /** App components whose props came from their analyzed call sites: nothing else may render them. */
  closed: Set<string>;
  /** How many of the app's own components `sources` holds. */
  apps: number;
  report: () => string[];
  /**
   * Whether the analysis read `importer`'s import of library module `id` (real
   * paths): `false` for one it can't see (an alias), `true` for a module whose
   * imports it doesn't read (a script, a stylesheet).
   */
  readImport: (importer: string, id: string) => boolean;
};

/** Rewrites each library component `files` render, and each app component whose every call site they hold. */
export async function specializeFiles(input: {
  library: LibrarySpec;
  projectRoot: string;
  files: Array<{ file: string; code: string }>;
  options?: SpecializeOptions;
  /** Aliased `.svelte` imports the bundler resolved, by `importKey`. */
  resolvedImports?: ReadonlyMap<string, string>;
  failure: Failure;
}): Promise<SpecializedComponents | { warning: string }> {
  let appUsage: AppUsage;
  let library: Library;
  let result: UsageResult;
  try {
    library = loadLibrary(input.library, input.projectRoot);
    appUsage = collectAppUsage(input.files, library, input.resolvedImports);
    // Every component the app renders, and nothing else, is bundled.
    result = await analyzeBundle(
      library,
      appUsage.modules,
      appUsage.modules.flatMap((module) =>
        module.sites.map((site) => site.component),
      ),
      {},
    );
  } catch (error) {
    return { warning: failure(input.library, error, input.failure) };
  }

  const src = realpathSync(library.src);
  const sources: SpecializedComponents["sources"] = new Map();
  let edits = 0;
  const rewrites: ComponentRewrite[] = [];
  const appRewrites: Array<{ file: string; edits: number }> = [];
  const serve = (file: string, scope: Scope, specialized: Specialization) => {
    edits += specialized.edits;
    sources.set(file, {
      code: specialized.code,
      map: toSourceMap(
        specialized.mapped,
        scope.model.code,
        path.basename(file),
      ),
    });
  };
  try {
    for (const key of result.analysis.liveComponents) {
      const scope = result.analysis.scopeFor(key);
      if (!scope) continue;
      const specialized = specializeComponent(scope, input.options);
      serve(path.join(src, key), scope, specialized);
      rewrites.push({
        key,
        edits: specialized.edits,
        dropped: specialized.dropped,
        unrendered: () =>
          specialized
            .unrendered()
            .map((source) => path.posix.join(path.posix.dirname(key), source)),
      });
    }
    // The plugins check that nothing outside `content` renders these.
    for (const file of appUsage.closed) {
      const scope = appUsage.scopeFor(file);
      if (!scope) continue;
      const specialized = specializeComponent(scope, input.options);
      appRewrites.push({ file, edits: specialized.edits });
      if (specialized.edits > 0)
        serve(realpath(file) ?? file, scope, specialized);
    }
  } catch (error) {
    return { warning: failure(input.library, error, input.failure) };
  }
  const read = new Map(
    [...appUsage.read].map(([file, usage]) => [realpath(file) ?? file, usage]),
  );
  return {
    sources,
    edits,
    closed: appUsage.closed,
    readImport: (importer, id) => {
      const key = library.importKey(id);
      return !key || readLibraryImport(library, read.get(importer), key);
    },
    apps: appRewrites.filter((rewrite) => rewrite.edits > 0).length,
    report: () =>
      formatSpecializeReport(
        result,
        rewrites,
        appRewrites,
        input.projectRoot,
        input.failure.feature,
      ),
  };
}

type ComponentRewrite = {
  key: string;
  edits: number;
  dropped: number;
  /** Module keys of the children it no longer renders. */
  unrendered: () => string[];
};

function formatSpecializeReport(
  result: UsageResult,
  rewrites: ComponentRewrite[],
  appRewrites: Array<{ file: string; edits: number }>,
  root: string,
  feature: string,
): string[] {
  const name = (key: string) => nameOf(result, key);
  const { spec } = result.library;
  const changed = rewrites
    .filter((rewrite) => rewrite.edits > 0)
    .sort((a, b) => b.edits - a.edits || a.key.localeCompare(b.key));
  const edits = changed.reduce((sum, rewrite) => sum + rewrite.edits, 0);
  const dropped = changed.reduce((sum, rewrite) => sum + rewrite.dropped, 0);
  const width = Math.max(0, ...changed.map(({ key }) => name(key).length));
  const unbundled = new Set(
    changed.flatMap(({ unrendered }) =>
      unrendered().filter((key) => !result.analysis.liveComponents.has(key)),
    ),
  );

  const lines = [
    "",
    `${feature} report`,
    `  Rewrote ${changed.length} of ${rewrites.length} ${spec.label} components (${edits} edits, ${dropped} declarations dropped):`,
  ];
  for (const rewrite of changed) {
    const stops =
      rewrite.unrendered().length > 0
        ? `   no longer renders ${rewrite.unrendered().map(name).join(", ")}`
        : "";
    lines.push(
      `    ${name(rewrite.key).padEnd(width)}   ${String(rewrite.edits).padStart(4)} edit${rewrite.edits === 1 ? " " : "s"}${stops}`,
    );
  }
  const appChanged = appRewrites
    .filter((rewrite) => rewrite.edits > 0)
    .map((rewrite) => ({ ...rewrite, name: path.relative(root, rewrite.file) }))
    .sort((a, b) => b.edits - a.edits || a.name.localeCompare(b.name));
  if (appRewrites.length > 0) {
    lines.push(
      `  Rewrote ${appChanged.length} of ${appRewrites.length} app components whose every call site is known:`,
    );
    const appWidth = Math.max(0, ...appChanged.map(({ name }) => name.length));
    for (const rewrite of appChanged) {
      lines.push(
        `    ${rewrite.name.padEnd(appWidth)}   ${String(rewrite.edits).padStart(4)} edit${rewrite.edits === 1 ? "" : "s"}`,
      );
    }
  }
  lines.push(
    `  No longer bundled (${unbundled.size}): ${[...unbundled].map(name).sort().join(", ") || "none"}`,
    "  Call sites:",
    ...formatCallSites(result, root),
  );
  return lines;
}
