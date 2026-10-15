import path from "node:path";
import { lexImportsExports } from "sveast/lexer";
import { type AST, type Expression, forEachChild, locate } from "sveast/walk";
import { forEachNode, type Node, parse } from "./ast";
import { buildComponentModel, type ComponentModel } from "./component-model";
import {
  bindEach,
  createScope,
  evaluate,
  type Scope,
  spreadProps,
  whyUnknownLater,
} from "./evaluate";
import { type Export, memberOf, UNKNOWN_EXPORT } from "./exports";
import type { Library } from "./library";
import {
  callSiteFromElement,
  instanceMembers,
  type SiteReader,
} from "./live-walk";
import { type CallSite, type ComponentUsage, newComponentUsage } from "./usage";
import { importKey } from "./util";
import {
  EMPTY_ARRAY,
  isEmptyArray,
  OBJECT,
  possible,
  truthOf,
  UNDEFINED,
  UNKNOWN,
  type Value,
} from "./values";

export type ModuleUsage = {
  /** Library keys (`Button/Button.svelte`), or absolute paths of app files. */
  sites: CallSite[];
  /** Every bundled library component may render with any props. */
  openAll: boolean;
  /** A `.svelte` import it can't follow: every app component is open. */
  openApps?: boolean;
  /** Every `contextKeyPrefix` string, not just `setContext` arguments. */
  providedContexts: Set<string>;
  /** It may pass `setContext` a library key it doesn't spell out. */
  providesUnknownContext?: boolean;
  /** It may read a library context, and so write to the stores one hands on. */
  readsLibraryContext?: boolean;
  file?: string;
  libraryImports?: LibraryImports;
};

type LibraryImports = {
  components: Set<string>;
  barrel: boolean;
};

/** False for a module-graph edge the analysis can't see (an alias). */
export function readLibraryImport(
  library: Library,
  usage: ModuleUsage | undefined,
  key: string,
): boolean {
  if (usage?.openAll) return true;
  const imports = usage?.libraryImports;
  if (!imports) return false;
  return key === library.barrelKey
    ? imports.barrel
    : imports.components.has(key);
}

type AppComponents = {
  readonly files: ReadonlySet<string>;
  /** File name -> files, for imports through an alias (`$lib/X.svelte`). */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  /** Aliased imports the bundler resolved, by `importKey(from, source)`. */
  readonly resolved?: ReadonlyMap<string, string>;
};

export function indexAppComponents(
  files: Iterable<string>,
  resolved?: ReadonlyMap<string, string>,
): AppComponents {
  const byName = new Map<string, string[]>();
  const set = new Set<string>();
  for (const file of files) {
    set.add(file);
    const name = path.basename(file);
    const named = byName.get(name);
    if (named) named.push(file);
    else byName.set(name, [file]);
  }
  return { files: set, byName, resolved };
}

/** App component keys are absolute paths; library ones are relative. */
export function isAppComponent(key: string): boolean {
  return path.isAbsolute(key);
}

type AppImports = { readonly from: string; readonly apps: AppComponents };

/**
 * Exact only for a known relative or bundler-resolved path. An alias matches
 * every file of that name; `./Card` may be `Card.svelte` or
 * `Card/index.svelte`, if the bundler adds the extension.
 */
function resolveAppImport(
  library: Library,
  { from, apps }: AppImports,
  source: string,
): { keys: readonly string[]; exact: boolean } | undefined {
  if (source.startsWith(library.srcPrefix)) return undefined;
  const relative = source.startsWith(".");
  const name = path.posix.basename(source);
  if (source.endsWith(".svelte")) {
    if (relative) {
      const file = path.resolve(path.dirname(from), source);
      return apps.files.has(file) ? { keys: [file], exact: true } : undefined;
    }
    const resolved = apps.resolved?.get(importKey(from, source));
    if (resolved && apps.files.has(resolved)) {
      return { keys: [resolved], exact: true };
    }
    const keys = apps.byName.get(name);
    return keys ? { keys, exact: false } : undefined;
  }
  let keys: readonly string[];
  if (relative) {
    const file = path.resolve(path.dirname(from), source);
    keys = [`${file}.svelte`, path.join(file, "index.svelte")].filter((key) =>
      apps.files.has(key),
    );
  } else {
    keys = [
      ...(apps.byName.get(`${name}.svelte`) ?? []),
      ...(apps.byName.get("index.svelte") ?? []).filter(
        (key) => path.basename(path.dirname(key)) === name,
      ),
    ];
  }
  return keys.length > 0 ? { keys, exact: false } : undefined;
}

const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(/g;
/** The literal argument of an `import(`, read from where it ends. */
const LITERAL_IMPORT = /\s*(["'`])([^"'`$]+)\1\s*\)/y;
const IMPORT_META_GLOB = /\bimport\.meta\.glob\b/;

/** The lexer skips `import()`, `require()`, `import.meta.glob`: all open. */
function readDynamicImports(
  code: string,
  library: Library,
  bindings: ImportBindings,
  app: AppImports | undefined,
): void {
  if (!code.includes("import") && !code.includes("require")) return;
  if (IMPORT_META_GLOB.test(code)) bindings.openApps = true;
  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    const start = match.index + match[0].length;
    LITERAL_IMPORT.lastIndex = start;
    const source = LITERAL_IMPORT.exec(code)?.[2];
    if (source === undefined) {
      bindings.openApps = true;
      library.patterns.argument.lastIndex = start;
      if (library.patterns.argument.test(code)) bindings.openAll = true;
      continue;
    }
    if (source === library.name) {
      bindings.openAll = true;
      bindings.libraryImports.barrel = true;
    }
    const direct = library.patterns.directComponentPath.exec(source)?.[1];
    if (direct) {
      bindings.dynamic.push(direct);
      bindings.libraryImports.components.add(direct);
    }
    const resolved = app && resolveAppImport(library, app, source);
    if (resolved) bindings.openAppComponents.push(...resolved.keys);
  }
}

/** The modules `lexImportsExports` reads. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const IMPORT_AS = /\s+as\s+/;
const SVELTE_SPECIFIER = /(["'])([^"'\n]+\.svelte)\1/g;

/**
 * A `setContext` key may be one `providedContexts` can't see: held by the
 * library's script modules, or built from parts (`prefix + name`).
 */
function contextUsage(
  library: Library,
  code: string,
): Pick<
  ModuleUsage,
  "providedContexts" | "providesUnknownContext" | "readsLibraryContext"
> {
  const prefix = library.spec.contextKeyPrefix;
  const keys = code.includes(prefix)
    ? [...code.matchAll(library.patterns.contextKey)].map((match) => match[2])
    : [];
  const importsScript = () => library.patterns.scriptSpecifier.test(code);
  return {
    providedContexts: new Set(keys),
    providesUnknownContext:
      code.includes("setContext") &&
      (importsScript() || code.split(prefix).length - 1 > keys.length),
    readsLibraryContext:
      code.includes("getAllContexts") ||
      (code.includes("getContext") &&
        (code.includes(prefix) || importsScript())),
  };
}

type ImportBindings = {
  /** Local binding -> library component key, or app component file. */
  components: Map<string, string>;
  /** Library bindings that aren't one component (`import * as C`). */
  exports: Map<string, Export>;
  /** Bindings known to hold a component (library, icons, local `.svelte`). */
  objects: Set<string>;
  /** Re-exported library components: rendered somewhere we can't see. */
  reExported: string[];
  dynamic: string[];
  /** Any library component may render (`export *`, dynamic barrel import). */
  openAll: boolean;
  /** Imported dynamically, re-exported, or ambiguously: any props. */
  openAppComponents: string[];
  openApps: boolean;
  libraryImports: LibraryImports;
};

function newBindings(): ImportBindings {
  return {
    components: new Map(),
    exports: new Map(),
    objects: new Set(),
    reExported: [],
    dynamic: [],
    openAll: false,
    openAppComponents: [],
    openApps: false,
    libraryImports: { components: new Set(), barrel: false },
  };
}

function readImports(
  code: string,
  library: Library,
  bindings: ImportBindings,
  app: AppImports | undefined,
): void {
  if (
    !code.includes(library.name) &&
    !(app && (code.includes("import") || code.includes("export")))
  ) {
    return;
  }
  for (const statement of lexImportsExports(code)) {
    const from = statement.source?.value;
    if (!from || statement.typeOnly) continue;
    const isBarrel = from === library.name;
    const directKey = library.patterns.directComponentPath.exec(from)?.[1];
    const appImport = app && resolveAppImport(library, app, from);
    if (isBarrel) bindings.libraryImports.barrel = true;
    if (directKey) bindings.libraryImports.components.add(directKey);

    if (statement.kind === "export") {
      for (const specifier of statement.specifiers) {
        if (specifier.typeOnly) continue;
        if (isBarrel && specifier.kind !== "named") bindings.openAll = true;
        const exported = isBarrel ? library.exportOf(specifier.local) : null;
        if (exported && exported.kind !== "component") {
          if (exported.kind !== "value") bindings.openAll = true;
          continue;
        }
        const key = exported ? exported.key : directKey;
        if (key) {
          bindings.reExported.push(key);
          bindings.libraryImports.components.add(key);
        }
      }
      if (appImport) bindings.openAppComponents.push(...appImport.keys);
      continue;
    }

    const isComponent = library.patterns.componentSource.test(from);
    for (const specifier of statement.specifiers) {
      if (specifier.typeOnly) continue;
      if (isComponent) bindings.objects.add(specifier.local);
      if (appImport) {
        if (appImport.exact && specifier.kind === "default") {
          bindings.components.set(specifier.local, appImport.keys[0]);
        } else {
          bindings.openAppComponents.push(...appImport.keys);
        }
      } else if (isBarrel) {
        const exported: Export =
          specifier.kind === "namespace"
            ? { kind: "members", member: (name) => library.exportOf(name) }
            : library.exportOf(specifier.imported);
        if (exported.kind === "component") {
          bindings.components.set(specifier.local, exported.key);
          bindings.libraryImports.components.add(exported.key);
        } else if (exported.kind !== "value") {
          bindings.exports.set(specifier.local, exported);
        }
      } else if (directKey && specifier.kind === "default") {
        bindings.components.set(specifier.local, directKey);
      }
    }
  }
}

function openSite(
  component: string,
  file: string,
  reason: string,
  line = 1,
): CallSite {
  return {
    component,
    open: true,
    props: new Map(),
    slots: null,
    location: { file, line },
    reason,
  };
}

/** Script modules only use components as values, so every one is open. */
export function collectScriptUsage(
  code: string,
  file: string,
  library: Library,
  apps?: AppComponents,
): ModuleUsage {
  const bindings = newBindings();
  const app = apps && { from: file, apps };
  readImports(code, library, bindings, app);
  readDynamicImports(code, library, bindings, app);
  return {
    sites: [
      ...bindings.components.values(),
      ...bindings.reExported,
      ...bindings.dynamic,
      ...bindings.openAppComponents,
    ].map((key) => openSite(key, file, "used from a script module")),
    openAll: bindings.exports.size > 0 || bindings.openAll,
    openApps: bindings.openApps,
    ...contextUsage(library, code),
    file,
    libraryImports: bindings.libraryImports,
  };
}

/**
 * For files the analysis can't parse, from text alone: components imported
 * by name or path are open; any other mention of the package opens all.
 */
export function collectImportedUsage(
  code: string,
  file: string,
  library: Library,
  reason: string,
  apps?: AppComponents,
): ModuleUsage {
  const bindings = newBindings();
  const app = apps && { from: file, apps };
  readDynamicImports(code, library, bindings, app);
  const usage: ModuleUsage = {
    sites: bindings.dynamic.map((key) => openSite(key, file, reason)),
    openAll: bindings.openAll,
    ...contextUsage(library, code),
    file,
    libraryImports: bindings.libraryImports,
  };
  if (app) {
    // Every `.svelte` path it names, imported or not, renders with any props.
    usage.openApps = bindings.openApps;
    for (const match of code.matchAll(SVELTE_SPECIFIER)) {
      for (const key of resolveAppImport(library, app, match[2])?.keys ?? []) {
        usage.sites.push(
          openSite(key, file, reason, locate(code, match.index).line),
        );
      }
    }
    for (const key of bindings.openAppComponents) {
      usage.sites.push(openSite(key, file, reason));
    }
  }
  if (!code.includes(library.name)) return usage;

  const understood = new Set<number>();
  for (const match of code.matchAll(library.patterns.barrelImport)) {
    understood.add(match.index + match[0].length - library.name.length - 2);
    if (match[1]) continue; // `import type { … }`
    for (const specifier of match[2].split(",")) {
      const name = specifier.trim();
      if (name === "" || name.startsWith("type ")) continue;
      const exported = library.exportOf(name.split(IMPORT_AS)[0]);
      if (exported.kind === "component") {
        usage.sites.push(
          openSite(exported.key, file, reason, locate(code, match.index).line),
        );
        bindings.libraryImports.components.add(exported.key);
      } else if (exported.kind !== "value") {
        usage.openAll = true;
      }
    }
  }
  for (const match of code.matchAll(library.patterns.barrelSpecifier)) {
    bindings.libraryImports.barrel = true;
    if (!understood.has(match.index)) usage.openAll = true;
  }
  for (const match of code.matchAll(
    library.patterns.directComponentSpecifier,
  )) {
    usage.sites.push(
      openSite(match[1], file, reason, locate(code, match.index).line),
    );
    bindings.libraryImports.components.add(match[1]);
  }
  return usage;
}

export function collectSourceUsage(
  code: string,
  file: string,
  library: Library,
  apps?: AppComponents,
): ModuleUsage {
  if (file.endsWith(".svelte")) {
    return collectSvelteUsage(code, file, library, { apps });
  }
  if (SCRIPT_FILE.test(file)) {
    return collectScriptUsage(code, file, library, apps);
  }
  return collectImportedUsage(
    code,
    file,
    library,
    "not a Svelte or script file",
    apps,
  );
}

/** Falls back to literals alone where the component can't be modeled. */
function appEvaluator(
  code: string,
  ast: AST.Root,
  file: string,
  objects: ReadonlySet<string>,
  library: Library,
  options: SvelteUsageOptions,
): SiteReader & { bindEach: (node: AST.EachBlock) => () => void } {
  let scope: Scope | undefined;
  try {
    const model =
      options.model ?? buildComponentModel(code, file, undefined, ast);
    const usage = options.usage ?? newComponentUsage(true);
    scope = appScope(model, file, usage, options.constants, library);
  } catch {
    // Not modeled: literals alone.
  }
  return {
    value: (expression) => {
      // A component passed as a prop (`icon={Add}`) is an object.
      if (expression.type === "Identifier" && objects.has(expression.name)) {
        return possible(OBJECT);
      }
      return scope
        ? evaluate(expression, scope)
        : staticValue(expression, objects);
    },
    // A wrapper's `{...$$restProps}`: what its own call sites pass.
    spread: (argument) => (scope ? spreadProps(argument, scope) : undefined),
    explain: (expression) =>
      scope ? whyUnknownLater(expression, scope) : () => "isn't a literal",
    bindEach: (node) => (scope ? bindEach(node, scope) : () => {}),
    instance: (expression) =>
      scope ? instanceMembers(expression, scope.model.scopes) : null,
  };
}

/** Constants imported from the app's modules are known; context isn't. */
export function appScope(
  model: ComponentModel,
  file: string,
  usage: ComponentUsage,
  constants: ModuleConstants | undefined,
  library: Library,
): Scope {
  return createScope(model, usage, () => UNKNOWN, {
    imported: importedConstants(model, file, constants),
    svelteMajor: library.svelteMajor,
  });
}

const MODULE_EXTENSIONS = [
  "",
  ".ts",
  ".js",
  ".mts",
  ".mjs",
  "/index.ts",
  "/index.js",
];

function importedConstants(
  model: ComponentModel,
  file: string,
  constants: ModuleConstants | undefined,
): Map<string, Value> {
  const values = new Map<string, Value>();
  if (!constants) return values;
  for (const script of [model.ast.module, model.ast.instance]) {
    for (const statement of script?.content.body ?? []) {
      if (statement.type !== "ImportDeclaration") continue;
      const source = String(statement.source.value);
      if (!source.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), source);
      const exports = MODULE_EXTENSIONS.map((ext) =>
        constants(base + ext),
      ).find(Boolean);
      if (!exports) continue;
      for (const specifier of statement.specifiers) {
        if (
          specifier.type !== "ImportSpecifier" ||
          specifier.imported.type !== "Identifier"
        ) {
          continue;
        }
        const value = exports.get(specifier.imported.name);
        if (value) values.set(specifier.local.name, value);
      }
    }
  }
  return values;
}

type SvelteUsageOptions = {
  /** The app's `.svelte` files: sites of these are collected too. */
  apps?: AppComponents;
  /** How this component is rendered; by default, with any props. */
  usage?: ComponentUsage;
  model?: ComponentModel;
  constants?: ModuleConstants;
};

export type ModuleConstants = (
  file: string,
) => ReadonlyMap<string, Value> | undefined;

function staticValue(
  expression: Expression,
  objects: ReadonlySet<string>,
): Value {
  switch (expression.type) {
    case "Literal":
      if ("regex" in expression && expression.regex) return possible(OBJECT);
      return typeof expression.value === "bigint"
        ? UNKNOWN
        : possible(expression.value as string | number | boolean | null);
    case "TemplateLiteral":
      return expression.expressions.length === 0
        ? possible(expression.quasis[0].value.cooked ?? "")
        : UNKNOWN;
    case "Identifier":
      if (expression.name === "undefined") return UNDEFINED;
      return objects.has(expression.name) ? possible(OBJECT) : UNKNOWN;
    case "ArrayExpression":
      return possible(expression.elements.length === 0 ? EMPTY_ARRAY : OBJECT);
    case "ObjectExpression":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return possible(OBJECT);
    default:
      return UNKNOWN;
  }
}

/**
 * A component used as a value, spread into, or imported but never rendered
 * as a tag is open; a file that doesn't parse opens all its imports.
 */
export function collectSvelteUsage(
  code: string,
  file: string,
  library: Library,
  options: SvelteUsageOptions = {},
): ModuleUsage {
  const { apps } = options;
  // With the app's components, every file is walked: one can render
  // another, or itself, in ways no text check can rule out.
  if (!apps && !code.includes(library.name)) {
    return { sites: [], openAll: false, ...contextUsage(library, code), file };
  }

  let ast: AST.Root;
  try {
    ast = options.model?.ast ?? parse(code, { comments: false, css: false });
  } catch {
    return collectImportedUsage(
      code,
      file,
      library,
      "could not be parsed",
      apps,
    );
  }

  const bindings = newBindings();
  const app = apps && { from: file, apps };
  for (const script of [ast.module, ast.instance]) {
    if (script) {
      readImports(
        code.slice(script.content.start, script.content.end),
        library,
        bindings,
        app,
      );
    }
  }
  // The markup too: `{#await import("…")}`.
  readDynamicImports(code, library, bindings, app);

  const usage: ModuleUsage = {
    sites: [
      ...bindings.reExported.map((key) => openSite(key, file, "re-exported")),
      ...bindings.dynamic.map((key) =>
        openSite(key, file, "imported dynamically"),
      ),
      ...bindings.openAppComponents.map((key) =>
        openSite(key, file, "imported dynamically or through an alias"),
      ),
    ],
    openAll: bindings.openAll,
    openApps: bindings.openApps,
    ...contextUsage(library, code),
    file,
    libraryImports: bindings.libraryImports,
  };
  const rendered = new Set<string>();
  const line = (node: { start: number }) => locate(code, node.start).line;
  const props = appEvaluator(
    code,
    ast,
    file,
    bindings.objects,
    library,
    options,
  );
  const pushSite = (node: AST.Component | AST.SvelteSelf, key: string) => {
    const site = callSiteFromElement(node, key, {
      ...props,
      explain: (expression) => {
        const why = props.explain(expression);
        return () => {
          const reason = why();
          return reason && `${path.basename(file)}:${line(node)} ${reason}`;
        };
      },
    });
    site.location = { file, line: line(node) };
    usage.sites.push(site);
  };

  /** Marks the components a branch that can't render names, without sites. */
  const markRendered = (node: Node): void => {
    forEachNode(node, (inner) => {
      if (inner.type === "Component") rendered.add(inner.name.split(".")[0]);
      if (
        inner.type === "Identifier" &&
        (bindings.components.has(inner.name) ||
          bindings.exports.has(inner.name))
      ) {
        rendered.add(inner.name);
      }
    });
  };

  const visit = (node: Node, parent: Node | null): void => {
    switch (node.type) {
      case "ImportDeclaration":
        return;

      // A branch that can't render passes nothing to what it holds.
      case "IfBlock": {
        visit(node.test, node);
        const truth = truthOf(props.value(node.test));
        if (truth === "falsy") markRendered(node.consequent);
        else visit(node.consequent, node);
        if (node.alternate) {
          if (truth === "truthy") markRendered(node.alternate);
          else visit(node.alternate, node);
        }
        return;
      }

      case "EachBlock": {
        visit(node.expression, node);
        if (isEmptyArray(props.value(node.expression))) {
          markRendered(node.body);
        } else {
          const unbind = props.bindEach(node);
          try {
            if (node.key) visit(node.key, node);
            visit(node.body, node);
          } finally {
            unbind();
          }
        }
        if (node.fallback) visit(node.fallback, node);
        return;
      }

      case "Component": {
        const [root, ...members] = node.name.split(".");
        const exported = bindings.exports.get(root);
        let key: string | undefined;
        if (exported) {
          rendered.add(root);
          const rendering = memberOf(exported, members);
          if (rendering.kind === "unknown") usage.openAll = true;
          else if (rendering.kind === "component") key = rendering.key;
        } else if (members.length === 0) {
          key = bindings.components.get(node.name);
        }
        if (key) {
          rendered.add(root);
          pushSite(node, key);
        }
        break;
      }

      case "SvelteSelf":
        if (apps) pushSite(node, file);
        break;

      case "Identifier": {
        const key = bindings.components.get(node.name);
        if (key) {
          rendered.add(node.name);
          usage.sites.push(openSite(key, file, "used as a value", line(node)));
          return;
        }
        const exported = bindings.exports.get(node.name);
        if (!exported) return;
        rendered.add(node.name);
        // `C.Button` as a value: that component, with any props.
        const member =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === "Identifier"
            ? memberOf(exported, [parent.property.name])
            : UNKNOWN_EXPORT;
        if (member.kind === "component") {
          usage.sites.push(
            openSite(member.key, file, "used as a value", line(node)),
          );
        } else if (member.kind !== "value") {
          usage.openAll = true;
        }
        return;
      }
    }
    forEachChild(node, (child) => visit(child, node));
  };

  for (const node of [ast.module, ast.instance, ast.fragment]) {
    if (node) visit(node, null);
  }

  for (const local of bindings.exports.keys()) {
    if (!rendered.has(local)) usage.openAll = true;
  }
  for (const [local, key] of bindings.components) {
    if (!rendered.has(local)) {
      usage.sites.push(
        openSite(key, file, `${local} is imported but not rendered as a tag`),
      );
    }
  }

  return usage;
}
