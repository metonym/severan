/**
 * Prunes a library's stylesheets for what the app can render: a rule goes
 * when every selector in it needs a class the library's stylesheets define
 * that nothing can render. Classes the stylesheets don't define (the app's
 * own, Svelte's scoping hashes, other packages') never remove a rule.
 */
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { filterCss } from "caligula";
import { type ParsedSelector, parseSelectorList } from "caligula/selector";
import { classTokensOf, type LibrarySpec } from "./library-paths";
import { requirePackageDir } from "./package";

type PrunedStyles = {
  css: string;
  /** Rules removed whole. */
  rules: number;
  /** Selectors removed from rules that stay. */
  selectors: number;
};

/** Removes the rules of `css` that need a class nothing can render. */
export type StylePruner = (css: string) => PrunedStyles;

/** The files `stylesheets` name, each `"<package>/<path>"` with `*` within a segment. */
export function stylesheetFiles(
  stylesheets: readonly string[],
  projectRoot: string,
): string[] {
  const files = new Set<string>();
  for (const stylesheet of stylesheets) {
    const parts = stylesheet.split("/");
    const nameLength = stylesheet.startsWith("@") ? 2 : 1;
    const name = parts.slice(0, nameLength).join("/");
    const rest = parts.slice(nameLength).join("/");
    if (!rest) {
      throw new Error(
        `\`styles.stylesheets\` names "${stylesheet}", not a file in a package.`,
      );
    }
    const dir = requirePackageDir(name, projectRoot);
    const found = rest.includes("*")
      ? globSync(rest, { cwd: dir })
      : [rest].filter((file) => {
          try {
            readFileSync(path.join(dir, file));
            return true;
          } catch {
            return false;
          }
        });
    if (found.length === 0) {
      throw new Error(
        `\`styles.stylesheets\` names "${stylesheet}", which matches no file.`,
      );
    }
    for (const file of found) files.add(path.join(dir, file));
  }
  return [...files];
}

/** Every class `css`'s selectors name, required or negated. */
export function definedClasses(css: string, into: Set<string>): void {
  filterCss(css, {
    discardEmpty: false,
    rule: ({ parsed }) => {
      for (const selector of parsed) {
        for (const { classes, negated } of selector.compounds) {
          for (const cls of classes) into.add(cls);
          for (const cls of negated) into.add(cls);
        }
      }
    },
  });
}

/**
 * The list inside a selector that is one `:is(…)` or `:where(…)` and
 * nothing else, as minifiers emit when they merge rules
 * (`:is(.a .b, .c .d)`); `undefined` for any other selector.
 */
export function wrappedList(text: string): string | undefined {
  const open = text.startsWith(":is(")
    ? 3
    : text.startsWith(":where(")
      ? 6
      : -1;
  if (open === -1 || !text.endsWith(")")) return undefined;
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")" && --depth === 0) {
      return i === text.length - 1
        ? text.slice(open + 1, text.length - 1)
        : undefined;
    }
  }
  return undefined;
}

/** A pruner that drops what needs a class `removable` accepts. */
export function createStylePruner(
  removable: (cls: string) => boolean,
): StylePruner {
  const verdicts = new Map<string, boolean>();
  const gone = (cls: string) => {
    let verdict = verdicts.get(cls);
    if (verdict === undefined) {
      verdict = removable(cls);
      verdicts.set(cls, verdict);
    }
    return verdict;
  };
  // An element matches a compound only with every class it requires, and
  // an `:is()` list wrapping a whole selector matches if any branch can.
  const canMatch = (selector: ParsedSelector): boolean => {
    const list = wrappedList(selector.text);
    if (list !== undefined) return parseSelectorList(list).some(canMatch);
    return selector.compounds.every(({ classes }) => !classes.some(gone));
  };
  return (css) => {
    let rules = 0;
    let selectors = 0;
    const result = filterCss(css, {
      rule: ({ selector, parsed }) => {
        if (!selector.includes(".")) return undefined;
        const kept = parsed.filter(canMatch);
        if (kept.length === parsed.length) return undefined;
        if (kept.length === 0) {
          rules++;
          return false;
        }
        selectors += parsed.length - kept.length;
        return kept.map(({ text }) => text).join(", ");
      },
    });
    return { css: result.css, rules, selectors };
  };
}

/**
 * The pruner for `spec`'s stylesheets: a class goes when they define it,
 * `isPruned` says nothing renders it, and neither `content` nor `keep` nor
 * `safelist` names it.
 */
export function libraryStylePruner(input: {
  spec: LibrarySpec;
  projectRoot: string;
  isPruned: (cls: string) => boolean;
  files: Iterable<{ code: string }>;
  safelist?: readonly string[];
}): StylePruner | undefined {
  const { spec, projectRoot, isPruned } = input;
  const tokens = classTokensOf(spec);
  if (!spec.styles || !tokens) return undefined;
  const defined = new Set<string>();
  for (const file of stylesheetFiles(spec.styles.stylesheets, projectRoot)) {
    definedClasses(readFileSync(file, "utf8"), defined);
  }
  // What the app's files name stays: a class it writes itself, or passes
  // to a component.
  const named = new Set<string>([
    ...(spec.styles.keep ?? []),
    ...(input.safelist ?? []),
  ]);
  for (const { code } of input.files) {
    if (!code.includes(tokens.marker)) continue;
    for (const token of tokens.text(code)) {
      named.add(token.startsWith(".") ? token.slice(1) : token);
    }
  }
  // Only a class the library's tokens can name may go: a class they never
  // read (one outside `classTokens`' namespace) is never known not to render.
  const readable = (cls: string) =>
    cls.includes(tokens.marker) && tokens.text(cls).includes(`.${cls}`);
  return createStylePruner(
    (cls) =>
      defined.has(cls) &&
      !named.has(cls) &&
      readable(cls) &&
      isPruned(`.${cls}`),
  );
}
