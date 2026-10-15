import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyzeScopes, type Binding, type Scopes } from "sveast/scope";
import {
  type AST,
  type Expression,
  extractIdentifiers,
  type Identifier,
  isReference,
  locate,
  type Pattern,
  type VariableDeclarator,
  walk,
} from "sveast/walk";
import { forEachNode, type Node, parse } from "./ast";
import {
  createExportResolver,
  type Export,
  type ExportResolver,
} from "./exports";

function markUnknown(
  model: ComponentModel,
  pattern: Pattern,
  reason: string,
): void {
  for (const { name } of extractIdentifiers(pattern)) {
    markNameUnknown(model, name, reason);
  }
}

function markNameUnknown(
  model: ComponentModel,
  name: string,
  reason: string,
): void {
  model.unknownNames.add(name);
  if (!model.unknownReasons.has(name)) model.unknownReasons.set(name, reason);
}

/** A top-level `function` declaration: some object, never re-bound. */
export const FUNCTION_DECLARATION = "function";

export type FunctionNode = Extract<
  Node,
  {
    type:
      | "FunctionDeclaration"
      | "FunctionExpression"
      | "ArrowFunctionExpression";
  }
>;

type Helper = { model: ComponentModel; fn: FunctionNode };

export type ComponentModel = {
  /** Path relative to the library's `srcDir`, e.g. `Button/Button.svelte`. */
  readonly key: string;
  readonly code: string;
  readonly ast: AST.Root;
  readonly scopes: Scopes;
  readonly props: Map<string, Expression | null>;
  /** Local name -> the name a parent passes it by (`class` for `className`). */
  readonly propNames: Map<string, string>;
  /** `<svelte:options customElement>`: any renderer can set its props. */
  readonly customElement: boolean;
  /** Top-level `let`/`const`, functions, and `$: x = …` declarations. */
  readonly declarations: Map<
    string,
    Expression | null | typeof FUNCTION_DECLARATION
  >;
  readonly functions: Map<string, FunctionNode>;
  /** The `$: x = …` assignments that define a declaration above. */
  readonly reactiveDeclarations: WeakSet<Node>;
  /** Top-level names written outside their declaration (handlers, `bind:`). */
  readonly unknownNames: Set<string>;
  readonly unknownReasons: Map<string, string>;
  /** Names written only by `name = …` under `if`s in `$:` (see `withGuardedWrites`). */
  readonly guardedWrites: Map<string, GuardedWrite[]>;
  /** Local binding -> library module key, for relative `.svelte` imports. */
  readonly componentImports: Map<string, string>;
  readonly otherImports: Set<string>;
  readonly packageImports: Map<string, string>;
  /** Library objects with component members (`import * as L`, `Object.assign`). */
  readonly memberImports: Map<string, Export>;
  /** Imported `export const NAME = "…"` strings, for context keys. */
  readonly importedStrings: Map<string, string>;
  /** Imported functions of library `.js` modules, read when first called. */
  readonly importedHelpers: Map<string, () => Helper | undefined>;
  /** Local name -> `svelte/store` export. */
  readonly storeImports: Map<string, string>;
  readonly providedContexts: Set<string>;
  providesUnknownContext: boolean;
  /** Per `setContext` call: an object literal's properties, or `null`. */
  readonly contextObjects: Map<
    string,
    Array<Map<string, MirroredStore | null> | null>
  >;
  /** Context properties it may write or hand on (`"*"`: all); see `readContextUse`. */
  readonly contextLeaks: Map<string, Set<string>>;
  readsUnknownContext: boolean;
  /**
   * Decides whether a literal a name holds stays known (see `Shape`).
   * `$$props.x` adds `"$$props.x"`, any other `$$props` use `"*"`, both `full`.
   */
  readonly escapes: Map<string, Escape>;
  /** `rest` in `let { a, ...rest } = $props()`, unless reassigned. */
  restPropsName?: string;
};

/**
 * `full`: the value is mutated, aliased, passed on or has a method called.
 * `paths`: paths read from it (`["[]", "text"]` for `item.text` in `{#each}`).
 */
type Escape = { full: boolean; readonly paths: string[][] };

type Guard = { readonly test: Expression; readonly holds: boolean };

export type GuardedWrite = {
  readonly guards: readonly Guard[];
  readonly value: Expression;
  readonly line: number;
};

/**
 * A `writable` set only from `$:` and handed on only in a context object, so
 * it holds `initial` or one of `writes`. `readOnly`: handed on as `readonly(s)`.
 */
export type MirroredStore = {
  readonly initial: Expression | null;
  readonly writes: readonly Expression[];
  readonly readOnly: boolean;
};

export class UnsupportedComponentError extends Error {}

const VALUE_RUNES = new Set(["$state", "$state.raw", "$derived"]);

function runeCall(
  model: ComponentModel,
  declarator: VariableDeclarator,
): { rune: string; argument: Expression | null } | undefined {
  const [id] = extractIdentifiers(declarator.id);
  const rune = id && model.scopes.bindingOf(id)?.rune;
  const { init } = declarator;
  if (!rune || init?.type !== "CallExpression") return undefined;
  const [first] = init.arguments;
  return {
    rune,
    argument: first && first.type !== "SpreadElement" ? first : null,
  };
}

const cache = new Map<string, { mtimeMs: number; model: ComponentModel }>();

/** Cached by path and mtime, so a library edited under `--watch` reloads. */
export function loadComponentModel(src: string, key: string): ComponentModel {
  const file = path.join(src, key);
  const { mtimeMs } = statSync(file);
  const cached = cache.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.model;
  const model = buildComponentModel(
    readFileSync(file, "utf8"),
    key,
    libraryResolver(src),
  );
  cache.set(file, { mtimeMs, model });
  return model;
}

/** A `.js` module's mtime is checked once per analysis, not per helper call. */
let analysisCount = 0;

export function recheckScriptModels(): void {
  analysisCount++;
}

const exportResolvers = new Map<
  string,
  { checked: number; resolver: ExportResolver }
>();

function exportsUnder(src: string): ExportResolver {
  let cached = exportResolvers.get(src);
  if (cached?.checked !== analysisCount) {
    cached = { checked: analysisCount, resolver: createExportResolver(src) };
    exportResolvers.set(src, cached);
  }
  return cached.resolver;
}

function libraryResolver(src: string): ImportResolver {
  return (from, source, name) => {
    const exported = exportsUnder(src).importOf(from, source, name);
    if (exported.kind === "component") return { component: exported.key };
    if (exported.kind === "members") return { members: exported };
    if (name === "*") return undefined;
    const module = scriptModule(src, from, source);
    if (!module) return undefined;
    const string = stringExport(src, module, name);
    return string !== undefined
      ? { string }
      : { helper: () => loadHelper(src, module, name) };
  };
}

function scriptModule(
  src: string,
  from: string,
  source: string,
): string | undefined {
  const joined = path.posix.join(path.posix.dirname(from), source);
  return [joined, `${joined}.js`].find(
    (candidate) =>
      candidate.endsWith(".js") && existsSync(path.join(src, candidate)),
  );
}

const scriptCache = new Map<
  string,
  { mtimeMs: number; checked: number; model: ComponentModel | undefined }
>();

/** What a `.js` module's model wraps its code in: offsets in it are shifted by its length. */
export const SCRIPT_MODULE_PREFIX = '<script context="module">\n';

/** An importer may change any name a `.js` module exports, so those all escape. */
export function loadScriptModel(
  src: string,
  key: string,
): ComponentModel | undefined {
  const file = path.join(src, key);
  const cached = scriptCache.get(file);
  if (cached?.checked === analysisCount) return cached.model;
  const { mtimeMs } = statSync(file);
  if (cached?.mtimeMs === mtimeMs) {
    cached.checked = analysisCount;
    return cached.model;
  }
  let model: ComponentModel | undefined;
  try {
    model = buildComponentModel(
      `${SCRIPT_MODULE_PREFIX}${readFileSync(file, "utf8")}\n</script>`,
      key,
      libraryResolver(src),
    );
    for (const statement of model.ast.module?.content.body ?? []) {
      if (statement.type !== "ExportNamedDeclaration") continue;
      const names = statement.declaration
        ? statement.declaration.type === "VariableDeclaration"
          ? statement.declaration.declarations.flatMap((declarator) =>
              extractIdentifiers(declarator.id),
            )
          : []
        : statement.specifiers.flatMap((specifier) =>
            specifier.local.type === "Identifier" ? [specifier.local] : [],
          );
      for (const { name } of names) {
        model.escapes.set(name, { full: true, paths: [] });
      }
    }
  } catch {
    model = undefined;
  }
  scriptCache.set(file, { mtimeMs, checked: analysisCount, model });
  return model;
}

function loadHelper(
  src: string,
  key: string,
  name: string,
): Helper | undefined {
  const model = loadScriptModel(src, key);
  // A function the module reassigns may not be the one declared.
  if (!model || model.unknownNames.has(name)) return undefined;
  for (const statement of model.ast.module?.content.body ?? []) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const { declaration } = statement;
    if (declaration?.type === "FunctionDeclaration") {
      if (declaration.id?.name === name) return { model, fn: declaration };
    } else if (
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
    ) {
      for (const { id, init } of declaration.declarations) {
        if (
          id.type === "Identifier" &&
          id.name === name &&
          (init?.type === "ArrowFunctionExpression" ||
            init?.type === "FunctionExpression")
        ) {
          return { model, fn: init };
        }
      }
    }
  }
  return undefined;
}

/** `name` is `"*"` for a namespace import. */
type ImportResolver = (
  from: string,
  source: string,
  name: string,
) =>
  | { component: string }
  | { members: Export }
  | { string: string }
  | { helper: () => Helper | undefined }
  | undefined;

/** Only a lone-line `export const name = "…"`, declared once; no re-exports. */
function stringExport(
  src: string,
  module: string,
  name: string,
): string | undefined {
  const code = readFileSync(path.join(src, module), "utf8");
  const declaration = new RegExp(
    `^export const ${name.replaceAll("$", "\\$")} = (["'])([^"'\\\\\\n]*)\\1;?[ \\t]*$`,
    "gm",
  );
  const matches = [...code.matchAll(declaration)];
  return matches.length === 1 ? matches[0][2] : undefined;
}

export function buildComponentModel(
  code: string,
  key: string,
  resolveImport: ImportResolver = () => undefined,
  parsed?: AST.Root,
): ComponentModel {
  const ast = parsed ?? parse(code, { comments: false, css: false });
  const model: ComponentModel = {
    key,
    code,
    ast,
    scopes: analyzeScopes(ast),
    props: new Map(),
    propNames: new Map(),
    customElement:
      ast.options?.attributes.some(
        (attribute) => attribute.name === "customElement",
      ) ?? false,
    declarations: new Map(),
    functions: new Map(),
    reactiveDeclarations: new WeakSet(),
    unknownNames: new Set(),
    unknownReasons: new Map(),
    guardedWrites: new Map(),
    componentImports: new Map(),
    otherImports: new Set(),
    packageImports: new Map(),
    memberImports: new Map(),
    importedStrings: new Map(),
    importedHelpers: new Map(),
    storeImports: new Map(),
    providedContexts: new Set(),
    providesUnknownContext: false,
    contextObjects: new Map(),
    contextLeaks: new Map(),
    readsUnknownContext: false,
    escapes: findEscapes(ast),
  };

  /** Instance-script `let` names: a later `export { … }` can make them props. */
  const letDeclarations = new Set<string>();
  for (const script of [ast.module, ast.instance]) {
    if (!script) continue;
    const isInstance = script === ast.instance;
    for (const statement of script.content.body) {
      readTopLevelStatement(
        model,
        statement,
        isInstance,
        resolveImport,
        isInstance ? letDeclarations : undefined,
      );
    }
  }

  // `let a; export { a as b }` declares prop `b`; after `export let a`,
  // it renames prop `a` to `b` (Svelte 3–5 read only `b`).
  for (const statement of ast.instance?.content.body ?? []) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration ||
      statement.source
    ) {
      continue;
    }
    for (const { local, exported } of statement.specifiers) {
      if (local.type !== "Identifier") continue;
      if (!model.props.has(local.name)) {
        if (!letDeclarations.has(local.name)) continue;
        const init = model.declarations.get(local.name);
        model.declarations.delete(local.name);
        model.props.set(
          local.name,
          init === FUNCTION_DECLARATION ? null : (init ?? null),
        );
      }
      model.propNames.set(
        local.name,
        exported.type === "Identifier" ? exported.name : String(exported.value),
      );
    }
  }

  // Writing identifier -> the name it makes unknown (`$count = 1`: `$count`).
  const writes = new Map<Identifier, string>();
  for (const binding of topLevelBindings(model.scopes)) {
    // `x` in `$: x = …` declares it, so it's no reference; it's a write
    // unless the model reads it as the definition (`reactiveDeclarations`).
    if (binding.kind === "reactive" && binding.node) {
      writes.set(binding.node, binding.name);
    }
    for (const reference of binding.references) {
      if (reference.writes || reference.mutates) {
        writes.set(
          reference.node,
          reference.store ? `$${binding.name}` : binding.name,
        );
      }
    }
  }
  /** A rest name written after its declaration is unusable. */
  const written = new Set<string>();
  const markWritten = (target: Node, reason: string) =>
    forEachNode(target, (node) => {
      const name = node.type === "Identifier" && writes.get(node);
      if (!name) return;
      writes.delete(node);
      markNameUnknown(model, name, reason);
      written.add(name);
    });
  const line = (offset: number) => locate(code, offset).line;
  const reactive = reactiveStatements(ast);
  forEachNode(ast, (node) => {
    switch (node.type) {
      case "AssignmentExpression": {
        const guards = reactive.get(node);
        if (model.reactiveDeclarations.has(node)) {
          // `$: x = …` defines `x` rather than writing it.
          forEachNode(node.left, (target) => {
            if (target.type === "Identifier") writes.delete(target);
          });
        } else if (
          guards?.length &&
          node.operator === "=" &&
          node.left.type === "Identifier" &&
          // `$store = …` sets a store other components may share.
          !node.left.name.startsWith("$") &&
          writes.get(node.left) === node.left.name
        ) {
          const { name } = node.left;
          writes.delete(node.left);
          const list = model.guardedWrites.get(name) ?? [];
          list.push({ guards, value: node.right, line: line(node.start) });
          model.guardedWrites.set(name, list);
        } else {
          markWritten(node.left, `is assigned at line ${line(node.start)}`);
        }
        break;
      }
      case "UpdateExpression":
        markWritten(node.argument, `is updated at line ${line(node.start)}`);
        break;
      case "BindDirective":
        markWritten(
          node.expression,
          `is bound with \`bind:\` at line ${line(node.start)}`,
        );
        break;
      case "CallExpression":
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "setContext"
        ) {
          const key = contextKey(node.arguments[0], model);
          if (key === undefined) model.providesUnknownContext = true;
          else model.providedContexts.add(key);
        }
        break;
    }
  });
  // Any other write, such as `for (x of xs)`.
  for (const [node, name] of writes) {
    markNameUnknown(model, name, `is assigned at line ${line(node.start)}`);
    written.add(name);
  }

  if (model.restPropsName && written.has(model.restPropsName)) {
    model.restPropsName = undefined;
  }

  readContextFlow(model, reactive);
  return model;
}

const CONTEXT_CALL = /\b(?:get|set)Context\b|\bgetAllContexts\b/;

function readContextFlow(
  model: ComponentModel,
  reactive: Map<Node, Guard[]>,
): void {
  const { ast, code } = model;
  if (!CONTEXT_CALL.test(code)) return;
  const parents = new Map<Node, Node | null>();
  walk(ast, {
    enter(node, parent) {
      parents.set(node, parent);
    },
  });
  const leak = (key: string, property: string) => {
    const leaked = model.contextLeaks.get(key) ?? new Set<string>();
    leaked.add(property);
    model.contextLeaks.set(key, leaked);
  };
  forEachNode(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") {
      return;
    }
    const [first, second] = node.arguments;
    if (node.callee.name === "getAllContexts") {
      model.readsUnknownContext = true;
    } else if (node.callee.name === "getContext") {
      const key = contextKey(first, model);
      if (key === undefined) model.readsUnknownContext = true;
      else readContextUse(model, node, key, parents, leak);
    } else if (node.callee.name === "setContext") {
      const key = contextKey(first, model);
      if (key === undefined) return;
      const objects = model.contextObjects.get(key) ?? [];
      objects.push(contextObject(model, second, parents, reactive));
      model.contextObjects.set(key, objects);
    }
  });
}

/** An object literal inline or in a `const` nothing else uses; else `null`. */
function contextObject(
  model: ComponentModel,
  node: Node | undefined,
  parents: Map<Node, Node | null>,
  reactive: Map<Node, Guard[]>,
): Map<string, MirroredStore | null> | null {
  let object: Node | null | undefined = node;
  if (node?.type === "Identifier") {
    const constant = topLevelConstant(model, node);
    if (constant?.binding.references.length !== 1) return null;
    object = constant.declarator.init;
  }
  if (object?.type !== "ObjectExpression") return null;
  const properties = new Map<string, MirroredStore | null>();
  for (const property of object.properties) {
    if (property.type !== "Property" || property.kind !== "init") return null;
    const name = propertyName(property);
    if (name === undefined) return null;
    const { value } = property;
    // `readonly(s)` from `svelte/store`
    const wrapped =
      value.type === "CallExpression" &&
      value.callee.type === "Identifier" &&
      model.storeImports.get(value.callee.name) === "readonly" &&
      value.arguments.length === 1 &&
      value.arguments[0].type === "Identifier"
        ? value.arguments[0]
        : undefined;
    const store =
      value.type === "Identifier"
        ? mirroredStore(model, value, property, parents, reactive)
        : wrapped
          ? mirroredStore(model, wrapped, value, parents, reactive)
          : null;
    properties.set(
      name,
      store && { ...store, readOnly: wrapped !== undefined },
    );
  }
  return properties;
}

function topLevelConstant(model: ComponentModel, id: Identifier) {
  const binding = model.scopes.bindingOf(id);
  const declarator = binding?.declaration;
  return binding &&
    isTopLevel(binding, model) &&
    binding.kind === "const" &&
    declarator?.type === "VariableDeclarator"
    ? { binding, declarator }
    : undefined;
}

export function propertyName(
  property: Extract<Node, { type: "Property" }>,
): string | undefined {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  return property.key.type === "Literal"
    ? String(property.key.value)
    : undefined;
}

/** `id` must be handed on only in `holder`. */
function mirroredStore(
  model: ComponentModel,
  id: Identifier,
  holder: Node,
  parents: Map<Node, Node | null>,
  reactive: Map<Node, Guard[]>,
): Omit<MirroredStore, "readOnly"> | null {
  const constant = topLevelConstant(model, id);
  if (!constant) return null;
  const { binding, declarator } = constant;
  if (
    declarator.init?.type !== "CallExpression" ||
    declarator.init.callee.type !== "Identifier" ||
    model.storeImports.get(declarator.init.callee.name) !== "writable" ||
    declarator.init.arguments.length > 1 ||
    declarator.init.arguments[0]?.type === "SpreadElement"
  ) {
    return null;
  }
  const writes: Expression[] = [];
  for (const reference of binding.references) {
    const { parent } = reference;
    // Handed on here, or read as `$s`.
    if (parent === holder) continue;
    if (reference.store && !reference.writes && !reference.mutates) continue;
    if (
      reference.store &&
      parent.type === "AssignmentExpression" &&
      parent.operator === "=" &&
      parent.left === reference.node &&
      reactive.has(parent)
    ) {
      writes.push(parent.right);
    } else if (
      !reference.store &&
      parent.type === "MemberExpression" &&
      parent.object === reference.node &&
      !parent.computed &&
      parent.property.type === "Identifier" &&
      parent.property.name === "set"
    ) {
      const call = parents.get(parent);
      const [value] = call?.type === "CallExpression" ? call.arguments : [];
      if (
        call?.type !== "CallExpression" ||
        call.callee !== parent ||
        call.arguments.length !== 1 ||
        value.type === "SpreadElement" ||
        !reactive.has(call)
      ) {
        return null;
      }
      writes.push(value);
    } else {
      return null;
    }
  }
  const [initial] = declarator.init.arguments as Expression[];
  return { initial: initial ?? null, writes };
}

/**
 * Nothing leaks for a property read into a subscribed-only `const`; any other
 * read leaks the property, and any other use of the context `"*"`.
 */
function readContextUse(
  model: ComponentModel,
  call: Node,
  key: string,
  parents: Map<Node, Node | null>,
  leak: (key: string, property: string) => void,
): void {
  let value: Node = call;
  let parent = parents.get(call);
  // `getContext(k) ?? {}`
  if (parent?.type === "LogicalExpression" && parent.left === value) {
    value = parent;
    parent = parents.get(parent);
  }
  const declarator = topLevelConst(model, parent, value);
  if (!declarator) {
    leak(key, "*");
    return;
  }
  if (declarator.id.type === "ObjectPattern") {
    for (const property of declarator.id.properties) {
      const name =
        property.type === "Property" ? propertyName(property) : undefined;
      if (property.type !== "Property" || name === undefined) {
        leak(key, "*");
        return;
      }
      const target =
        property.value.type === "AssignmentPattern"
          ? property.value.left
          : property.value;
      if (target.type !== "Identifier" || !onlySubscribed(model, target)) {
        leak(key, name);
      }
    }
    return;
  }
  if (declarator.id.type !== "Identifier") {
    leak(key, "*");
    return;
  }
  const binding = model.scopes.bindingOf(declarator.id);
  for (const reference of binding?.references ?? []) {
    const { parent } = reference;
    if (reference.writes || reference.mutates) {
      leak(key, "*");
      return;
    }
    if (
      parent.type === "MemberExpression" &&
      parent.object === reference.node &&
      !parent.computed &&
      parent.property.type === "Identifier"
    ) {
      const name = parent.property.name;
      let read: Node = parent;
      let up = parents.get(read);
      if (up?.type === "ChainExpression") {
        read = up;
        up = parents.get(up);
      }
      // `ctx?.s ?? readable(false)`
      if (up?.type === "LogicalExpression" && up.left === read) {
        read = up;
        up = parents.get(up);
      }
      const alias = topLevelConst(model, up, read);
      if (alias?.id.type !== "Identifier" || !onlySubscribed(model, alias.id)) {
        leak(key, name);
      }
    } else if (
      !(parent.type === "IfStatement" && parent.test === reference.node) &&
      !(
        parent.type === "ConditionalExpression" &&
        parent.test === reference.node
      ) &&
      !(parent.type === "UnaryExpression" && parent.operator === "!")
    ) {
      leak(key, "*");
      return;
    }
  }
}

/** Only the instance script's top-level `const`s. */
function topLevelConst(
  model: ComponentModel,
  parent: Node | null | undefined,
  init: Node,
): VariableDeclarator | undefined {
  if (parent?.type !== "VariableDeclarator" || parent.init !== init) {
    return undefined;
  }
  const declaration = model.ast.instance?.content.body.find(
    (statement) =>
      statement.type === "VariableDeclaration" &&
      statement.kind === "const" &&
      statement.declarations.includes(parent),
  );
  return declaration ? parent : undefined;
}

function onlySubscribed(model: ComponentModel, id: Identifier): boolean {
  const binding = model.scopes.bindingOf(id);
  return (
    binding?.references.every(
      (reference) => reference.store && !reference.writes && !reference.mutates,
    ) ?? false
  );
}

/** `$:` expression statements with their `if` guards; a loop, `&&` or function drops one. */
function reactiveStatements(ast: AST.Root): Map<Node, Guard[]> {
  const found = new Map<Node, Guard[]>();
  const visit = (node: Node, guards: Guard[]): void => {
    switch (node.type) {
      case "BlockStatement":
        for (const statement of node.body) visit(statement, guards);
        return;
      case "IfStatement":
        visit(node.consequent, [...guards, { test: node.test, holds: true }]);
        if (node.alternate) {
          visit(node.alternate, [...guards, { test: node.test, holds: false }]);
        }
        return;
      case "ExpressionStatement":
        found.set(node.expression, guards);
        return;
    }
  };
  for (const statement of ast.instance?.content.body ?? []) {
    if (statement.type === "LabeledStatement" && statement.label.name === "$") {
      visit(statement.body, []);
    }
  }
  return found;
}

/** Each name becomes a read of its path from `read`; rest and computed keys are unknown. */
function declareDestructured(
  model: ComponentModel,
  pattern: Pattern,
  read: Expression,
  lets: Set<string> | undefined,
): void {
  // The read takes the pattern's place in the source, for reports.
  const at = { start: pattern.start, end: pattern.end };
  const member = (property: Expression, computed: boolean) =>
    ({
      type: "MemberExpression",
      object: read,
      property,
      computed,
      optional: false,
      ...at,
    }) as unknown as Expression;
  switch (pattern.type) {
    case "Identifier":
      model.declarations.set(pattern.name, read);
      lets?.add(pattern.name);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        const key =
          property.type !== "Property"
            ? undefined
            : !property.computed && property.key.type === "Identifier"
              ? property.key.name
              : property.key.type === "Literal" &&
                  typeof property.key.value === "string"
                ? property.key.value
                : undefined;
        if (property.type !== "Property" || key === undefined) {
          markUnknown(
            model,
            property.type === "RestElement"
              ? property.argument
              : property.value,
            "is declared by destructuring",
          );
          continue;
        }
        declareDestructured(
          model,
          property.value,
          member({ type: "Identifier", name: key } as Expression, false),
          lets,
        );
      }
      return;
    case "ArrayPattern":
      for (const [index, element] of pattern.elements.entries()) {
        if (!element) continue;
        if (element.type === "RestElement") {
          markUnknown(model, element.argument, "is declared by destructuring");
          continue;
        }
        declareDestructured(
          model,
          element,
          member({ type: "Literal", value: index } as Expression, true),
          lets,
        );
      }
      return;
    case "AssignmentPattern":
      declareDestructured(
        model,
        pattern.left,
        {
          type: "ConditionalExpression",
          test: {
            type: "BinaryExpression",
            operator: "===",
            left: read,
            right: { type: "Identifier", name: "undefined" },
          },
          consequent: pattern.right,
          alternate: read,
          ...at,
        } as unknown as Expression,
        lets,
      );
      return;
    default:
      markUnknown(model, pattern, "is declared by destructuring");
  }
}

function readTopLevelStatement(
  model: ComponentModel,
  statement: Node,
  isInstance: boolean,
  resolveImport: ImportResolver,
  lets: Set<string> | undefined,
): void {
  if (statement.type === "ImportDeclaration") {
    const source = String(statement.source.value);
    const relative = source.startsWith(".");
    for (const specifier of statement.specifiers) {
      const local = specifier.local.name;
      if (!relative) model.packageImports.set(local, source);
      const imported =
        specifier.type === "ImportDefaultSpecifier"
          ? "default"
          : specifier.type === "ImportNamespaceSpecifier"
            ? "*"
            : specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : undefined;
      const resolved =
        relative && imported
          ? resolveImport(model.key, source, imported)
          : undefined;
      if (resolved && "component" in resolved) {
        model.componentImports.set(local, resolved.component);
      } else {
        model.otherImports.add(local);
        if (resolved && "members" in resolved) {
          model.memberImports.set(local, resolved.members);
        } else if (resolved && "string" in resolved) {
          model.importedStrings.set(local, resolved.string);
        } else if (resolved) {
          model.importedHelpers.set(local, resolved.helper);
        }
      }
      if (source === "svelte/store" && imported) {
        model.storeImports.set(local, imported);
      }
    }
    return;
  }

  const isExport = statement.type === "ExportNamedDeclaration";
  const declaration = isExport ? statement.declaration : statement;
  if (!declaration) return;

  if (declaration.type === "VariableDeclaration") {
    for (const declarator of declaration.declarations) {
      const rune = runeCall(model, declarator);
      if (rune?.rune === "$props" && isInstance) {
        readPropsRune(model, declarator.id);
        continue;
      }
      if (declarator.id.type !== "Identifier") {
        if (isExport || rune || !declarator.init) {
          markUnknown(model, declarator.id, "is declared by destructuring");
        } else {
          declareDestructured(
            model,
            declarator.id,
            declarator.init,
            declaration.kind === "let" ? lets : undefined,
          );
        }
        continue;
      }
      // `$state(x)`, `$state.raw(x)` and `$derived(x)` hold `x`; any
      // other rune (`$derived.by`, `$props.id`) evaluates as unknown.
      const init =
        rune && VALUE_RUNES.has(rune.rune)
          ? rune.argument
          : (declarator.init ?? null);
      const { name } = declarator.id;
      if (isExport && isInstance && declaration.kind !== "const") {
        model.props.set(name, init);
        model.propNames.set(name, name);
      } else {
        model.declarations.set(name, init);
        if (declaration.kind === "let") lets?.add(name);
      }
    }
    return;
  }

  if (declaration.type === "FunctionDeclaration" && declaration.id) {
    model.declarations.set(declaration.id.name, FUNCTION_DECLARATION);
    model.functions.set(declaration.id.name, declaration);
    return;
  }

  const assignment =
    statement.type === "LabeledStatement" &&
    statement.label.name === "$" &&
    statement.body.type === "ExpressionStatement" &&
    statement.body.expression.type === "AssignmentExpression" &&
    statement.body.expression.operator === "="
      ? statement.body.expression
      : undefined;
  if (assignment?.left.type === "ObjectPattern") {
    // `$: ({ a, b: c } = f())` defines each name as a read of `f()`.
    const names = extractIdentifiers(assignment.left).map(({ name }) => name);
    if (
      names.some(
        (name) =>
          name.startsWith("$") ||
          model.declarations.has(name) ||
          model.props.has(name),
      )
    ) {
      return;
    }
    declareDestructured(model, assignment.left, assignment.right, undefined);
    model.reactiveDeclarations.add(assignment);
  } else if (assignment?.left.type === "Identifier") {
    const { name } = assignment.left;
    // `$: $store = …` writes a store, and a redefinition is just another
    // assignment: either way the name becomes unknown.
    if (
      (name.startsWith("$") && !name.startsWith("$$")) ||
      model.declarations.has(name) ||
      model.props.has(name)
    ) {
      return;
    }
    model.declarations.set(name, assignment.right);
    model.reactiveDeclarations.add(assignment);
  }
}

/** A component's or slot's attributes are handed on; an element's aren't. */
function onlyTests(
  parent: Node | undefined,
  child: Node,
  ancestors: readonly Node[],
): boolean {
  switch (parent?.type) {
    case "ExpressionTag": {
      const owner = ancestors.at(-1);
      const element = ancestors.at(-2);
      return !(
        owner?.type === "Attribute" &&
        (element?.type === "Component" ||
          element?.type === "SvelteComponent" ||
          element?.type === "SvelteSelf" ||
          element?.type === "SlotElement")
      );
    }
    case "IfStatement":
    case "IfBlock":
    case "ConditionalExpression":
      return parent.test === child;
    case "UnaryExpression":
      return parent.operator === "!" || parent.operator === "typeof";
    case "BinaryExpression":
      return ["===", "!==", "==", "!="].includes(parent.operator);
    case "ClassDirective":
      return true;
    default:
      return false;
  }
}

function mutates(parent: Node | undefined, child: Node): boolean {
  switch (parent?.type) {
    case "AssignmentExpression":
      return parent.left === child;
    case "UpdateExpression":
    case "BindDirective":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "CallExpression":
    case "NewExpression":
      return parent.callee === child;
    default:
      return false;
  }
}

function findEscapes(ast: AST.Root): Map<string, Escape> {
  const escapes = new Map<string, Escape>();
  const entry = (name: string): Escape => {
    let found = escapes.get(name);
    if (!found) {
      found = { full: false, paths: [] };
      escapes.set(name, found);
    }
    return found;
  };
  /** `[array, item, destructured]` per name `{#each array as …}` declares. */
  const eachItems: Array<[string, string, boolean]> = [];
  const stack: Node[] = [];
  walk(ast, {
    enter(node, parent, key) {
      stack.push(node);
      if (
        node.type === "EachBlock" &&
        node.expression.type === "Identifier" &&
        node.context
      ) {
        const array = node.expression.name;
        if (node.context.type === "Identifier") {
          eachItems.push([array, node.context.name, false]);
        } else {
          for (const { name } of extractIdentifiers(node.context)) {
            eachItems.push([array, name, true]);
          }
        }
      }
      if (node.type !== "Identifier" || !isReference(node, parent)) return;
      if (node.name === "$$props") {
        const member = memberKey(parent);
        entry(member === undefined ? "*" : `$$props.${member}`).full = true;
        return;
      }
      if (
        // Declaring or exporting a name doesn't hand its value anywhere,
        // and `{#each name}` hands on its items (see `eachItems`).
        (parent?.type === "VariableDeclarator" && key === "id") ||
        parent?.type === "ExportSpecifier" ||
        (parent?.type === "EachBlock" &&
          (key === "expression" || key === "context"))
      ) {
        return;
      }
      const path: string[] = [];
      let current: Node = node;
      let index = stack.length - 1;
      for (;;) {
        const up = stack[index - 1];
        if (up?.type !== "MemberExpression" || up.object !== current) break;
        path.push(memberKey(up) ?? "*");
        current = up;
        index--;
      }
      const consumer = stack[index - 1];
      if (mutates(consumer, current)) {
        entry(node.name).full = true;
      } else if (path.length > 0) {
        entry(node.name).paths.push(path);
      } else if (
        !onlyTests(consumer, current, stack.slice(0, Math.max(0, index - 1)))
      ) {
        entry(node.name).full = true;
      }
    },
    leave() {
      stack.pop();
    },
  });
  // What happens to an item happens to its array's elements: an item
  // handed on is a path that matters only if items are objects. A name
  // destructured from an item is some path of it, so the whole item.
  for (const [array, item, destructured] of eachItems.reverse()) {
    const itemEscape = escapes.get(item);
    if (!itemEscape) continue;
    const target = entry(array);
    if (itemEscape.full || destructured) target.paths.push(["[]"]);
    for (const path of itemEscape.paths) target.paths.push(["[]", ...path]);
  }
  return escapes;
}

export function memberKey(parent: Node | null): string | undefined {
  if (parent?.type !== "MemberExpression") return undefined;
  const { property, computed } = parent;
  if (!computed && property.type === "Identifier") return property.name;
  return computed &&
    property.type === "Literal" &&
    typeof property.value === "string"
    ? property.value
    : undefined;
}

/** Rest elements, nested patterns and `let props = $props()` are unknown. */
function readPropsRune(model: ComponentModel, pattern: Pattern): void {
  if (pattern.type !== "ObjectPattern") {
    markUnknown(model, pattern, "holds every prop (`$props()`)");
    return;
  }
  for (const property of pattern.properties) {
    if (property.type === "RestElement") {
      markUnknown(model, property.argument, "is the rest of `$props()`");
      if (property.argument.type === "Identifier") {
        model.restPropsName = property.argument.name;
      }
      continue;
    }
    if (property.computed) {
      markUnknown(model, property.value, "has a computed `$props()` key");
      continue;
    }
    const passedAs = propertyName(property);
    const { value } = property;
    const [local, fallback] =
      value.type === "AssignmentPattern"
        ? [value.left, value.right]
        : [value, null];
    if (passedAs === undefined || local.type !== "Identifier") {
      markUnknown(model, value, "is a nested `$props()` pattern");
      continue;
    }
    // `initial` unwraps `$bindable(…)`.
    const binding = model.scopes.bindingOf(local);
    model.props.set(
      local.name,
      binding ? (binding.initial as Expression | null) : fallback,
    );
    model.propNames.set(local.name, passedAs);
  }
}

function topLevelBindings(scopes: Scopes): Binding[] {
  const bindings = [...scopes.instance.declarations.values()];
  if (scopes.module !== scopes.instance) {
    bindings.push(...scopes.module.declarations.values());
  }
  return bindings;
}

/** A string literal or imported `export const` string (`FORM_CONTEXT_KEY`). */
export function contextKey(
  node: Node | undefined,
  model: ComponentModel,
): string | undefined {
  if (node?.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  if (node?.type !== "Identifier") return undefined;
  const binding = model.scopes.bindingOf(node);
  return binding && isTopLevel(binding, model)
    ? model.importedStrings.get(node.name)
    : undefined;
}

/** Not a nested scope (parameter, `{#each}`, `let:`, `{@const}`) reusing the name. */
export function isTopLevel(binding: Binding, model: ComponentModel): boolean {
  return (
    binding.scope === model.scopes.instance ||
    binding.scope === model.scopes.module
  );
}
