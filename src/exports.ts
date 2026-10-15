import { readFileSync } from "node:fs";
import path from "node:path";
import { lexComponent, lexImportsExports } from "sveast/lexer";
import { extractIdentifiers } from "sveast/walk";
import { forEachNode, type Node, parseModule } from "./ast";
import { relativeKey, resolveModule } from "./package-exports";

/** What a name a library module exports is, to what renders it. */
export type Export =
  /** A component: its module key (`button/button.svelte`). */
  | { kind: "component"; key: string }
  /** A namespace, or a component with members (`Object.assign(Root, { Item })`) keyed `self`. */
  | { kind: "members"; self?: string; member: (name: string) => Export }
  /** Something that holds none of the library's components. */
  | { kind: "value" }
  /** Anything, a component or something that holds one included. */
  | { kind: "unknown" };

const VALUE: Export = { kind: "value" };
export const UNKNOWN_EXPORT: Export = { kind: "unknown" };

export type ExportResolver = {
  /** `module` is a key in `src`. */
  exportOf(module: string, name: string): Export;
  /** `name` is `"*"` for a namespace import, `"default"` for a default one. */
  importOf(from: string, source: string, name: string): Export;
};

/** Rendering an object with members renders its own component, if it has one. */
export function memberOf(exported: Export, path: readonly string[]): Export {
  let current = exported;
  for (const name of path) {
    if (current.kind !== "members") {
      // A member of a component or a value: whatever it holds.
      return current.kind === "value" ? VALUE : UNKNOWN_EXPORT;
    }
    current = current.member(name);
  }
  if (current.kind === "members") {
    return current.self ? { kind: "component", key: current.self } : VALUE;
  }
  return current;
}

type ModuleInfo = {
  reExports: Map<string, { source: string; local: string }>;
  /** `export * as name from "source"`, by name. */
  namespaces: Map<string, string>;
  /** `export * from "source"`. */
  stars: string[];
  /** Import bindings, by local name; `imported` is `"*"` for a namespace. */
  imports: Map<string, { source: string; imported: string }>;
  /** `export { local as exported }` without `from`: exported name -> local. */
  exportLists: Map<string, string>;
  /** A statement the lexer couldn't read. */
  unread: boolean;
  /** Its own top-level statements, parsed when first asked. */
  body: () => Node[] | undefined;
  code: string;
};

/**
 * A component is a `.svelte` file's default export; objects of components and
 * namespaces have members. Any other name holds no component only if its
 * module can't reach a `.svelte` file through its imports.
 */
export function createExportResolver(src: string): ExportResolver {
  const infos = new Map<string, ModuleInfo | null>();
  const resolved = new Map<string, Export | null>();
  const reaching = new Map<string, boolean>();

  function info(key: string): ModuleInfo | null {
    if (infos.has(key)) return infos.get(key) ?? null;
    let result: ModuleInfo | null;
    try {
      const code = readFileSync(path.join(src, key), "utf8");
      if (key.endsWith(".svelte")) {
        // A component's named exports are its `<script module>`'s.
        const { module, typescript } = lexComponent(code);
        result = readModule(
          module ? code.slice(module.content.start, module.content.end) : "",
          typescript,
        );
      } else {
        result = readModule(code, key.endsWith(".ts"));
      }
    } catch {
      result = null;
    }
    infos.set(key, result);
    return result;
  }

  function target(from: string, source: string): string | undefined {
    const file = resolveModule(path.join(src, from), source);
    if (!file) return undefined;
    const key = relativeKey(src, file);
    return key.startsWith("..") ? undefined : key;
  }

  function reachesComponents(key: string): boolean {
    let reaches = reaching.get(key);
    if (reaches === undefined) {
      reaches = searchComponents(key);
      reaching.set(key, reaches);
    }
    return reaches;
  }

  function searchComponents(key: string): boolean {
    const seen = new Set<string>();
    const stack = [key];
    for (
      let current = stack.pop();
      current !== undefined;
      current = stack.pop()
    ) {
      if (seen.has(current)) continue;
      seen.add(current);
      if (current.endsWith(".svelte")) return true;
      const module = info(current);
      if (!module || module.unread) return true;
      const sources = [
        ...Array.from(module.imports.values(), ({ source }) => source),
        ...Array.from(module.reExports.values(), ({ source }) => source),
        ...module.namespaces.values(),
        ...module.stars,
      ];
      for (const source of sources) {
        if (!source.startsWith(".")) continue;
        const next = target(current, source);
        if (next === undefined) return true;
        stack.push(next);
      }
    }
    return false;
  }

  function imported(from: string, source: string, name: string): Export {
    // Another package's: none of this library's components.
    if (!source.startsWith(".")) return VALUE;
    const key = target(from, source);
    if (key === undefined) return UNKNOWN_EXPORT;
    if (name === "*") {
      return {
        kind: "members",
        member: (member) => resolve(key, member) ?? VALUE,
      };
    }
    return resolve(key, name) ?? VALUE;
  }

  /** `null` when `key` doesn't export `name`. */
  function resolve(key: string, name: string): Export | null {
    const id = `${key}\0${name}`;
    if (resolved.has(id)) return resolved.get(id) ?? null;
    // A cycle: whatever it is, it's unknown while being resolved.
    resolved.set(id, UNKNOWN_EXPORT);
    const result = resolveUncached(key, name);
    resolved.set(id, result);
    return result;
  }

  function resolveUncached(key: string, name: string): Export | null {
    if (key.endsWith(".svelte") && name === "default") {
      return { kind: "component", key };
    }
    const module = info(key);
    if (!module || module.unread) return UNKNOWN_EXPORT;
    const reExport = module.reExports.get(name);
    if (reExport) return imported(key, reExport.source, reExport.local);
    const namespace = module.namespaces.get(name);
    if (namespace !== undefined) return imported(key, namespace, "*");
    const local = localExport(key, module, name);
    if (local !== null) return local;
    if (name === "default") return null;
    // Another package's `export *` exports none of this library's components.
    const targets = new Set<string | undefined>();
    for (const source of module.stars) {
      if (source.startsWith(".")) targets.add(target(key, source));
    }
    let found: Export | null = null;
    for (const next of targets) {
      const exported =
        next === undefined ? UNKNOWN_EXPORT : resolve(next, name);
      if (exported === null) continue;
      // Two modules that both export it: the same binding, or none.
      if (found !== null && !sameExport(found, exported)) {
        return UNKNOWN_EXPORT;
      }
      found = exported;
    }
    return found;
  }

  /** From the module's own code; `null` if it doesn't export `name`. */
  function localExport(
    key: string,
    module: ModuleInfo,
    name: string,
  ): Export | null {
    if (!module.code.includes("export")) return null;
    // A module that reaches no component exports none: whether it exports
    // `name` at all is read from its text, without parsing it.
    if (!reachesComponents(key)) {
      const word = new RegExp(`\\b${name.replace(REGEXP_SPECIAL, "\\$&")}\\b`);
      return word.test(module.code) ? VALUE : null;
    }
    // An import exported again (`import { x } from "./x"; export { x }`) is
    // followed without parsing the module.
    const listed = module.exportLists.get(name);
    const binding =
      listed === undefined ? undefined : module.imports.get(listed);
    if (binding) return imported(key, binding.source, binding.imported);
    const body = module.body();
    if (!body) return UNKNOWN_EXPORT;
    // Breaks cycles.
    const pending = new Set<string>();

    /** Holds no component only when every name it mentions is the module's and holds none. */
    const opaque = (node: Node | null | undefined): Export => {
      if (!node) return UNKNOWN_EXPORT;
      let holds = false;
      forEachNode(node, (inner) => {
        if (holds || inner.type !== "Identifier") return;
        if (declared(inner.name).kind !== "value") holds = true;
      });
      return holds ? UNKNOWN_EXPORT : VALUE;
    };

    const declares = (
      declaration: Node | null | undefined,
      local: string,
    ): Export | undefined => {
      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === "Identifier") {
            if (declarator.id.name === local) {
              return declarator.init ? holdingOf(declarator.init) : VALUE;
            }
          } else if (
            extractIdentifiers(declarator.id).some((id) => id.name === local)
          ) {
            return opaque(declarator.init);
          }
        }
      } else if (
        (declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "ClassDeclaration") &&
        declaration.id?.name === local
      ) {
        return opaque(declaration);
      }
      return undefined;
    };

    /** A global holds no component. */
    const declared = (local: string): Export => {
      if (pending.has(local)) return VALUE;
      pending.add(local);
      try {
        const binding = module.imports.get(local);
        if (binding) return imported(key, binding.source, binding.imported);
        for (const statement of body) {
          const found = declares(
            statement.type === "ExportNamedDeclaration" ||
              statement.type === "ExportDefaultDeclaration"
              ? (statement.declaration as Node | null)
              : statement,
            local,
          );
          if (found) return found;
        }
        return VALUE;
      } finally {
        pending.delete(local);
      }
    };

    const holdingOf = (node: Node): Export => {
      switch (node.type) {
        case "Identifier":
          return declared(node.name);
        case "ObjectExpression":
          return membersOf(node, undefined);
        case "CallExpression": {
          const { callee, arguments: args } = node;
          if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            callee.object.name === "Object" &&
            callee.property.type === "Identifier" &&
            callee.property.name === "assign" &&
            args.length === 2 &&
            args[1].type === "ObjectExpression"
          ) {
            const root = holdingOf(args[0]);
            if (root.kind === "unknown" || root.kind === "members") {
              return UNKNOWN_EXPORT;
            }
            return membersOf(
              args[1],
              root.kind === "component" ? root.key : undefined,
            );
          }
          return opaque(node);
        }
        default:
          return opaque(node);
      }
    };

    const membersOf = (
      node: Extract<Node, { type: "ObjectExpression" }>,
      self: string | undefined,
    ): Export => {
      const members = new Map<string, Node>();
      for (const property of node.properties) {
        if (
          property.type !== "Property" ||
          property.computed ||
          property.kind !== "init"
        ) {
          return UNKNOWN_EXPORT;
        }
        const keyName =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "Literal"
              ? String(property.key.value)
              : undefined;
        if (keyName === undefined) return UNKNOWN_EXPORT;
        members.set(keyName, property.value);
      }
      return {
        kind: "members",
        self,
        member: (member) => {
          const value = members.get(member);
          return value ? holdingOf(value) : VALUE;
        },
      };
    };

    for (const statement of body) {
      if (statement.type === "ExportDefaultDeclaration") {
        // A function or class falls through to `opaque`.
        if (name === "default") return holdingOf(statement.declaration as Node);
        continue;
      }
      if (statement.type !== "ExportNamedDeclaration" || statement.source) {
        continue;
      }
      const found = declares(statement.declaration, name);
      if (found) return found;
      for (const specifier of statement.specifiers) {
        const exported =
          specifier.exported.type === "Identifier"
            ? specifier.exported.name
            : String(specifier.exported.value);
        if (exported !== name) continue;
        return specifier.local.type === "Identifier"
          ? declared(specifier.local.name)
          : UNKNOWN_EXPORT;
      }
    }
    return null;
  }

  return {
    exportOf: (module, name) => resolve(module, name) ?? VALUE,
    importOf: imported,
  };
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;
/** `export {}`, which the lexer returns as it does a statement it can't read. */
const EMPTY_EXPORT = /^export\s*\{\s*\}\s*;?$/;

/** Whether two exports render the same: both values, or one component. */
function sameExport(a: Export, b: Export): boolean {
  if (a.kind === "value" || b.kind === "value") return a.kind === b.kind;
  return a.kind === "component" && b.kind === "component" && a.key === b.key;
}

function readModule(code: string, typescript: boolean): ModuleInfo {
  let body: Node[] | undefined | null = null;
  const module: ModuleInfo = {
    reExports: new Map(),
    namespaces: new Map(),
    stars: [],
    imports: new Map(),
    exportLists: new Map(),
    unread: false,
    code,
    body: () => {
      if (body === null) {
        try {
          body = parseModule(code, { typescript, comments: false }).body;
        } catch {
          body = undefined;
        }
      }
      return body;
    },
  };
  for (const statement of lexImportsExports(code, { exportLists: true })) {
    if (!statement.source) {
      if (statement.kind === "export" && statement.specifiers.length > 0) {
        for (const { typeOnly, local, exported } of statement.specifiers) {
          if (!typeOnly && exported) module.exportLists.set(exported, local);
        }
      } else if (
        statement.kind === "import" ||
        !EMPTY_EXPORT.test(code.slice(statement.start, statement.end))
      ) {
        module.unread = true;
      }
      continue;
    }
    if (statement.typeOnly) continue;
    const source = statement.source.value;
    if (statement.kind === "import") {
      for (const specifier of statement.specifiers) {
        if (specifier.typeOnly) continue;
        module.imports.set(specifier.local, {
          source,
          imported: specifier.kind === "namespace" ? "*" : specifier.imported,
        });
      }
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.typeOnly) continue;
      if (specifier.kind === "all") module.stars.push(source);
      else if (specifier.kind === "namespace" && specifier.exported) {
        module.namespaces.set(specifier.exported, source);
      } else if (specifier.exported) {
        module.reExports.set(specifier.exported, {
          source,
          local: specifier.local,
        });
      }
    }
  }
  return module;
}
