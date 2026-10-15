import { createParser } from "sveast/core";
import { typescript } from "sveast/typescript";
import { type AST, forEachChild } from "sveast/walk";

export type Node = AST.SvelteNode;

/**
 * sveast without its HTML entity table: the indexer reads class names, which
 * never hold a named character reference. TypeScript stays in, so a library
 * release that adds `<script lang="ts">` still parses.
 */
export const { parse } = createParser({ typescript });

/** Calls `visit` on `node` and every descendant, depth-first. */
export function forEachNode(
  node: Node | null | undefined,
  visit: (node: Node) => void,
): void {
  if (!node) return;
  const visitNode = (child: Node) => {
    visit(child);
    forEachChild(child, visitNode);
  };
  visitNode(node);
}
