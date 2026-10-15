import { walk } from "sveast/walk";
import type { Node } from "./ast";
import type { ComponentModel } from "./component-model";
import { evaluate, type Scope } from "./evaluate";
import { UNKNOWN } from "./values";

type ObjectNode = Extract<Node, { type: "ObjectExpression" }>;
type MemberNode = Extract<Node, { type: "MemberExpression" }>;

/**
 * `const icons = { error: ErrorFilled, … }`, read only as
 * `<svelte:component this={icons[kind]}>`: which entries render depends on
 * the keys `kind` can take.
 */
export type ComponentMap = {
  /** Module key of each entry's component, by key. */
  entries: Map<string, string>;
  /** Each entry's property, by key. */
  properties: Map<string, { start: number; end: number }>;
  /** The `icons[kind]` each `this` reads. */
  reads: MemberNode[];
};

const cache = new WeakMap<ComponentModel, Map<ObjectNode, ComponentMap>>();

/** The model's component maps, by their object literal. */
export function componentMaps(
  model: ComponentModel,
): Map<ObjectNode, ComponentMap> {
  let maps = cache.get(model);
  if (!maps) {
    maps = findComponentMaps(model);
    cache.set(model, maps);
  }
  return maps;
}

/** Keys `map`'s reads can take in `scope`, or `null` for any. */
export function selectedKeys(
  map: ComponentMap,
  scope: Scope,
): Set<string> | null {
  const keys = new Set<string>();
  for (const read of map.reads) {
    const { property } = read;
    if (!read.computed) {
      if (property.type !== "Identifier") return null;
      keys.add(property.name);
      continue;
    }
    const value = evaluate(property, scope);
    if (value === UNKNOWN) return null;
    for (const key of value) {
      // An object key (`icons[obj]`) goes through its `toString`.
      if (
        typeof key === "symbol" ||
        (typeof key === "object" && key !== null)
      ) {
        return null;
      }
      keys.add(String(key));
    }
  }
  return keys;
}

function findComponentMaps(
  model: ComponentModel,
): Map<ObjectNode, ComponentMap> {
  const maps = new Map<ObjectNode, ComponentMap>();
  const { ast, scopes } = model;
  const statements = [
    ...(ast.module?.content.body ?? []),
    ...(ast.instance?.content.body ?? []),
  ];
  const candidates = statements.flatMap((statement) =>
    statement.type === "VariableDeclaration" && statement.kind === "const"
      ? statement.declarations
      : [],
  );
  if (candidates.length === 0) return maps;

  const thisReads = new Set<Node>();
  walk(ast.fragment, {
    enter(node) {
      if (node.type === "SvelteComponent") thisReads.add(node.expression);
    },
  });
  if (thisReads.size === 0) return maps;

  for (const { id, init } of candidates) {
    if (id.type !== "Identifier" || init?.type !== "ObjectExpression") continue;
    const entries = new Map<string, string>();
    const properties: ComponentMap["properties"] = new Map();
    const readable = init.properties.every((property) => {
      if (
        property.type !== "Property" ||
        property.kind !== "init" ||
        property.computed ||
        property.method ||
        property.value.type !== "Identifier"
      ) {
        return false;
      }
      const { key, value } = property;
      const name =
        key.type === "Identifier"
          ? key.name
          : key.type === "Literal" &&
              (typeof key.value === "string" || typeof key.value === "number")
            ? String(key.value)
            : undefined;
      const component = model.componentImports.get(value.name);
      if (
        name === undefined ||
        name === "__proto__" ||
        entries.has(name) ||
        component === undefined ||
        scopes.bindingOf(value)?.kind !== "import"
      ) {
        return false;
      }
      entries.set(name, component);
      properties.set(name, property);
      return true;
    });
    const binding = readable ? scopes.bindingOf(id) : null;
    if (!binding || binding.references.length === 0) continue;
    const reads: MemberNode[] = [];
    // Anything but `icons[key]` as a whole `this` could hand it on.
    const onlyThis = binding.references.every(({ parent, node }) => {
      if (
        parent.type !== "MemberExpression" ||
        parent.object !== node ||
        !thisReads.has(parent)
      ) {
        return false;
      }
      reads.push(parent);
      return true;
    });
    if (onlyThis) maps.set(init, { entries, properties, reads });
  }
  return maps;
}
