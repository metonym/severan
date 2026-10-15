/**
 * tailwind-variants tables (`export const button = tv({ variants: … })`) in
 * a library's script modules, rewritten for the values the app's live call
 * sites pass: variant keys no call can select go, with the compound variants
 * that need one, and a table nothing calls keeps no classes at all. Strings
 * that never render then neither ship nor reach Tailwind's scanner.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lexComponent, lexImportsExports } from "sveast/lexer";
import type { Binding } from "sveast/scope";
import { walk } from "sveast/walk";
import type { Node } from "./ast";
import type { ModuleUsage } from "./call-sites";
import {
  type ComponentModel,
  loadScriptModel,
  propertyName,
  SCRIPT_MODULE_PREFIX,
} from "./component-model";
import { evaluate, type Scope } from "./evaluate";
import { createExportResolver } from "./exports";
import type { Library } from "./library";
import { walkLive } from "./live-walk";
import { type MappedText, type Splice, sliceOf, splice } from "./mapped-text";
import { listJsAndSvelteFiles, packageSignature } from "./package";
import {
  isObject,
  isShape,
  join,
  type Primitive,
  possible,
  UNDEFINED,
  UNKNOWN,
  type Value,
} from "./values";

/** `module#name`: `const name = tv(…)` in library module `module`. */
type TableId = string;

type Literal = string | number | boolean | null | undefined;

type Table = {
  module: string;
  name: string;
  /** `tv()`'s argument, in its module's model. */
  config: Node;
  /** Each variant's keys, or `null` for one that isn't an object literal. */
  variants: Map<string, Node[] | null>;
  /** Literal defaults; `UNKNOWN` for one that isn't, and for all if `defaultVariants` can't be read. */
  defaults: Map<string, Literal | typeof UNKNOWN> | typeof UNKNOWN;
  compounds: Node[];
  /** A call returns an object of slot functions, not a string. */
  slots: boolean;
  /** Why it keeps every class whatever the app passes. */
  open?: string;
};

type Scan = {
  tables: Map<TableId, Table>;
  /** Library component key -> local name -> the table its import binds. */
  readers: Map<string, Map<string, TableId>>;
  /** Barrel export name -> table, for the app's imports. */
  barrel: Map<string, TableId>;
  /** Why every table keeps every class. */
  open?: string;
};

const EMPTY_SCAN: Scan = {
  tables: new Map(),
  readers: new Map(),
  barrel: new Map(),
};

const TV_SOURCES = new Set(["tailwind-variants", "tailwind-variants/lite"]);
const MARKER = "tailwind-variants";
/** Props a call passes that aren't variants. */
const NOT_VARIANTS = new Set(["class", "className"]);

const offset = SCRIPT_MODULE_PREFIX.length;

type Span = { start: number; end: number };

function span(node: Node): Span {
  const { start, end } = node as unknown as Span;
  return { start, end };
}

const scanCache = new Map<string, { signature: string; scan: Scan }>();

async function scanLibrary(library: Library): Promise<Scan> {
  const signature = await packageSignature(library.root, library.spec.srcDir);
  const cached = scanCache.get(library.src);
  if (cached?.signature === signature) return cached.scan;
  const scan = await scanVariantTables(library);
  scanCache.set(library.src, { signature, scan });
  return scan;
}

/** A top-level `const` declarator by name, in a module's model. */
function declarators(model: ComponentModel) {
  const found: Array<{ id: string; init: Node }> = [];
  for (const statement of model.ast.module?.content.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (
      declaration?.type !== "VariableDeclaration" ||
      declaration.kind !== "const"
    ) {
      continue;
    }
    for (const { id, init } of declaration.declarations) {
      if (id.type === "Identifier" && init) found.push({ id: id.name, init });
    }
  }
  return found;
}

function properties(node: Node): Map<string, Node> | undefined {
  if (node.type !== "ObjectExpression") return undefined;
  const found = new Map<string, Node>();
  for (const property of node.properties) {
    if (property.type !== "Property" || property.kind !== "init") {
      return undefined;
    }
    const name = propertyName(property);
    if (name === undefined || property.computed) return undefined;
    found.set(name, property);
  }
  return found;
}

function literalOf(node: Node): Literal | typeof UNKNOWN {
  if (node.type === "Literal" && !("regex" in node && node.regex)) {
    return typeof node.value === "bigint" ? UNKNOWN : (node.value as Literal);
  }
  if (node.type === "Identifier" && node.name === "undefined") return undefined;
  return UNKNOWN;
}

function readTable(module: string, name: string, config: Node): Table {
  const table: Table = {
    module,
    name,
    config,
    variants: new Map(),
    defaults: new Map(),
    compounds: [],
    slots: false,
  };
  const props = properties(config);
  if (!props) {
    table.open = "its config isn't an object literal";
    return table;
  }
  if (props.has("extend")) table.open = "it extends another table";
  table.slots = props.has("slots");
  const value = (key: string) =>
    (props.get(key) as Extract<Node, { type: "Property" }> | undefined)?.value;

  const variants = value("variants");
  if (variants) {
    const byName = properties(variants);
    if (!byName) {
      table.open = "its variants aren't an object literal";
      return table;
    }
    for (const [variant, property] of byName) {
      const keys = (property as Extract<Node, { type: "Property" }>).value;
      table.variants.set(
        variant,
        properties(keys) ? (keys as { properties: Node[] }).properties : null,
      );
    }
  }
  const defaults = value("defaultVariants");
  if (defaults) {
    const byName = properties(defaults);
    if (byName) {
      const read = new Map<string, Literal | typeof UNKNOWN>();
      for (const [variant, property] of byName) {
        read.set(
          variant,
          literalOf((property as Extract<Node, { type: "Property" }>).value),
        );
      }
      table.defaults = read;
    } else {
      table.defaults = UNKNOWN;
    }
  }
  const compounds = value("compoundVariants");
  if (compounds?.type === "ArrayExpression") {
    table.compounds = compounds.elements.filter(
      (element) => element !== null,
    ) as Node[];
  } else if (compounds) {
    // Read as a whole: nothing to drop.
    table.compounds = [];
  }
  return table;
}

type Lexed = {
  imports: Array<{
    local: string;
    imported: string;
    source: string;
    /** In a component's `<script module>`. */
    module: boolean;
  }>;
  /** `export … from`: `local` is `"*"` for `export *` and `export * as`. */
  exports: Array<{
    kind: string;
    local: string;
    exported: string | null;
    source: string;
  }>;
};

function lex(file: string, code: string): Lexed {
  const lexed: Lexed = { imports: [], exports: [] };
  const read = (text: string, module: boolean) => {
    for (const statement of lexImportsExports(text)) {
      if (!statement.source || statement.typeOnly) continue;
      const source = statement.source.value;
      if (statement.kind === "import") {
        for (const specifier of statement.specifiers) {
          if (specifier.typeOnly) continue;
          lexed.imports.push({
            local: specifier.local,
            imported:
              specifier.kind === "namespace"
                ? "*"
                : specifier.kind === "default"
                  ? "default"
                  : specifier.imported,
            source,
            module,
          });
        }
      } else if (module) {
        for (const specifier of statement.specifiers) {
          if (specifier.typeOnly) continue;
          lexed.exports.push({
            kind: specifier.kind,
            local: specifier.local,
            exported: specifier.exported,
            source,
          });
        }
      }
    }
  };
  if (!file.endsWith(".svelte")) {
    read(code, true);
    return lexed;
  }
  const { instance, module } = lexComponent(code);
  if (module) {
    read(code.slice(module.content.start, module.content.end), true);
  }
  if (instance) {
    read(code.slice(instance.content.start, instance.content.end), false);
  }
  return lexed;
}

/** Every table in `library` and what reads it, uncached. */
export async function scanVariantTables(library: Library): Promise<Scan> {
  const { src } = library;
  const files = await listJsAndSvelteFiles(src);
  const codes = await Promise.all(
    files.map((file) => readFile(path.join(src, file), "utf8")),
  );
  const tables = new Map<TableId, Table>();
  /** Module -> export name -> the table it is. */
  const aliases = new Map<string, Map<string, TableId>>();
  const alias = (module: string, name: string, id: TableId): boolean => {
    const names = aliases.get(module) ?? new Map<string, TableId>();
    aliases.set(module, names);
    if (names.has(name)) return false;
    names.set(name, id);
    return true;
  };
  const open = (id: TableId, reason: string) => {
    const table = tables.get(id);
    if (table && !table.open) table.open = reason;
  };

  for (const [i, file] of files.entries()) {
    if (!file.endsWith(".js") || !codes[i].includes(MARKER)) continue;
    const model = loadScriptModel(src, file);
    if (!model) continue;
    const tvs = new Set<string>();
    for (const statement of model.ast.module?.content.body ?? []) {
      if (
        statement.type !== "ImportDeclaration" ||
        !TV_SOURCES.has(String(statement.source.value))
      ) {
        continue;
      }
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier" &&
          specifier.imported.name === "tv"
        ) {
          tvs.add(specifier.local.name);
        }
      }
    }
    if (tvs.size === 0) continue;
    for (const { id: name, init } of declarators(model)) {
      if (
        init.type !== "CallExpression" ||
        init.callee.type !== "Identifier" ||
        !tvs.has(init.callee.name) ||
        init.arguments.length === 0 ||
        init.arguments[0].type === "SpreadElement"
      ) {
        continue;
      }
      const id = `${file}#${name}`;
      tables.set(id, readTable(file, name, init.arguments[0]));
      const binding = model.scopes.module.declarations.get(name);
      if (isExported(model, name)) alias(file, name, id);
      for (const reference of binding?.references ?? []) {
        const exported = exportedAs(reference.parent);
        if (exported === undefined) open(id, `${file} reads it`);
        else alias(file, exported, id);
      }
    }
  }
  if (tables.size === 0) return EMPTY_SCAN;

  const known = new Set(files);
  const resolve = (from: string, source: string): string | undefined => {
    if (source === library.name) return library.barrelKey;
    if (!source.startsWith(".")) return undefined;
    const joined = path.posix.join(path.posix.dirname(from), source);
    return [
      joined,
      `${joined}.js`,
      `${joined}.svelte`,
      path.posix.join(joined, "index.js"),
    ].find((candidate) => known.has(candidate));
  };

  const scan: Scan = {
    tables,
    readers: new Map(),
    barrel: new Map(),
    open: scriptReads(library, files, codes),
  };
  const lexed = files.map((file, i) => lex(file, codes[i]));

  // Follow the tables through re-exports and imports until nothing new holds one.
  const handled = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [i, file] of files.entries()) {
      const { imports, exports } = lexed[i];
      for (const { kind, local, exported, source } of exports) {
        const target = resolve(file, source);
        const from = target && aliases.get(target);
        if (!from) continue;
        if (kind === "all") {
          for (const [name, id] of from) {
            if (name !== "default") changed = alias(file, name, id) || changed;
          }
        } else if (kind === "namespace") {
          for (const id of from.values()) {
            open(id, `${file} re-exports it in a namespace`);
          }
        } else {
          const id = from.get(local);
          if (id && exported) changed = alias(file, exported, id) || changed;
        }
      }
      for (const { local, imported, source, module } of imports) {
        const target = resolve(file, source);
        const from = target && aliases.get(target);
        if (!from) continue;
        const ids =
          imported === "*" ? [...from.values()] : [from.get(imported)];
        for (const id of ids) {
          if (!id) continue;
          const key = `${file}\0${local}\0${id}`;
          if (handled.has(key)) continue;
          handled.add(key);
          if (imported === "*") {
            if (file.endsWith(".svelte") || referenced(src, file, local)) {
              open(id, `${file} imports it in a namespace`);
            }
          } else if (file.endsWith(".svelte")) {
            if (module) open(id, `${file} imports it in \`<script module>\``);
            const locals = scan.readers.get(file) ?? new Map();
            locals.set(local, id);
            scan.readers.set(file, locals);
          } else {
            const exports = reExportsOf(src, file, local);
            if (!exports) open(id, `${file} reads it`);
            else {
              for (const name of exports) {
                changed = alias(file, name, id) || changed;
              }
            }
          }
        }
      }
    }
  }
  // The lexer skips `import()` and `require()`: what they load is read whole.
  for (const [i, file] of files.entries()) {
    for (const match of codes[i].matchAll(DYNAMIC_IMPORT)) {
      LITERAL_ARGUMENT.lastIndex = match.index + match[0].length;
      const source = LITERAL_ARGUMENT.exec(codes[i])?.[2];
      if (source === undefined) {
        scan.open ??= `${file} imports a module it computes`;
        continue;
      }
      const target = resolve(file, source);
      for (const id of (target && aliases.get(target)?.values()) || []) {
        open(id, `${file} imports it dynamically`);
      }
    }
  }
  for (const [name, id] of aliases.get(library.barrelKey) ?? []) {
    scan.barrel.set(name, id);
  }
  return scan;
}

const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(/g;
/** A literal argument, read from just after the `(`. */
const LITERAL_ARGUMENT = /\s*(["'`])([^"'`$]+)\1\s*\)/y;

/**
 * Why a script module may render a component no call site shows (it mounts
 * one), or read a table no import shows (a subpath of the package itself).
 */
function scriptReads(
  library: Library,
  files: readonly string[],
  codes: readonly string[],
): string | undefined {
  const exportResolver = createExportResolver(library.src);
  for (const [i, file] of files.entries()) {
    if (!file.endsWith(".js")) continue;
    for (const { source, local, imported } of lex(file, codes[i]).imports) {
      if (library.isSpecifier(source) && source !== library.name) {
        return `${file} imports \`${source}\``;
      }
      if (!source.startsWith(".") || source.endsWith(".css")) continue;
      if (
        exportResolver.importOf(file, source, imported).kind !== "value" &&
        !onlyReExported(library.src, file, local)
      ) {
        return `${file} uses a component`;
      }
    }
  }
  return undefined;
}

const scriptReadsCache = new Map<
  string,
  { signature: string; reason: string | undefined }
>();

/** `scriptReads` for the installed library, cached by its version. */
export async function scriptRendersComponents(
  library: Library,
): Promise<string | undefined> {
  const signature = await packageSignature(library.root, library.spec.srcDir);
  const cached = scriptReadsCache.get(library.src);
  if (cached?.signature === signature) return cached.reason;
  const files = (await listJsAndSvelteFiles(library.src)).filter((file) =>
    file.endsWith(".js"),
  );
  const codes = await Promise.all(
    files.map((file) => readFile(path.join(library.src, file), "utf8")),
  );
  const reason = scriptReads(library, files, codes);
  scriptReadsCache.set(library.src, { signature, reason });
  return reason;
}

function isExported(model: ComponentModel, name: string): boolean {
  return (model.ast.module?.content.body ?? []).some(
    (statement) =>
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "VariableDeclaration" &&
      statement.declaration.declarations.some(
        ({ id }) => id.type === "Identifier" && id.name === name,
      ),
  );
}

/** The name `export { local as name }` exports it by; `undefined` for any other parent. */
function exportedAs(parent: Node): string | undefined {
  if (parent.type !== "ExportSpecifier") return undefined;
  const { exported } = parent;
  return exported.type === "Identifier"
    ? exported.name
    : String((exported as { value: unknown }).value);
}

function moduleBinding(
  src: string,
  file: string,
  local: string,
): Binding | null | undefined {
  const model = loadScriptModel(src, file);
  if (!model) return undefined;
  return model.scopes.module.declarations.get(local) ?? null;
}

/** The names a script module exports binding `local` by, or `undefined` if it reads it. */
function reExportsOf(
  src: string,
  file: string,
  local: string,
): string[] | undefined {
  const binding = moduleBinding(src, file, local);
  if (binding === undefined) return undefined;
  const names: string[] = [];
  for (const reference of binding?.references ?? []) {
    const name = exportedAs(reference.parent);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names;
}

function onlyReExported(src: string, file: string, local: string): boolean {
  return reExportsOf(src, file, local) !== undefined;
}

function referenced(src: string, file: string, local: string): boolean {
  const binding = moduleBinding(src, file, local);
  return binding === undefined || (binding?.references.length ?? 0) > 0;
}

// ---------- what the app's call sites pass ----------

type Props = ReadonlyMap<string, Value>;

type TableUse = {
  open?: string;
  calls: Props[];
  /** Slot functions' props override the call's (`base({ home: true })`). */
  slotCalls: Props[];
};

const parentsCache = new WeakMap<ComponentModel, Map<Node, Node | null>>();

function parentsOf(model: ComponentModel): Map<Node, Node | null> {
  let parents = parentsCache.get(model);
  if (!parents) {
    const found = new Map<Node, Node | null>();
    walk(model.ast, {
      enter(node, parent) {
        found.set(node, parent);
      },
    });
    parents = found;
    parentsCache.set(model, parents);
  }
  return parents;
}

/** The props `value`, a call's argument, passes: `undefined` if it isn't a known object. */
function propsOf(value: Value): Props | undefined {
  if (value === UNKNOWN) return undefined;
  const objects: Array<ReadonlyMap<string, Value>> = [];
  for (const p of value) {
    if (p === undefined || p === null) objects.push(new Map());
    else if (isShape(p) && p.kind === "object") objects.push(p.props);
    else return undefined;
  }
  const props = new Map<string, Value>();
  for (const object of objects) {
    for (const [key, propValue] of object) {
      props.set(key, join(props.get(key) ?? possible(), propValue));
    }
  }
  for (const [key, propValue] of props) {
    if (objects.some((object) => !object.has(key))) {
      props.set(key, join(propValue, UNDEFINED));
    }
  }
  return props;
}

type Watch = { id: TableId; slot: boolean };

/**
 * Each call of a table `model` imports, and of the slot functions it returns;
 * `undefined` once a use can't be read (the table, or a result with slots,
 * used as a value).
 */
function watchCalls(
  model: ComponentModel,
  locals: ReadonlyMap<string, TableId>,
  tables: ReadonlyMap<TableId, Table>,
  use: (id: TableId) => TableUse,
): Map<Node, Watch> {
  const watched = new Map<Node, Watch>();
  const parents = parentsOf(model);
  const moduleScript = model.ast.module;
  const inModule = (node: Node) =>
    moduleScript != null &&
    span(node).start >= moduleScript.start &&
    span(node).end <= moduleScript.end;
  const open = (id: TableId, reason: string) => {
    use(id).open ??= reason;
  };
  const where = model.key;

  for (const [local, id] of locals) {
    const table = tables.get(id);
    const binding =
      model.scopes.instance.declarations.get(local) ??
      model.scopes.module.declarations.get(local);
    if (!table || !binding || binding.kind !== "import") {
      open(id, `${where} can't be read`);
      continue;
    }
    for (const { node, parent } of binding.references) {
      if (inModule(node)) {
        open(id, `${where} reads it in \`<script module>\``);
        continue;
      }
      if (parent.type !== "CallExpression" || parent.callee !== node) {
        open(id, `${where} uses it other than by calling it`);
        continue;
      }
      watched.set(parent, { id, slot: false });
      if (!watchSlots(model, parent, parents, id, watched) && table.slots) {
        open(id, `${where} hands on what it returns`);
      }
    }
  }
  return watched;
}

/** Watches the slot calls of `call`'s result; `false` if the result is used otherwise. */
function watchSlots(
  model: ComponentModel,
  call: Node,
  parents: ReadonlyMap<Node, Node | null>,
  id: TableId,
  watched: Map<Node, Watch>,
): boolean {
  const slotCall = (member: Node | null | undefined, object: Node) => {
    if (
      member?.type !== "MemberExpression" ||
      member.object !== object ||
      member.computed
    ) {
      return false;
    }
    const outer = parents.get(member);
    if (outer?.type !== "CallExpression" || outer.callee !== member) {
      return false;
    }
    watched.set(outer, { id, slot: true });
    return true;
  };
  const calledOnly = (binding: Binding | null) => {
    if (!binding) return false;
    for (const { node, parent } of binding.references) {
      if (parent.type === "CallExpression" && parent.callee === node) {
        watched.set(parent, { id, slot: true });
      } else return false;
    }
    return true;
  };

  let result = call;
  let up = parents.get(call);
  // `$derived(table({ … }))`
  if (
    up?.type === "CallExpression" &&
    up.callee.type === "Identifier" &&
    up.callee.name === "$derived" &&
    up.arguments[0] === result
  ) {
    result = up;
    up = parents.get(up);
  }
  if (slotCall(up, result)) return true;
  if (up?.type !== "VariableDeclarator" || up.init !== result) return false;
  const { id: pattern } = up;
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      if (
        property.type !== "Property" ||
        property.value.type !== "Identifier" ||
        !calledOnly(model.scopes.bindingOf(property.value))
      ) {
        return false;
      }
    }
    return true;
  }
  if (pattern.type !== "Identifier") return false;
  const binding = model.scopes.bindingOf(pattern);
  return (
    binding?.references.every(({ node, parent }) => slotCall(parent, node)) ??
    false
  );
}

// ---------- rewriting ----------

/** The key `tv()` looks a value up by (`falsyToString`), or `undefined` for none. */
function keyOf(p: Literal): string | undefined {
  if (p === null) return undefined;
  const key = p === false ? "false" : p === true ? "true" : p === 0 ? "0" : p;
  return key ? String(key) : "false";
}

/** What each variant can be passed, joined over every call. */
function passed(use: TableUse): (variant: string) => Value {
  const main = new Map<string, Value>();
  const keys = new Set(use.calls.flatMap((props) => [...props.keys()]));
  for (const key of keys) {
    let value: Value = possible();
    for (const props of use.calls) {
      value = join(value, props.get(key) ?? UNDEFINED);
    }
    main.set(key, value);
  }
  const slot = new Map<string, Value>();
  for (const props of use.slotCalls) {
    for (const [key, value] of props) {
      slot.set(key, join(slot.get(key) ?? possible(), value));
    }
  }
  return (variant) =>
    join(main.get(variant) ?? UNDEFINED, slot.get(variant) ?? possible());
}

/** The keys of `variant` a call can select, or `null` for any. */
function keptKeys(
  table: Table,
  variant: string,
  value: Value,
): Set<string> | null {
  if (value === UNKNOWN) return null;
  const keys = new Set<string>();
  for (const p of value) {
    if (isObject(p)) return null;
    let literal = p as Literal;
    if (literal === undefined) {
      const fallback =
        table.defaults === UNKNOWN ? UNKNOWN : table.defaults.get(variant);
      if (fallback === UNKNOWN) return null;
      literal = fallback;
    }
    const key = keyOf(literal);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/** Whether `actual` matches compound condition `expected` (`matchesCompoundValue`). */
function matches(expected: Literal, actual: Primitive): boolean {
  const nullishOrFalse = (v: Primitive) => v == null || v === false;
  return (
    expected === actual || (nullishOrFalse(expected) && nullishOrFalse(actual))
  );
}

/** Whether any call can match `compound`'s conditions. */
function compoundLive(
  table: Table,
  compound: Node,
  passedTo: (variant: string) => Value,
): boolean {
  const conditions = properties(compound);
  if (!conditions) return true;
  for (const [key, property] of conditions) {
    if (NOT_VARIANTS.has(key)) continue;
    const condition = (property as Extract<Node, { type: "Property" }>).value;
    const expected =
      condition.type === "ArrayExpression"
        ? condition.elements.map((element) =>
            element ? literalOf(element) : UNKNOWN,
          )
        : [literalOf(condition)];
    if (expected.includes(UNKNOWN)) continue;
    const value = passedTo(key);
    if (value === UNKNOWN) continue;
    const actuals: Primitive[] = [];
    for (const p of value) {
      if (p !== undefined) actuals.push(p);
      else {
        const fallback =
          table.defaults === UNKNOWN ? UNKNOWN : table.defaults.get(key);
        if (fallback === UNKNOWN) return true;
        actuals.push(fallback);
      }
    }
    if (
      !actuals.some((actual) =>
        (expected as Literal[]).some((e) => matches(e, actual)),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Removes `drop` from a list of properties or elements; a trailing comma may stay. */
function removals(list: readonly Node[], drop: ReadonlySet<Node>): Splice[] {
  const edits: Splice[] = [];
  for (const [i, node] of list.entries()) {
    if (!drop.has(node)) continue;
    const next = list[i + 1];
    edits.push({
      start: span(node).start,
      end: next ? span(next).start : span(node).end,
    });
  }
  return edits;
}

type TableStats = { keys: number; compounds: number; emptied: boolean };

function rewriteTable(
  table: Table,
  use: TableUse | undefined,
): { edits: Splice[]; stats: TableStats } | undefined {
  if (table.open || use?.open) return undefined;
  if (!use || use.calls.length === 0) {
    // Nothing calls it: no class it holds renders.
    if (
      table.config.type === "ObjectExpression" &&
      table.config.properties.length === 0
    ) {
      return undefined;
    }
    return {
      edits: [{ ...span(table.config), text: "{}" }],
      stats: { keys: 0, compounds: 0, emptied: true },
    };
  }
  const passedTo = passed(use);
  const edits: Splice[] = [];
  const stats: TableStats = { keys: 0, compounds: 0, emptied: false };
  for (const [variant, keys] of table.variants) {
    if (!keys) continue;
    const kept = keptKeys(table, variant, passedTo(variant));
    if (!kept) continue;
    const drop = new Set(
      keys.filter((property) => {
        const name = propertyName(
          property as Extract<Node, { type: "Property" }>,
        );
        return name === undefined || !kept.has(name);
      }),
    );
    stats.keys += drop.size;
    edits.push(...removals(keys, drop));
  }
  const dropCompounds = new Set(
    table.compounds.filter(
      (compound) => !compoundLive(table, compound, passedTo),
    ),
  );
  stats.compounds += dropCompounds.size;
  edits.push(...removals(table.compounds, dropCompounds));
  return edits.length > 0 ? { edits, stats } : undefined;
}

export type RewrittenTables = {
  /** Rewritten modules by key, with the source they were rewritten from. */
  modules: Map<string, { mapped: MappedText; source: string }>;
  pruned: number;
  emptied: number;
  keys: number;
  compounds: number;
  /** Tables a live component calls that keep every class, and why. */
  kept: Map<string, string>;
};

const NO_TABLES: RewrittenTables = {
  modules: new Map(),
  pruned: 0,
  emptied: 0,
  keys: 0,
  compounds: 0,
  kept: new Map(),
};

/**
 * Rewrites the library's tables for what its live components pass them.
 * `scopeFor` is the analysis's: a component it can't render calls nothing.
 */
export async function specializeTables(
  library: Library,
  appModules: readonly ModuleUsage[],
  scopeFor: (key: string) => Scope | undefined,
): Promise<RewrittenTables> {
  const scan = await scanLibrary(library);
  if (scan.tables.size === 0 || scan.open) return NO_TABLES;
  const uses = new Map<TableId, TableUse>();
  const use = (id: TableId) => {
    let found = uses.get(id);
    if (!found) {
      found = { calls: [], slotCalls: [] };
      uses.set(id, found);
    }
    return found;
  };

  for (const module of appModules) {
    const where = module.file ? path.basename(module.file) : "an app module";
    if (module.openAll || module.libraryValues === "any") return NO_TABLES;
    for (const name of module.libraryValues ?? []) {
      const id = scan.barrel.get(name);
      if (id) use(id).open ??= `${where} imports it`;
    }
  }

  for (const [key, locals] of scan.readers) {
    const scope = scopeFor(key);
    if (!scope) continue;
    const watched = watchCalls(scope.model, locals, scan.tables, use);
    if (watched.size === 0) continue;
    walkLive(scope, library, {
      watched,
      call(node) {
        const watch = watched.get(node);
        if (!watch || node.type !== "CallExpression") return;
        const target = use(watch.id);
        const [first] = node.arguments;
        const props =
          first === undefined
            ? new Map<string, Value>()
            : first.type === "SpreadElement"
              ? undefined
              : propsOf(evaluate(first, scope));
        if (!props) target.open ??= `${key} passes props it can't read`;
        else (watch.slot ? target.slotCalls : target.calls).push(props);
      },
    });
  }

  const result: RewrittenTables = {
    ...NO_TABLES,
    modules: new Map(),
    kept: new Map(),
  };
  for (const [id, { open }] of uses) {
    const why = scan.tables.get(id)?.open ?? open;
    if (why) result.kept.set(id.replace("#", " "), why);
  }
  const byModule = new Map<string, Table[]>();
  for (const table of scan.tables.values()) {
    const list = byModule.get(table.module) ?? [];
    list.push(table);
    byModule.set(table.module, list);
  }
  for (const [module, tables] of byModule) {
    const edits: Splice[] = [];
    for (const table of tables) {
      const rewrite = rewriteTable(
        table,
        uses.get(`${table.module}#${table.name}`),
      );
      if (!rewrite) continue;
      edits.push(...rewrite.edits);
      if (rewrite.stats.emptied) result.emptied++;
      else result.pruned++;
      result.keys += rewrite.stats.keys;
      result.compounds += rewrite.stats.compounds;
    }
    if (edits.length === 0) continue;
    const model = loadScriptModel(library.src, module);
    if (!model) continue;
    const source = model.code.slice(
      offset,
      model.code.length - "\n</script>".length,
    );
    edits.sort((a, b) => a.start - b.start);
    result.modules.set(module, {
      source,
      mapped: splice(
        sliceOf(source, 0, source.length),
        edits.map((edit) => ({
          ...edit,
          start: edit.start - offset,
          end: edit.end - offset,
        })),
      ),
    });
  }
  return result;
}
