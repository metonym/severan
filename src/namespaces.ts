/**
 * Svelte 5 infers each fragment's namespace from what it holds: a block
 * whose direct elements are all SVG renders as SVG, which drops the
 * whitespace-only text between its nodes and builds its template in that
 * namespace. Unwrapping a block, or removing the branch that held a
 * fragment's only HTML elements, can change what's inferred. This mirrors
 * `infer_namespace` and `check_nodes_for_namespace` from Svelte's compiler
 * closely enough to compare a component with its rewrite.
 */
import { type AST, forEachChild } from "sveast/walk";
import type { Node } from "./ast";
import type { MappedText } from "./mapped-text";

type Namespace = "html" | "svg" | "mathml";

// Svelte's `SVG_ELEMENTS` and `MATHML_ELEMENTS`.
const SVG = new Set(
  "altGlyph altGlyphDef altGlyphItem animate animateColor animateMotion animateTransform circle clipPath color-profile cursor defs desc discard ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter font font-face font-face-format font-face-name font-face-src font-face-uri foreignObject g glyph glyphRef hatch hatchpath hkern image line linearGradient marker mask mesh meshgradient meshpatch meshrow metadata missing-glyph mpath path pattern polygon polyline radialGradient rect set solidcolor stop svg switch symbol text textPath tref tspan unknown use view vkern".split(
    " ",
  ),
);
const MATHML = new Set(
  "annotation annotation-xml maction math merror mfrac mi mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover semantics".split(
    " ",
  ),
);

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** A tag that may make a fragment SVG or MathML; without one, nothing can change. */
export const FOREIGN_ELEMENT = new RegExp(
  `<(?:svelte:element|${[...SVG, ...MATHML]
    .map((name) => name.replace(REGEXP_SPECIAL, "\\$&"))
    .join("|")})[\\s/>]`,
);

/** Owners whose fragment Svelte reads through its blocks (`check_nodes_for_namespace`). */
const RESETS = new Set([
  "Fragment",
  "Root",
  "Component",
  "SvelteComponent",
  "SvelteFragment",
  "SnippetBlock",
  "SlotElement",
]);
/** What `check_nodes_for_namespace` walks into. */
const WALKED = new Set([
  "EachBlock",
  "IfBlock",
  "AwaitBlock",
  "Fragment",
  "KeyBlock",
]);

type Element = Extract<Node, { type: "RegularElement" }>;

/** `metadata.svg`: `a` and `title` take their nearest element's. */
function isSvg(element: Element, parentSvg: boolean | undefined): boolean {
  if (SVG.has(element.name)) return true;
  if (element.name !== "a" && element.name !== "title") return false;
  if (parentSvg !== undefined) return parentSvg;
  // An `<a>` with no element above is SVG if it holds SVG elements.
  return (
    element.name === "a" &&
    element.fragment.nodes.some(
      (child) =>
        child.type === "RegularElement" &&
        child.name !== "svg" &&
        SVG.has(child.name),
    )
  );
}

function namespaceOf(element: Node, parentSvg: boolean | undefined) {
  if (element.type !== "RegularElement") return "html";
  if (isSvg(element, parentSvg)) return "svg";
  return MATHML.has(element.name) ? "mathml" : "html";
}

function checkNodes(
  nodes: readonly Node[],
  parentSvg: boolean | undefined,
): Namespace | "keep" | "maybe_html" {
  let namespace: Namespace | "keep" | "maybe_html" = "keep";
  const visit = (node: Node): boolean => {
    if (node.type === "RegularElement" || node.type === "SvelteElement") {
      const own = namespaceOf(node, parentSvg);
      if (own === "html") {
        namespace = "html";
        return false;
      }
      if (namespace === "keep") namespace = own;
      return true;
    }
    if (node.type === "Text") {
      if (node.data.trim() !== "") namespace = "maybe_html";
      return true;
    }
    if (!WALKED.has(node.type)) return true;
    let going = true;
    forEachChild(node, (child) => {
      if (going) going = visit(child);
    });
    return going;
  };
  for (const node of nodes) {
    // `visit` stops at the first HTML element.
    if (!visit(node)) return "html";
  }
  return namespace;
}

/** `infer_namespace` for the fragment `owner` holds. */
function infer(
  inherited: Namespace,
  owner: Node | null,
  nodes: readonly Node[],
  parentSvg: boolean | undefined,
): Namespace {
  if (owner?.type === "RegularElement" || owner?.type === "SvelteElement") {
    if (owner.type === "RegularElement" && owner.name === "foreignObject") {
      return "html";
    }
    return namespaceOf(owner, parentSvg);
  }
  if (owner === null || RESETS.has(owner.type)) {
    const found = checkNodes(nodes, parentSvg);
    if (found !== "keep" && found !== "maybe_html") return found;
  }
  let found: Namespace | null = null;
  for (const node of nodes) {
    if (node.type !== "RegularElement") continue;
    const own = namespaceOf(node, parentSvg);
    if (own === "html") return "html";
    found = found === null || found === own ? own : "html";
  }
  return found ?? inherited;
}

type Placed = { start: number; end: number; text: boolean; ns: Namespace };

/** Each element and text node, with the namespace of the fragment it's in. */
function place(root: AST.Root): Placed[] {
  const placed: Placed[] = [];
  const visit = (
    node: Node,
    owner: Node | null,
    inherited: Namespace,
    parentSvg: boolean | undefined,
  ) => {
    if (node.type === "Fragment") {
      const ns = infer(inherited, owner, node.nodes, parentSvg);
      for (const child of node.nodes) {
        if (child.type === "Text" || child.type === "RegularElement") {
          placed.push({
            start: child.start,
            end: child.end,
            text: child.type === "Text",
            ns,
          });
        }
        visit(child, node, ns, parentSvg);
      }
      return;
    }
    const svg =
      node.type === "RegularElement" ? isSvg(node, parentSvg) : parentSvg;
    forEachChild(node, (child) => {
      if (child.type === "Fragment") visit(child, node, inherited, svg);
      else visit(child, owner, inherited, parentSvg);
    });
  };
  visit(root.fragment, null, "html", undefined);
  return placed;
}

/** Where offset `at` of `mapped`'s text was copied from, if it was. */
function sourceOffset(mapped: MappedText, at: number): number | undefined {
  let low = 0;
  let high = mapped.runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [out, from, length] = mapped.runs[mid];
    if (at < out) high = mid - 1;
    else if (at >= out + length) low = mid + 1;
    else return from + at - out;
  }
  return undefined;
}

/**
 * Whether an element or text node the rewrite copied sits in a fragment of
 * another namespace than it did. `rewritten` is `mapped`'s text, parsed.
 */
export function namespacesChanged(
  original: AST.Root,
  rewritten: AST.Root,
  mapped: MappedText,
): boolean {
  const before = place(original);
  const elements = new Map<number, Namespace>();
  const texts: Placed[] = [];
  for (const node of before) {
    if (node.text) texts.push(node);
    else elements.set(node.start, node.ns);
  }
  const textAt = (offset: number) => {
    let low = 0;
    let high = texts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (offset < texts[mid].start) high = mid - 1;
      else if (offset >= texts[mid].end) low = mid + 1;
      else return texts[mid];
    }
    return undefined;
  };
  for (const node of place(rewritten)) {
    const from = sourceOffset(mapped, node.start);
    if (from === undefined) continue;
    const ns = node.text ? textAt(from)?.ns : elements.get(from);
    if (ns !== undefined && ns !== node.ns) return true;
  }
  return false;
}
