import type { Scopes } from "sveast/scope";
import { type AST, children, type Expression, locate } from "sveast/walk";
import type { Node } from "./ast";
import { componentMaps, selectedKeys } from "./component-maps";
import { UnsupportedComponentError } from "./component-model";
import {
  bindEach,
  evaluate,
  type PassedProp,
  type Scope,
  spreadProps,
  whyUnknownLater,
} from "./evaluate";
import { memberOf } from "./exports";
import type { ClassTokens, LibraryPaths } from "./library-paths";
import type { CallSite } from "./usage";
import {
  isEmptyArray,
  isNeverNullish,
  join,
  OBJECT,
  possible,
  stringify,
  truthOf,
  UNDEFINED,
  UNKNOWN,
  type Value,
} from "./values";

export type LiveResult = {
  classes: Set<string>;
  /** Prefixes of classes built from values it can't bound. */
  prefixes: Set<string>;
  childSites: CallSite[];
};

/** Calls a walk reports as it reaches them, live. */
export type WatchedCalls = {
  watched: ReadonlyMap<Node, unknown>;
  call(node: Node): void;
};

type Walk = LiveResult & {
  tokens: ClassTokens | undefined;
  library: LibraryPaths;
  calls: WatchedCalls | undefined;
};

function addTokens(text: string, result: Walk): void {
  const { tokens } = result;
  if (!tokens || !text.includes(tokens.marker)) return;
  for (const token of tokens.text(text)) {
    if (token.endsWith("-")) result.prefixes.add(token);
    else result.classes.add(token);
  }
}

/**
 * Skips only what usage proves can't run: falsy branches, `{#each}` over an
 * always-empty array, falsy `class:`. Function bodies count as live.
 */
export function walkLive(
  scope: Scope,
  library: LibraryPaths,
  calls?: WatchedCalls,
): LiveResult {
  const result: Walk = {
    classes: new Set(),
    prefixes: new Set(),
    childSites: [],
    tokens: library.spec.classTokens,
    library,
    calls,
  };
  const { ast } = scope.model;
  // `<style>` holds no rendered classes.
  for (const node of [ast.module, ast.instance, ast.fragment]) {
    if (node) visit(node, scope, result);
  }
  return result;
}

function visitAll(nodes: Iterable<Node>, scope: Scope, result: Walk) {
  for (const node of nodes) visit(node, scope, result);
}

function visit(node: Node, scope: Scope, result: Walk): void {
  switch (node.type) {
    // Import bindings aren't uses.
    case "ImportDeclaration":
      return;

    case "Literal":
      if (typeof node.value === "string") addTokens(node.value, result);
      return;

    case "TemplateLiteral": {
      const marker = result.tokens?.marker;
      if (
        marker !== undefined &&
        node.quasis.some((quasi) => quasi.value.raw.includes(marker))
      ) {
        const value = evaluate(node, scope);
        if (value !== UNKNOWN) {
          for (const p of value) {
            if (typeof p === "string") addTokens(p, result);
          }
          visitAll(node.expressions, scope, result);
          return;
        }
      }
      break;
    }

    // A template the walk can't evaluate keeps its literal parts: the
    // `x--btn--` in `x--btn--${kind}` becomes a prefix.
    case "TemplateElement":
      addTokens(node.value.raw, result);
      return;

    case "Text":
      // Attribute text (`class="x--a"`); element text never names a class.
      addTokens(node.data, result);
      return;

    case "Identifier": {
      // A component used as a value (`this={Comp}`) can get any props.
      const key = scope.model.componentImports.get(node.name);
      if (key) result.childSites.push(openSite(key));
      // An object of components used other than as `L.Member`: any of them.
      if (scope.model.memberImports.has(node.name)) {
        throw new UnsupportedComponentError(
          `${scope.model.key} uses \`${node.name}\`, an object of components, as a value`,
        );
      }
      return;
    }

    // Only the entries its `this` reads can select render.
    case "ObjectExpression": {
      const map = componentMaps(scope.model).get(node);
      if (!map) break;
      const keys = selectedKeys(map, scope);
      for (const [key, component] of map.entries) {
        if (!keys || keys.has(key)) result.childSites.push(openSite(component));
      }
      return;
    }

    case "MemberExpression": {
      const { object, property } = node;
      if (object.type !== "Identifier") break;
      const members = scope.model.memberImports.get(object.name);
      if (!members || node.computed || property.type !== "Identifier") break;
      const member = memberOf(members, [property.name]);
      if (member.kind === "component") {
        result.childSites.push(openSite(member.key));
      } else if (member.kind !== "value") {
        throw new UnsupportedComponentError(
          `${scope.model.key} uses \`${object.name}.${property.name}\`, which couldn't be resolved, as a value`,
        );
      }
      return;
    }

    case "LogicalExpression": {
      visit(node.left, scope, result);
      const left = evaluate(node.left, scope);
      const truth = truthOf(left);
      const skipRight =
        (node.operator === "&&" && truth === "falsy") ||
        (node.operator === "||" && truth === "truthy") ||
        (node.operator === "??" && isNeverNullish(left));
      if (!skipRight) visit(node.right, scope, result);
      return;
    }

    case "ConditionalExpression":
    case "IfStatement":
    case "IfBlock": {
      visit(node.test, scope, result);
      const truth = truthOf(evaluate(node.test, scope));
      if (truth !== "falsy") visit(node.consequent, scope, result);
      if (truth !== "truthy" && node.alternate) {
        visit(node.alternate, scope, result);
      }
      return;
    }

    case "EachBlock": {
      visit(node.expression, scope, result);
      // Over an array known to stay empty, only `{:else}` renders.
      if (!isEmptyArray(evaluate(node.expression, scope))) {
        const unbind = bindEach(node, scope);
        try {
          if (node.key) visit(node.key, scope, result);
          visit(node.body, scope, result);
        } finally {
          unbind();
        }
      }
      if (node.fallback) visit(node.fallback, scope, result);
      return;
    }

    case "ClassDirective": {
      visit(node.expression, scope, result);
      const truth = truthOf(evaluate(node.expression, scope));
      if (truth !== "falsy") addTokens(node.name, result);
      return;
    }

    case "Component": {
      const key = componentKey(node.name, scope, result.library);
      if (!key) break;
      const site = elementSite(node, key, scope);
      if (site.open && site.reason) {
        site.reason = `${whereIn(node, scope)} ${site.reason}`;
      }
      result.childSites.push(site);
      break;
    }

    case "SvelteSelf":
      result.childSites.push(elementSite(node, scope.model.key, scope));
      break;

    case "CallExpression":
      if (result.calls?.watched.has(node)) result.calls.call(node);
      break;
  }

  visitAll(children(node), scope, result);
}

function openSite(component: string): CallSite {
  return { component, open: true, props: new Map(), slots: null };
}

function elementSite(
  node: AST.Component | AST.SvelteSelf,
  component: string,
  scope: Scope,
): CallSite {
  return callSiteFromElement(node, component, {
    value: (expression) => evaluate(expression, scope),
    spread: (argument) => spreadProps(argument, scope),
    explain: explainAt(node, scope),
    instance: (expression) => instanceMembers(expression, scope.model.scopes),
  });
}

/**
 * `undefined` for a local tag (snippet parameter, `{@const}`) or another
 * package's component: one that imports the library must be in `content` (the
 * plugins check), so its call sites are read there. Throws when untraceable.
 */
function componentKey(
  name: string,
  scope: Scope,
  library: LibraryPaths,
): string | undefined {
  const { model } = scope;
  const [root, ...path] = name.split(".");
  const members = model.memberImports.get(root);
  if (members) {
    const rendered = memberOf(members, path);
    if (rendered.kind === "component") return rendered.key;
    if (rendered.kind === "value") return undefined;
  } else {
    const key =
      path.length === 0 ? model.componentImports.get(name) : undefined;
    if (key) return key;
    if (!model.otherImports.has(root)) return undefined;
  }
  const source = model.packageImports.get(root);
  if (source !== undefined && !library.isSpecifier(source)) return undefined;
  throw new UnsupportedComponentError(
    `${model.key} renders <${name}>, which couldn't be resolved`,
  );
}

/** `Button.svelte:12`, for the report. */
function whereIn(node: { start: number }, scope: Scope): string {
  return `${scope.model.key.split("/").pop()}:${locate(scope.model.code, node.start).line}`;
}

/** Called during the walk; the reason is worked out only when asked. */
type Explain = (expression: Expression) => () => string | undefined;

export type SiteReader = {
  value: (expression: Expression) => Value;
  spread: (argument: Expression) => Map<string, PassedProp> | undefined;
  explain: Explain;
  instance: (expression: Expression) => Set<string> | null;
};

function explainAt(node: { start: number }, scope: Scope): Explain {
  return (expression) => {
    const why = whyUnknownLater(expression, scope);
    return () => {
      const reason = why();
      return reason && `${whereIn(node, scope)} ${reason}`;
    };
  };
}

const MAX_ATTRIBUTE_VALUES = 32;

function attributeValue(
  attribute: AST.Attribute,
  evaluateExpression: (expression: Expression) => Value,
): Value {
  const { value } = attribute;
  if (value === true) return possible(true);
  if (!Array.isArray(value)) return evaluateExpression(value.expression);
  if (value.length === 1 && value[0].type === "ExpressionTag") {
    // `prop="{x}"`: the value itself, or its string form.
    const inner = evaluateExpression(value[0].expression);
    return join(inner, stringify(inner));
  }
  let strings: ReadonlySet<string> = new Set([""]);
  for (const part of value) {
    const piece =
      part.type === "Text"
        ? possible(part.data)
        : stringify(evaluateExpression(part.expression));
    if (piece === UNKNOWN) return UNKNOWN;
    const next = new Set<string>();
    for (const a of strings) {
      for (const b of piece) next.add(a + String(b));
    }
    if (next.size > MAX_ATTRIBUTE_VALUES) return UNKNOWN;
    strings = next;
  }
  return strings;
}

const WHITESPACE_ONLY = /^\s*$/;

/** `slots` is `null` if unknowable; `children` is whether anything fills the default slot. */
function readContent(fragment: AST.Fragment): {
  slots: Set<string> | null;
  snippets: string[];
  children: boolean;
} {
  let slots: Set<string> | null = new Set();
  const snippets: string[] = [];
  let children = false;
  for (const child of fragment.nodes) {
    if (child.type === "Comment") continue;
    if (child.type === "Text" && WHITESPACE_ONLY.test(child.data)) continue;
    // A snippet is a prop by its name and fills that slot (`children` the default).
    if (child.type === "SnippetBlock") {
      const { name } = child.expression;
      snippets.push(name);
      slots?.add(name === "children" ? "default" : name);
      continue;
    }
    const slot =
      "attributes" in child
        ? child.attributes.find(
            (attribute): attribute is AST.Attribute =>
              attribute.type === "Attribute" && attribute.name === "slot",
          )
        : undefined;
    if (!slot) {
      children = true;
      slots?.add("default");
      continue;
    }
    const text = Array.isArray(slot.value) ? slot.value : null;
    if (text?.length === 1 && text[0].type === "Text") slots?.add(text[0].data);
    else slots = null;
  }
  return { slots, snippets, children };
}

function whyOf(site: CallSite): NonNullable<CallSite["why"]> {
  site.why ??= new Map();
  return site.why;
}

function attributeWhy(
  attribute: AST.Attribute,
  explain: Explain,
): () => string | undefined {
  const { value } = attribute;
  const parts = value === true ? [] : Array.isArray(value) ? value : [value];
  const whys = parts.flatMap((part) =>
    part.type === "Text" ? [] : [explain(part.expression)],
  );
  return () => {
    for (const why of whys) {
      const reason = why();
      if (reason) return reason;
    }
    return undefined;
  };
}

/** Members of an instance that set no props: Svelte 3/4's `$destroy` and `$on`. */
const INSTANCE_METHODS = new Set(["$destroy", "$on"]);

/**
 * Members read off a `bind:this` instance (`dialog.open()`), or `null` if it's
 * handed on, written, or has `$set` called. Testing, reassigning and comparing
 * it are fine.
 */
export function instanceMembers(
  expression: Expression,
  scopes: Scopes,
): Set<string> | null {
  if (expression.type !== "Identifier") return null;
  const binding = scopes.bindingOf(expression);
  if (!binding) return null;
  const members = new Set<string>();
  for (const { node, parent, mutates } of binding.references) {
    if (mutates) return null;
    switch (parent.type) {
      case "BindDirective":
        if (parent.name === "this" && parent.expression === node) continue;
        return null;
      case "MemberExpression": {
        const { property } = parent;
        if (
          parent.object !== node ||
          parent.computed ||
          property.type !== "Identifier" ||
          (property.name.startsWith("$") &&
            !INSTANCE_METHODS.has(property.name))
        ) {
          return null;
        }
        members.add(property.name);
        continue;
      }
      case "AssignmentExpression":
        if (parent.left === node && parent.operator === "=") continue;
        return null;
      case "LogicalExpression":
        // Only a falsy `dialog` gets past `&&`.
        if (parent.left === node && parent.operator === "&&") continue;
        return null;
      case "IfStatement":
      case "IfBlock":
      case "ConditionalExpression":
        if (parent.test === node) continue;
        return null;
      case "UnaryExpression":
      case "BinaryExpression":
        continue;
      default:
        return null;
    }
  }
  return members;
}

/** A spread `spread` can't read (it reads the component's own `$$restProps`) opens the site. */
export function callSiteFromElement(
  node: AST.Component | AST.SvelteSelf,
  component: string,
  { value: evaluateExpression, spread, explain, instance }: SiteReader,
): CallSite {
  const { slots, snippets, children } = readContent(node.fragment);
  const site: CallSite = {
    component,
    open: false,
    props: new Map(),
    slots,
    ...(children && { children }),
  };
  for (const attribute of node.attributes) {
    switch (attribute.type) {
      case "SpreadAttribute": {
        const props = spread(attribute.expression);
        if (!props) {
          site.open = true;
          site.reason = "spreads props";
          break;
        }
        // Where the spread lacks a key, the value set before it stays,
        // or the prop isn't passed at all.
        for (const [name, { value, maybeAbsent, why }] of props) {
          if (name === "slot" || name.startsWith("--")) continue;
          const before = site.props.get(name);
          site.props.set(
            name,
            maybeAbsent ? join(before ?? UNDEFINED, value) : value,
          );
          if (value === UNKNOWN && why) whyOf(site).set(name, why);
        }
        break;
      }
      case "Attribute": {
        // `slot` places this element in its parent; `--x` sets a CSS variable.
        if (attribute.name === "slot" || attribute.name.startsWith("--")) break;
        const value = attributeValue(attribute, evaluateExpression);
        site.props.set(attribute.name, value);
        if (value === UNKNOWN) {
          whyOf(site).set(attribute.name, attributeWhy(attribute, explain));
        }
        break;
      }
      case "BindDirective": {
        if (attribute.name === "this") {
          site.instance = instance(attribute.expression);
          break;
        }
        site.props.set(attribute.name, UNKNOWN);
        const why = explain(attribute.expression);
        whyOf(site).set(attribute.name, () => why() ?? "is bound with `bind:`");
        break;
      }
    }
  }
  for (const name of snippets) site.props.set(name, possible(OBJECT));
  return site;
}
