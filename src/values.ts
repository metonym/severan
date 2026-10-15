// Each expression is a small set of possible primitives, or `UNKNOWN`. When
// in doubt widen to `UNKNOWN`, which keeps every branch it guards alive.

/** Some object, array, or function: truthy, never nullish, never `===` a primitive. */
export const OBJECT = Symbol("object");

/** A `[]` nothing mutates or lets escape: `OBJECT`, but to `.length` and `{#each}`. */
export const EMPTY_ARRAY = Symbol("empty array");

export const UNKNOWN = Symbol("unknown");

/**
 * A literal nothing mutates or lets escape. Interned by `shape`, so equal literals are the same value.
 */
type Shape =
  | { readonly kind: "object"; readonly props: ReadonlyMap<string, Value> }
  | { readonly kind: "array"; readonly elements: readonly Value[] };

/**
 * A store that never changes: `readable(v)` with no start function, or one a context hands on (see `MirroredStore`).
 */
type Store = { readonly kind: "store"; readonly value: Value };

export type Primitive =
  | string
  | number
  | boolean
  | null
  | undefined
  | typeof OBJECT
  | typeof EMPTY_ARRAY
  | Shape
  | Store;

export type Value = ReadonlySet<Primitive> | typeof UNKNOWN;

const MAX_VALUES = 32;

/** Shared sets for the most common primitives: values are never mutated. */
const SINGLETONS = new Map<Primitive, Value>(
  ([true, false, null, undefined, "", OBJECT, EMPTY_ARRAY] as Primitive[]).map(
    (p) => [p, new Set([p])],
  ),
);

export function possible(...values: Primitive[]): Value {
  return (values.length === 1 && SINGLETONS.get(values[0])) || new Set(values);
}

export const UNDEFINED = possible(undefined);
export const BOOLEAN = possible(true, false);
const EMPTY = possible();

export function join(a: Value, b: Value): Value {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (b.size === 0) return a;
  if (a.size === 0) return b;
  const joined = new Set([...a, ...b]);
  return joined.size > MAX_VALUES ? UNKNOWN : joined;
}

export function flatMap(value: Value, map: (p: Primitive) => Value): Value {
  if (value === UNKNOWN) return UNKNOWN;
  if (value.size === 1) {
    const [p] = value;
    return map(p);
  }
  const result = new Set<Primitive>();
  for (const p of value) {
    const mapped = map(p);
    if (mapped === UNKNOWN) return UNKNOWN;
    for (const q of mapped) result.add(q);
    if (result.size > MAX_VALUES) return UNKNOWN;
  }
  return result;
}

/** False for `UNKNOWN` and the empty set. */
function every(value: Value, test: (p: Primitive) => boolean): boolean {
  if (value === UNKNOWN || value.size === 0) return false;
  for (const p of value) if (!test(p)) return false;
  return true;
}

export function isShape(p: Primitive): p is Shape {
  return typeof p === "object" && p !== null && p.kind !== "store";
}

export function isStore(p: Primitive): p is Store {
  return typeof p === "object" && p !== null && p.kind === "store";
}

export function isObject(
  p: Primitive,
): p is typeof OBJECT | typeof EMPTY_ARRAY | Shape | Store {
  return p === OBJECT || p === EMPTY_ARRAY || isShape(p) || isStore(p);
}

/** An object whose contents are known. */
export function isStructured(p: Primitive): p is typeof EMPTY_ARRAY | Shape {
  return p === EMPTY_ARRAY || isShape(p);
}

export const MAX_SHAPE_SIZE = 32;
/** Interned caches clear past this many, so watch rebuilds don't grow them forever. */
const MAX_INTERNED = 10_000;
const shapes = new Map<string, Shape>();
const stores = new Map<string, Store>();
const ids = new WeakMap<Shape, number>();
let nextId = 0;

function intern<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let existing = cache.get(key);
  if (!existing) {
    if (cache.size >= MAX_INTERNED) cache.clear();
    existing = make();
    cache.set(key, existing);
  }
  return existing;
}

/** Equal for values that hold the same values. */
export function valueKey(value: Value): string {
  if (value === UNKNOWN) return "?";
  return [...value]
    .map((p) => {
      if (isShape(p)) return `#${ids.get(p)}`;
      if (isStore(p)) return `$(${valueKey(p.value)})`;
      if (p === OBJECT) return "o";
      if (p === EMPTY_ARRAY) return "[]";
      return typeof p === "string" ? JSON.stringify(p) : String(p);
    })
    .sort()
    .join("|");
}

export function sameValue(a: Value, b: Value): boolean {
  return a === b || valueKey(a) === valueKey(b);
}

export function shape(contents: Shape): Shape {
  const key =
    contents.kind === "object"
      ? `{${[...contents.props]
          .map(([name, value]) => `${JSON.stringify(name)}:${valueKey(value)}`)
          .sort()
          .join(",")}}`
      : `[${contents.elements.map(valueKey).join(",")}]`;
  return intern(shapes, key, () => {
    ids.set(contents, nextId++);
    return contents;
  });
}

/** A held object's contents are unknown: `$s` can mutate them. */
export function storeOf(value: Value): Value {
  const held = value !== UNKNOWN && [...value].some(isObject) ? UNKNOWN : value;
  return possible(
    intern(stores, valueKey(held), () => ({ kind: "store", value: held })),
  );
}

const INDEX = /^(?:0|[1-9]\d*)$/;
const OBJECT_PROTOTYPE_KEYS = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

export function readProperty(p: Primitive, key: string): Value {
  if (typeof p === "string" && key === "length") return possible(p.length);
  if (p === EMPTY_ARRAY) {
    if (key === "length") return possible(0);
    return INDEX.test(key) ? UNDEFINED : UNKNOWN;
  }
  if (!isShape(p)) return UNKNOWN;
  if (p.kind === "array") {
    if (key === "length") return possible(p.elements.length);
    if (!INDEX.test(key)) return UNKNOWN;
    return p.elements[Number(key)] ?? UNDEFINED;
  }
  const own = p.props.get(key);
  if (own) return own;
  // Inherited (`toString`, `constructor`) is some function, not `undefined`.
  return OBJECT_PROTOTYPE_KEYS.has(key) ? UNKNOWN : UNDEFINED;
}

export function itemsOf(value: Value): Value {
  return flatMap(value, (p) => {
    if (p === EMPTY_ARRAY) return EMPTY;
    if (isShape(p) && p.kind === "array") {
      return p.elements.reduce<Value>(join, EMPTY);
    }
    return UNKNOWN;
  });
}

export function isEmptyArray(value: Value): boolean {
  return every(value, (p) => p === EMPTY_ARRAY);
}

export function isTruthy(p: Primitive): boolean {
  return isObject(p) || Boolean(p);
}

export function isNullish(p: Primitive): boolean {
  return p === null || p === undefined;
}

export type Truth = "truthy" | "falsy" | "either";

export function truthOf(value: Value): Truth {
  if (value === UNKNOWN || value.size === 0) return "either";
  let truthy = 0;
  for (const p of value) if (isTruthy(p)) truthy++;
  if (truthy === value.size) return "truthy";
  return truthy === 0 ? "falsy" : "either";
}

export function isNeverNullish(value: Value): boolean {
  return every(value, (p) => !isNullish(p));
}

export function isAlwaysNullish(value: Value): boolean {
  return every(value, isNullish);
}

const EQUALITY = new Map<string, (x: Primitive, y: Primitive) => boolean>([
  ["===", (x, y) => x === y],
  ["!==", (x, y) => x !== y],
  // biome-ignore lint/suspicious/noDoubleEquals: models `==`
  ["==", (x, y) => x == y],
  // biome-ignore lint/suspicious/noDoubleEquals: models `!=`
  ["!=", (x, y) => x != y],
]);
const RELATIONAL = new Map<string, (x: number, y: number) => boolean>([
  ["<", (x, y) => x < y],
  [">", (x, y) => x > y],
  ["<=", (x, y) => x <= y],
  [">=", (x, y) => x >= y],
]);

export function binary(operator: string, a: Value, b: Value): Value {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  return flatMap(a, (x) =>
    flatMap(b, (y) => {
      if (isObject(x) || isObject(y)) {
        // Two objects may or may not be the same one. An object never
        // strictly equals a primitive, nor loosely `null` or `undefined`,
        // but `==` coerces it against anything else (`[] == ""`).
        const other = isObject(x) ? y : x;
        if (
          !EQUALITY.has(operator) ||
          isObject(other) ||
          (operator.length === 2 && !isNullish(other))
        ) {
          return UNKNOWN;
        }
        return possible(operator.startsWith("!"));
      }
      const compare = RELATIONAL.get(operator);
      if (compare) {
        // Numbers with numbers and strings with strings; no coercion.
        if (
          !(typeof x === "number" && typeof y === "number") &&
          !(typeof x === "string" && typeof y === "string")
        ) {
          return UNKNOWN;
        }
        return possible(compare(x as number, y as number));
      }
      const equal = EQUALITY.get(operator);
      if (equal) return possible(equal(x, y));
      if (
        operator === "+" &&
        (typeof x === "string" || typeof y === "string")
      ) {
        return possible(String(x) + String(y));
      }
      return UNKNOWN;
    }),
  );
}

/** Some object may be a function, so it reads as `"object"` or `"function"`. */
export function typeOf(value: Value): Value {
  return flatMap(value, (p) => {
    if (p === OBJECT) return possible("object", "function");
    return possible(isObject(p) || p === null ? "object" : typeof p);
  });
}

export function stringify(value: Value): Value {
  return flatMap(value, (p) => (isObject(p) ? UNKNOWN : possible(String(p))));
}

export function formatValue(value: Value): string {
  if (value === UNKNOWN) return "dynamic";
  return [...value]
    .map((p) => {
      if (p === OBJECT) return "object";
      if (p === EMPTY_ARRAY) return "[]";
      if (isShape(p) || isStore(p)) return p.kind;
      return p === undefined ? "undefined" : JSON.stringify(p);
    })
    .sort()
    .join(", ");
}
