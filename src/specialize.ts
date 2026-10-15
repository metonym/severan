/**
 * Rewrites a component's source for the values its call sites pass, using the
 * same evaluator as the CSS analysis so the two agree. Edits replace exact
 * node ranges of the original text; nothing is re-printed from the AST.
 */
import {
  type AST,
  forEachChild,
  isReference,
  SKIP,
  skipTypeWrappers,
  valueVisitorKeys,
  walk,
} from "sveast/walk";
import { type Node, parse } from "./ast";
import { componentMaps, selectedKeys } from "./component-maps";
import { bindEach, evaluate, isPropsObject, type Scope } from "./evaluate";
import {
  concat,
  type MappedText,
  removeMatches,
  type Splice,
  sliceOf,
  splice,
} from "./mapped-text";
import { FOREIGN_ELEMENT, namespacesChanged } from "./namespaces";
import {
  isAlwaysNullish,
  isEmptyArray,
  isNeverNullish,
  isObject,
  isStructured,
  type Truth,
  truthOf,
  UNKNOWN,
  type Value,
} from "./values";

export type Specialization = {
  code: string;
  mapped: MappedText;
  /** Edits applied (nested edits inside a removed range aren't counted). */
  edits: number;
  dropped: number;
  /** `.svelte` imports nothing renders anymore. Lazy: it parses again. */
  unrendered: () => string[];
};

type Span = { start: number; end: number };

type Rewrite = (start: number, end: number) => MappedText;

type Edit = Span & {
  print: (rewrite: Rewrite) => MappedText | string;
  /** Not counted as an edit. */
  silences?: boolean;
};

type Statement = AST.Script["content"]["body"][number];

const FOLDABLE = new Set([
  "Identifier",
  "MemberExpression",
  "ChainExpression",
  "LogicalExpression",
  "ConditionalExpression",
  "UnaryExpression",
  "BinaryExpression",
  "TemplateLiteral",
  "CallExpression",
]);

function isWritePosition(parent: Node | null, field: string): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case "AssignmentExpression":
    case "ForInStatement":
    case "ForOfStatement":
      return field === "left";
    case "UpdateExpression":
      return field === "argument";
    case "VariableDeclarator":
      return field === "id";
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return field === "params" || field === "id";
    case "CatchClause":
      return field === "param";
    case "ObjectPattern":
    case "ArrayPattern":
    case "RestElement":
    case "AssignmentPattern":
    case "ImportSpecifier":
    case "ExportSpecifier":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    // Keep callees, member objects (`this`) and template tags as written.
    case "CallExpression":
    case "NewExpression":
      return field === "callee";
    case "MemberExpression":
      return field === "object";
    case "TaggedTemplateExpression":
      return field === "tag" || field === "quasi";
    case "SnippetBlock":
    case "EachBlock":
    case "AwaitBlock":
      return field !== "expression";
    case "LabeledStatement":
      return field === "label";
    default:
      return false;
  }
}

function literalText(value: Value): string | null {
  if (value === UNKNOWN || value.size !== 1) return null;
  const [p] = value;
  if (isObject(p)) return null;
  if (p === undefined) return "void 0";
  if (typeof p === "number") {
    if (
      !Number.isFinite(p) ||
      Object.is(p, -0) ||
      Math.abs(p) > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    return p < 0 ? `(${p})` : String(p);
  }
  return JSON.stringify(p);
}

/**
 * Whether removing `node` is safe. Calls and member reads may run code
 * (getters), except, given `scope`, the few the evaluator models.
 */
function isPure(node: Node, scope?: Scope): boolean {
  switch (node.type) {
    case "Literal":
    case "Identifier":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return true;
    case "TemplateLiteral":
      return node.expressions.every((e) => isPure(e, scope));
    case "UnaryExpression":
      return node.operator !== "delete" && isPure(node.argument, scope);
    case "BinaryExpression":
    case "LogicalExpression":
      return isPure(node.left, scope) && isPure(node.right, scope);
    case "ConditionalExpression":
      return (
        isPure(node.test, scope) &&
        isPure(node.consequent, scope) &&
        isPure(node.alternate, scope)
      );
    case "ArrayExpression":
      return node.elements.every(
        (e) => !e || (e.type !== "SpreadElement" && isPure(e, scope)),
      );
    case "ObjectExpression":
      return node.properties.every(
        (p) =>
          p.type === "Property" &&
          !p.computed &&
          p.kind === "init" &&
          isPure(p.value, scope),
      );
  }
  const value = skipTypeWrappers(node);
  if (value !== node) return isPure(value, scope);
  if (!scope) return false;
  switch (node.type) {
    case "ThisExpression":
      return true;
    case "ChainExpression":
      return isPure(node.expression, scope);
    case "MemberExpression": {
      if (node.object.type === "Identifier" && node.object.name === "$$slots") {
        return !node.computed;
      }
      const literalKey = !node.computed || node.property.type === "Literal";
      // Svelte's prop objects are plain: reading one runs no getter.
      if (
        node.object.type === "Identifier" &&
        isPropsObject(node.object, scope) &&
        literalKey
      ) {
        return true;
      }
      const target = evaluate(node.object, scope);
      if (target === UNKNOWN || target.size === 0) return false;
      // Known objects' own properties and strings' `length` run no getter.
      const isLength =
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "length";
      return (
        ((literalKey &&
          [...target].every(
            (p) => isStructured(p) || (typeof p === "string" && isLength),
          )) ||
          (node.optional === true && isAlwaysNullish(target))) &&
        isPure(node.object, scope)
      );
    }
    case "CallExpression":
      return (
        node.callee.type === "Identifier" &&
        ["Boolean", "String", "getContext"].includes(node.callee.name) &&
        !scope.model.unknownNames.has(node.callee.name) &&
        node.arguments.every(
          (a) => a.type !== "SpreadElement" && isPure(a, scope),
        )
      );
    default:
      return false;
  }
}

/** Every node the walk edits has offsets; only `Fragment` doesn't. */
function span(node: Node): Span {
  return node as unknown as Span;
}

/** HTML whitespace Svelte trims at a fragment's edges (not NBSP). */
const EDGE_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const LEADING_COMMENTS = /^(?:<!--[\s\S]*?-->[ \t\r\n]*)+/;
const TRAILING_COMMENTS = /(?:[ \t\r\n]*<!--[\s\S]*?-->)+$/;
const COMMENT_GAPS = /(?<=-->)[ \t\r\n]+/g;
const GAPS_BEFORE_COMMENT = /[ \t\r\n]+(?=<!--)/g;
const ENDS_WITH_WHITESPACE = /[ \t\r\n]$/;
const STARTS_WITH_WHITESPACE = /^[ \t\r\n]/;
const ONLY_WHITESPACE = /^[ \t\r\n]*$/;
const PRESERVE_WHITESPACE = new Set(["pre", "textarea"]);

/** Elements whose own whitespace-only text children Svelte 5 drops. */
const DROPS_WHITESPACE = new Set([
  "select",
  "tr",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "colgroup",
  "datalist",
]);

export type SpecializeOptions = {
  /**
   * Replaces an `{#if}` that renders nothing between whitespace (removing it
   * would merge the two). Not empty: Svelte 3/4 warn; not text: Svelte 5
   * rejects text in elements like `<colgroup>`.
   */
  emptyBlock?: string;
  /** Remove top-level declarations nothing reads after the edits. */
  dropUnused?: boolean;
  /**
   * Replace an `{#if}` whose only live branch is known with that branch's
   * content. Only Svelte 5 renders it identically: block boundaries decide
   * how Svelte 3/4 trim whitespace.
   */
  unwrap?: boolean;
  /** Debugging: apply only the top-level edits this accepts (by index). */
  editFilter?: (index: number, edit: { start: number; end: number }) => boolean;
};

export function specializeComponent(
  scope: Scope,
  options?: SpecializeOptions,
): Specialization {
  const { code, ast } = scope.model;
  const emptyBlock = options?.emptyBlock ?? "{#if false}<!---->{/if}";
  const unwrap = options?.unwrap ?? false;
  const edits: Edit[] = [];
  let preserveDepth = 0;
  const owners: Array<Node | null> = [];
  /** Unwrapping here would drop the whitespace the block held. */
  const keepsBlock = () => {
    const owner = owners.at(-1);
    return owner?.type === "RegularElement" && DROPS_WHITESPACE.has(owner.name);
  };

  const replace = (node: Node, text: string) => {
    const { start, end } = span(node);
    edits.push({ start, end, print: () => text });
  };

  const keepOnly = (node: Span, kept: Span) => {
    edits.push({
      start: node.start,
      end: node.end,
      print: (rewrite) => concat("(", rewrite(kept.start, kept.end), ")"),
    });
  };

  const valueAt = (node: Node) => evaluate(node, scope);

  function tryFold(node: Node, parent: Node | null, field: string): boolean {
    if (
      !FOLDABLE.has(skipTypeWrappers(node).type) ||
      isWritePosition(parent, field)
    ) {
      return false;
    }
    if (
      node.type === "Identifier" &&
      (node.name === "undefined" || !isReference(node, parent))
    ) {
      return false;
    }
    const text = literalText(valueAt(node));
    if (text === null || !isPure(node, scope)) return false;
    replace(node, text);
    return true;
  }

  function truthIfPure(test: Node): Truth {
    return isPure(test, scope) ? truthOf(valueAt(test)) : "either";
  }

  function visitChildren(node: Node): void {
    forEachChild(
      node,
      (child, field) => visit(child, node, field),
      valueVisitorKeys,
    );
  }

  function visit(node: Node, parent: Node | null, field: string): void {
    switch (node.type) {
      case "ImportDeclaration":
      case "BindDirective":
      case "LetDirective":
      case "ObjectPattern":
      case "ArrayPattern":
      case "RestElement":
      case "AssignmentPattern":
        return;

      // Folding the expression of `e;` could turn it into a directive
      // prologue (`"use strict";`); only fold inside it.
      case "ExpressionStatement":
        visitChildren(node.expression);
        return;

      case "LogicalExpression": {
        if (tryFold(node, parent, field)) return;
        const { left, right, operator } = node;
        const value = valueAt(left);
        const truth = truthOf(value);
        if (
          (operator === "&&" && truth === "falsy") ||
          (operator === "||" && truth === "truthy") ||
          (operator === "??" && isNeverNullish(value))
        ) {
          // Never evaluated: its value can't matter.
          replace(right, "void 0");
          visit(left, node, "left");
        } else if (
          isPure(left, scope) &&
          ((operator === "&&" && truth === "truthy") ||
            (operator === "||" && truth === "falsy") ||
            (operator === "??" && isAlwaysNullish(value)))
        ) {
          keepOnly(node, right);
          visit(right, node, "right");
        } else {
          visitChildren(node);
        }
        return;
      }

      case "ConditionalExpression": {
        if (tryFold(node, parent, field)) return;
        const truth = truthOf(valueAt(node.test));
        if (truth === "either") break;
        const [liveField, deadField] =
          truth === "truthy"
            ? (["consequent", "alternate"] as const)
            : (["alternate", "consequent"] as const);
        const live = node[liveField];
        if (isPure(node.test, scope)) {
          keepOnly(node, live);
        } else {
          replace(node[deadField], "void 0");
          visit(node.test, node, "test");
        }
        visit(live, node, liveField);
        return;
      }

      case "IfStatement": {
        const truth = truthIfPure(node.test);
        if (truth === "either") break;
        const liveField = truth === "truthy" ? "consequent" : "alternate";
        const live = node[liveField];
        edits.push({
          start: node.start,
          end: node.end,
          print: (rewrite) => (live ? rewrite(live.start, live.end) : ";"),
        });
        if (live) visit(live, node, liveField);
        return;
      }

      case "IfBlock":
        visitIfChain(node, parent);
        return;

      case "ObjectExpression": {
        // Entries no `this` can select go, and so do their imports.
        const map = componentMaps(scope.model).get(node);
        const keys = map && selectedKeys(map, scope);
        if (
          !(map && keys) ||
          [...map.entries.keys()].every((key) => keys.has(key))
        ) {
          break;
        }
        const kept = [...map.properties]
          .filter(([key]) => keys.has(key))
          .map(([, property]) => property);
        edits.push({
          start: node.start,
          end: node.end,
          print: (rewrite) =>
            kept.length === 0
              ? "{}"
              : concat(
                  "{ ",
                  ...kept.flatMap((property, i) => [
                    ...(i > 0 ? [", "] : []),
                    rewrite(property.start, property.end),
                  ]),
                  " }",
                ),
        });
        return;
      }

      case "EachBlock": {
        if (
          isPure(node.expression, scope) &&
          isEmptyArray(valueAt(node.expression))
        ) {
          const printOnly = printOnlyFor(node, parent);
          const { fallback } = node;
          if (fallback) visit(fallback, node, "fallback");
          edits.push({
            start: node.start,
            end: node.end,
            print: (rewrite) => printOnly(rewrite, fallback),
          });
          return;
        }
        visit(node.expression, node, "expression");
        const unbind = bindEach(node, scope);
        try {
          if (node.key) visit(node.key, node, "key");
          visit(node.body, node, "body");
        } finally {
          unbind();
        }
        if (node.fallback) visit(node.fallback, node, "fallback");
        return;
      }

      case "ClassDirective": {
        const truth = truthIfPure(node.expression);
        if (truth === "falsy") {
          replace(node, "");
          return;
        }
        if (truth === "truthy" && node.expression.type !== "Literal") {
          replace(node, `class:${node.name}={true}`);
          return;
        }
        break;
      }

      case "Attribute": {
        // `{kind}` shorthand: expand it while folding, or leave it alone.
        const { value } = node;
        if (
          value !== true &&
          !Array.isArray(value) &&
          code[node.start] === "{" &&
          value.expression.type === "Identifier"
        ) {
          const text = literalText(valueAt(value.expression));
          if (text !== null) replace(node, `${node.name}={${text}}`);
          return;
        }
        break;
      }

      case "Property": {
        if (
          parent?.type === "ObjectExpression" &&
          node.shorthand &&
          node.value.type === "Identifier"
        ) {
          const text = literalText(valueAt(node.value));
          if (text !== null) {
            replace(node, `${node.value.name}: ${text}`);
            return;
          }
        }
        break;
      }

      case "Fragment":
        owners.push(parent);
        visitChildren(node);
        owners.pop();
        return;

      case "RegularElement":
        if (PRESERVE_WHITESPACE.has(node.name)) {
          preserveDepth++;
          visitChildren(node);
          preserveDepth--;
          return;
        }
        break;

      default:
        if (tryFold(node, parent, field)) return;
    }

    visitChildren(node);
  }

  function fragmentText(
    rewrite: Rewrite,
    fragment: AST.Fragment | null | undefined,
  ): MappedText {
    const nodes = fragment?.nodes ?? [];
    return nodes.length > 0
      ? rewrite(nodes[0].start, nodes[nodes.length - 1].end)
      : concat();
  }

  /** Prints `block` as only ever rendering one fragment (or `emptyBlock`). */
  function printOnlyFor(
    block: AST.IfBlock | AST.EachBlock,
    parent: Node | null,
  ) {
    const siblings = parent?.type === "Fragment" ? parent.nodes : [];
    const index = siblings.indexOf(block);
    const before = siblings[index - 1];
    const after = siblings[index + 1];
    // At a fragment's start, Svelte trims leading whitespace; a block there
    // keeps the whitespace after it from being trimmed.
    const whitespaceBefore =
      index === 0 ||
      (before?.type === "Text" && ENDS_WITH_WHITESPACE.test(before.data)) ||
      (index === 1 &&
        before?.type === "Text" &&
        ONLY_WHITESPACE.test(before.data));
    const whitespaceAfter =
      index === siblings.length - 1 ||
      (after?.type === "Text" && STARTS_WITH_WHITESPACE.test(after.data));
    const placeholder =
      preserveDepth > 0 || (whitespaceBefore && whitespaceAfter)
        ? emptyBlock
        : "";
    const trim = preserveDepth === 0;
    const keep = keepsBlock();

    return (
      rewrite: Rewrite,
      fragment: AST.Fragment | null | undefined,
    ): MappedText | string => {
      const content = fragmentText(rewrite, fragment);
      if (content.text.replace(EDGE_WHITESPACE, "") === "") return placeholder;
      // Svelte 3/4 trim whitespace by block boundaries; `{@const}` and
      // `{#snippet}` are scoped to their branch.
      if (
        !unwrap ||
        keep ||
        fragment?.nodes.some(
          (child) => child.type === "ConstTag" || child.type === "SnippetBlock",
        )
      ) {
        return concat("{#if true}", content, "{/if}");
      }
      // Svelte 5 trims through edge comments (like `svelte-ignore`) inside a
      // block, so the whitespace between them goes too.
      if (!trim) return content;
      let trimmed = removeMatches(content, EDGE_WHITESPACE);
      const leading = LEADING_COMMENTS.exec(trimmed.text);
      if (leading) {
        trimmed = removeMatches(trimmed, COMMENT_GAPS, 0, leading[0].length);
      }
      const trailing = TRAILING_COMMENTS.exec(trimmed.text);
      if (trailing) {
        trimmed = removeMatches(trimmed, GAPS_BEFORE_COMMENT, trailing.index);
      }
      return trimmed;
    };
  }

  function visitIfChain(block: AST.IfBlock, parent: Node | null): void {
    type Branch = { test: AST.IfBlock["test"]; body: AST.Fragment };
    const branches: Branch[] = [];
    let current = block;
    for (;;) {
      branches.push({ test: current.test, body: current.consequent });
      const next =
        current.alternate?.nodes.length === 1
          ? current.alternate.nodes[0]
          : undefined;
      if (next?.type !== "IfBlock" || !next.elseif) break;
      current = next;
    }
    let elseBody = current.alternate;

    const kept: Branch[] = [];
    let changed = false;
    for (const branch of branches) {
      const truth = truthIfPure(branch.test);
      if (truth === "falsy") {
        changed = true;
        continue;
      }
      if (truth === "truthy") {
        changed = changed || branch !== branches.at(-1) || elseBody !== null;
        elseBody = branch.body;
        break;
      }
      kept.push(branch);
    }

    for (const branch of kept) {
      visit(branch.test, block, "test");
      visit(branch.body, block, "consequent");
    }
    if (elseBody) visit(elseBody, block, "alternate");
    if (!changed && kept.length > 0) return;

    // Children leave `preserveDepth` and `owners` as they found them.
    const printOnly = printOnlyFor(block, parent);
    edits.push({
      start: block.start,
      end: block.end,
      print: (rewrite) => {
        if (kept.length === 0) return printOnly(rewrite, elseBody);
        const parts: Array<MappedText | string> = [];
        for (const [i, { test, body }] of kept.entries()) {
          parts.push(
            `{${i === 0 ? "#if" : ":else if"} `,
            rewrite(test.start, test.end),
            "}",
            fragmentText(rewrite, body),
          );
        }
        if (elseBody && elseBody.nodes.length > 0) {
          parts.push("{:else}", fragmentText(rewrite, elseBody));
        }
        return concat(...parts, "{/if}");
      },
    });
  }

  if (ast.module) visit(ast.module, null, "module");
  if (ast.instance) visit(ast.instance, null, "instance");
  visit(ast.fragment, null, "fragment");

  // Removed markup can leave a `<style>` selector unused. The mark goes right
  // after the last markup: before `<style>`, Svelte 3/4 would render the
  // whitespace between them.
  const { css } = ast;
  const lastMarkup = ast.fragment.nodes
    .filter(
      (node) => !(node.type === "Text" && ONLY_WHITESPACE.test(node.data)),
    )
    .at(-1);
  if (css && lastMarkup && lastMarkup.end <= css.start && edits.length > 0) {
    edits.push({
      start: lastMarkup.end,
      end: lastMarkup.end,
      print: () => IGNORE_UNUSED_CSS,
      silences: true,
    });
  }

  // Outermost edit wins; an edit's printer rewrites what's inside it.
  const sorted = [...edits]
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((edit, i) => options?.editFilter?.(i, edit) ?? true);
  let applied = 0;
  const rewrite: Rewrite = (start, end) => {
    const parts: Array<MappedText | string> = [];
    let cursor = start;
    for (const edit of sorted) {
      if (edit.start < cursor || edit.end > end || edit.start >= end) continue;
      parts.push(sliceOf(code, cursor, edit.start), edit.print(rewrite));
      cursor = edit.end;
      if (!edit.silences) applied++;
    }
    parts.push(sliceOf(code, cursor, end));
    return concat(...parts);
  };

  const folded = rewrite(0, code.length);
  let parsed = folded.text === code ? ast : undefined;
  // Unwrapping a block, or removing the branch with a fragment's only HTML,
  // can change the namespace Svelte infers for it. Without unwrapping, or
  // else not at all.
  if (applied > 0 && FOREIGN_ELEMENT.test(code)) {
    parsed = parse(folded.text, { comments: false, css: false });
    if (namespacesChanged(ast, parsed, folded)) {
      return unwrap
        ? specializeComponent(scope, { ...options, unwrap: false })
        : unchanged(code);
    }
  }
  const { mapped, dropped } = cleanUp(
    folded,
    options?.dropUnused !== false,
    applied > 0,
    parsed,
  );
  let unrendered: string[] | undefined;
  return {
    code: mapped.text,
    mapped,
    edits: applied,
    dropped,
    unrendered: () => {
      unrendered ??= applied > 0 ? unrenderedImports(mapped.text) : [];
      return unrendered;
    },
  };
}

function unchanged(code: string): Specialization {
  return {
    code,
    mapped: sliceOf(code, 0, code.length),
    edits: 0,
    dropped: 0,
    unrendered: () => [],
  };
}

function unrenderedImports(code: string): string[] {
  const ast = parse(code, { comments: false, css: false });
  const imports = new Map<string, string[]>();
  for (const script of [ast.module, ast.instance]) {
    for (const statement of script?.content.body ?? []) {
      if (
        statement.type === "ImportDeclaration" &&
        typeof statement.source.value === "string" &&
        statement.source.value.endsWith(".svelte")
      ) {
        imports.set(
          statement.source.value,
          statement.specifiers.map((specifier) => specifier.local.name),
        );
      }
    }
  }
  if (imports.size === 0) return [];

  const used = new Set<string>();
  walk(ast, {
    enter(node, parent) {
      if (node.type === "ImportDeclaration") return SKIP;
      if (node.type === "Component") used.add(node.name.split(".")[0]);
      if (node.type === "Identifier" && isReference(node, parent)) {
        used.add(node.name);
      }
    },
  });
  return [...imports]
    .filter(([, locals]) => !locals.some((local) => used.has(local)))
    .map(([source]) => source);
}

const MAX_CLEANUP_PASSES = 8;

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/**
 * Reads of each name, except `owned` nodes. `propReads` counts `owned` too,
 * but not `export { a }`, which keeps `a` declared without reading it.
 */
function countReads(
  ast: Node,
  owned: ReadonlySet<Node>,
  propReads?: Map<string, number>,
): Map<string, number> {
  const reads = new Map<string, number>();
  const count = (counts: Map<string, number>, name: string) => {
    bump(counts, name);
    // `$store` reads `store`.
    if (name.startsWith("$") && !name.startsWith("$$")) {
      bump(counts, name.slice(1));
    }
  };
  walk(ast, {
    enter(node, parent, key) {
      if (
        node.type === "Identifier" &&
        !isDeclaredName(parent, key) &&
        isReference(node, parent)
      ) {
        if (!owned.has(node)) count(reads, node.name);
        if (propReads && parent?.type !== "ExportSpecifier") {
          count(propReads, node.name);
        }
      }
      // Directive names may have no Identifier of their own.
      if (
        node.type === "ClassDirective" ||
        node.type === "BindDirective" ||
        node.type === "LetDirective" ||
        node.type === "StyleDirective"
      ) {
        bump(reads, node.name);
        if (propReads) bump(propReads, node.name);
      }
    },
  });
  return reads;
}

function isDeclaredName(parent: Node | null, key: string | null): boolean {
  switch (parent?.type) {
    case "VariableDeclarator":
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return key === "id";
    default:
      return false;
  }
}

/** Above `<style>`: Svelte 3/4 read the first code, Svelte 5 the second. */
const IGNORE_UNUSED_CSS =
  "<!-- svelte-ignore css-unused-selector css_unused_selector -->";

const IGNORE_UNUSED_PROP =
  "// svelte-ignore unused-export-let export_let_unused\n  ";

/**
 * Props nothing reads anymore get `svelte-ignore`. They stay declared: an
 * undeclared prop would land in `$$restProps`.
 */
function unusedPropMarks(
  statements: readonly Statement[],
  reads: ReadonlyMap<string, number>,
): number[] {
  // Svelte 5 reports `let a; export { a as b }` at the `let`, Svelte 3/4
  // at the export: mark both.
  const declaredAt = new Map<string, number>();
  for (const statement of statements) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type === "Identifier") {
        declaredAt.set(declarator.id.name, statement.start);
      }
    }
  }
  const marks = new Set<number>();
  for (const statement of statements) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source) {
      continue;
    }
    const { declaration } = statement;
    const names = !declaration
      ? statement.specifiers.map((specifier) => specifier.local)
      : declaration.type === "VariableDeclaration" && declaration.kind === "let"
        ? declaration.declarations.map((declarator) => declarator.id)
        : [];
    for (const name of names) {
      if (name.type !== "Identifier" || reads.has(name.name)) continue;
      marks.add(statement.start);
      const declared = declaredAt.get(name.name);
      if (declared !== undefined) marks.add(declared);
    }
  }
  return [...marks];
}

/** `cleanUp`'s removal of unread declarations on its own, for tests. */
export function dropUnusedDeclarations(source: string): {
  code: string;
  dropped: number;
} {
  const { mapped, dropped } = cleanUp(
    sliceOf(source, 0, source.length),
    true,
    false,
  );
  return { code: mapped.text, dropped };
}

type Candidate = {
  name: string;
  statement: Statement;
  /** The declared name and `$:` label: not reads. */
  own: readonly Node[];
};

function removableDeclarations(statements: readonly Statement[]): Candidate[] {
  // Assigning a prop can update a parent's `bind:`, and assigning
  // `$store` sets the store: never "unused".
  const props = new Set<string>();
  for (const statement of statements) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declarator of statement.declaration.declarations) {
        if (declarator.id.type === "Identifier") props.add(declarator.id.name);
      }
    }
    for (const specifier of statement.specifiers) {
      if (specifier.local.type === "Identifier") {
        props.add(specifier.local.name);
      }
    }
  }
  const removable = (name: string) =>
    !props.has(name) && !(name.startsWith("$") && !name.startsWith("$$"));

  const candidates: Candidate[] = [];
  for (const statement of statements) {
    if (
      statement.type === "LabeledStatement" &&
      statement.label.name === "$" &&
      statement.body.type === "ExpressionStatement"
    ) {
      const { expression } = statement.body;
      if (
        expression.type === "AssignmentExpression" &&
        expression.operator === "=" &&
        expression.left.type === "Identifier" &&
        removable(expression.left.name) &&
        isPure(expression.right)
      ) {
        candidates.push({
          name: expression.left.name,
          statement,
          own: [expression.left, statement.label],
        });
      }
    } else if (
      statement.type === "VariableDeclaration" &&
      statement.declarations.length === 1
    ) {
      const [{ id, init }] = statement.declarations;
      if (
        id.type === "Identifier" &&
        removable(id.name) &&
        (!init || isPure(init))
      ) {
        candidates.push({ name: id.name, statement, own: [id] });
      }
    }
  }
  return candidates;
}

function subtractReads(
  reads: Map<string, number>,
  removed: ReadonlyMap<string, number>,
): void {
  for (const [name, count] of removed) {
    const left = (reads.get(name) ?? 0) - count;
    if (left > 0) reads.set(name, left);
    else reads.delete(name);
  }
}

/**
 * With `drop`, removes unread top-level declarations with pure initializers
 * (Svelte compiles `$:` into effects a minifier must keep); with `silence`,
 * marks unread props.
 */
function cleanUp(
  input: MappedText,
  drop: boolean,
  silence: boolean,
  parsed?: AST.Root,
): { mapped: MappedText; dropped: number } {
  if (!drop && !silence) return { mapped: input, dropped: 0 };
  const ast = parsed ?? parse(input.text, { comments: false, css: false });
  const statements = ast.instance?.content.body ?? [];
  const candidates = drop ? removableDeclarations(statements) : [];
  // A declaration's own reads (`$: x = x + 1`) count.
  const owned = new Set(candidates.flatMap((candidate) => candidate.own));
  const propReads = silence ? new Map<string, number>() : undefined;
  const reads = countReads(ast, owned, propReads);

  const removed: Candidate[] = [];
  let remaining = candidates;
  for (let pass = 0; pass < MAX_CLEANUP_PASSES; pass++) {
    const unused = remaining.filter((candidate) => !reads.has(candidate.name));
    if (unused.length === 0) break;
    for (const candidate of unused) {
      removed.push(candidate);
      const removedPropReads = propReads && new Map<string, number>();
      subtractReads(
        reads,
        countReads(candidate.statement, owned, removedPropReads),
      );
      if (propReads && removedPropReads) {
        subtractReads(propReads, removedPropReads);
      }
    }
    remaining = remaining.filter((candidate) => !unused.includes(candidate));
  }

  const edits: Splice[] = removed.map(({ statement }) => ({
    start: statement.start,
    end: statement.end,
  }));
  for (const start of propReads ? unusedPropMarks(statements, propReads) : []) {
    edits.push({ start, end: start, text: IGNORE_UNUSED_PROP });
  }
  edits.sort((a, b) => a.start - b.start);
  return { mapped: splice(input, edits), dropped: removed.length };
}
