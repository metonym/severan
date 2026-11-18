/**
 * Prunes a library's stylesheets for what the app can render: a rule goes
 * when every selector in it needs a class the library's stylesheets define
 * that nothing can render. Classes the stylesheets don't define (the app's
 * own, Svelte's scoping hashes, other packages') never remove a rule.
 */
import { globSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { filterCss } from "caligula";
import { type ParsedSelector, parseSelectorList } from "caligula/selector";
import { classTokensOf, type LibrarySpec } from "./library-paths";
import { requirePackageDir } from "./package";

type PrunedStyles = {
  css: string;
  /** Rules removed whole, `@keyframes` included. */
  rules: number;
  /** Selectors removed from rules that stay. */
  selectors: number;
  /** Custom property declarations removed. */
  declarations: number;
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

/** What a library's stylesheets define, of what the pruner may remove. */
type Defined = {
  /** Classes their selectors name, required or negated. */
  classes: Set<string>;
  /** Custom properties they declare (`--x`). */
  properties: Set<string>;
  /** `@keyframes` names. */
  keyframes: Set<string>;
};

function newDefined(): Defined {
  return { classes: new Set(), properties: new Set(), keyframes: new Set() };
}

const KEYFRAMES = /^(?:-[a-z]+-)?keyframes$/i;

/** Adds what `css` defines to `into`. */
function definedIn(css: string, into: Defined): void {
  filterCss(css, {
    discardEmpty: false,
    rule: ({ parsed }) => {
      for (const selector of parsed) {
        for (const { classes, negated } of selector.compounds) {
          for (const cls of classes) into.classes.add(cls);
          for (const cls of negated) into.classes.add(cls);
        }
      }
    },
    atRule: ({ name, params }) => {
      if (KEYFRAMES.test(name)) into.keyframes.add(unquote(params.trim()));
    },
    decl: ({ prop }) => {
      if (prop.startsWith("--")) into.properties.add(prop);
    },
  });
}

/** Every class `css`'s selectors name, required or negated. */
export function definedClasses(css: string, into: Set<string>): void {
  const defined = newDefined();
  definedIn(css, defined);
  for (const cls of defined.classes) into.add(cls);
}

const QUOTED = /^(["']).*\1$/;

function unquote(text: string): string {
  return QUOTED.test(text) ? text.slice(1, -1) : text;
}

/** What may read a custom property or `@keyframes` from outside the CSS. */
type ExternalReads = {
  /** Words (`[\w-]+`, `--x` included) in the app's files and the library's sources. */
  words: Set<string>;
  /** Custom property prefixes a source builds names from (`--tone-` in `` `--tone-${t}` ``). */
  propertyPrefixes: string[];
};

const WORD = /[\w-]+/g;
/** `--tone-` before `${…}` or a quote and `+`: a name built at runtime. */
const BUILT_PROPERTY = /(--[\w-]*)(?:\$\{|["'`]\s*\+)/g;

/** Adds what `code` may read to `into`. */
function readsIn(code: string, into: ExternalReads): void {
  for (const [word] of code.matchAll(WORD)) into.words.add(word);
  for (const [, prefix] of code.matchAll(BUILT_PROPERTY)) {
    into.propertyPrefixes.push(prefix);
  }
}

const VAR_READ = /var\(\s*(--[\w-]+)/g;
const MAX_PASSES = 8;

/**
 * Removes the custom properties `defined` declares that nothing reads (no
 * `var()` left in `css`, nothing in `external`), until none is left, and
 * the `@keyframes` it defines that no declaration left names. Returns the
 * CSS and what it removed.
 */
function pruneUnread(
  css: string,
  defined: Defined,
  external: ExternalReads,
): { css: string; rules: number; declarations: number } {
  const readOutside = (property: string) =>
    external.words.has(property) ||
    external.propertyPrefixes.some((prefix) => property.startsWith(prefix));
  let rules = 0;
  let declarations = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const read = new Set<string>();
    const words = new Set<string>();
    const scan = (text: string) => {
      for (const [, property] of text.matchAll(VAR_READ)) read.add(property);
      for (const [word] of text.matchAll(WORD)) words.add(word);
    };
    filterCss(css, {
      discardEmpty: false,
      // A `@keyframes` rule's name isn't a read of it.
      atRule: ({ name, params }) => {
        if (!KEYFRAMES.test(name)) scan(params);
      },
      decl: ({ value }) => {
        scan(value);
      },
    });
    let removed = 0;
    const result = filterCss(css, {
      atRule: ({ name, params }) => {
        if (!KEYFRAMES.test(name)) return undefined;
        const keyframes = unquote(params.trim());
        if (
          !defined.keyframes.has(keyframes) ||
          words.has(keyframes) ||
          external.words.has(keyframes)
        ) {
          return undefined;
        }
        rules++;
        removed++;
        return false;
      },
      decl: ({ prop }) => {
        if (
          !prop.startsWith("--") ||
          !defined.properties.has(prop) ||
          read.has(prop) ||
          readOutside(prop)
        ) {
          return undefined;
        }
        declarations++;
        removed++;
        return false;
      },
    });
    css = result.css;
    if (removed === 0) break;
  }
  return { css, rules, declarations };
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
  /** Selectors kept whole whatever their classes (see `safelist`). */
  keep: (selector: string) => boolean = () => false,
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
    if (keep(selector.text)) return true;
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
    return { css: result.css, rules, selectors, declarations: 0 };
  };
}

/**
 * A `safelist` entry: a class (`"x--grid"` or `".x--grid"`), which keeps
 * every selector it appears in, or a RegExp tested against each selector.
 */
export type SafelistEntry = string | RegExp;

/** Continues a class token: `.x--grid` isn't in `.x--grid-narrow`. */
const CLASS_CHAR = /[\w-]/;

/** Whether `selector` names class `cls` (escaped as CSS writes it) whole. */
function namesClass(selector: string, cls: string): boolean {
  const name = `.${cls.replace(/[^\w-]/g, "\\$&")}`;
  for (
    let at = selector.indexOf(name);
    at !== -1;
    at = selector.indexOf(name, at + 1)
  ) {
    const next = selector[at + name.length];
    if (next === undefined || !CLASS_CHAR.test(next)) return true;
  }
  return false;
}

/** Whether `selector` matches an entry of `safelist`. */
export function isSafelisted(
  selector: string,
  safelist: readonly SafelistEntry[],
): boolean {
  return safelist.some((entry) => {
    if (typeof entry === "string") {
      return namesClass(
        selector,
        entry.startsWith(".") ? entry.slice(1) : entry,
      );
    }
    // A `g` or `y` RegExp carries `lastIndex` from its last test.
    entry.lastIndex = 0;
    return entry.test(selector);
  });
}

/**
 * The pruner for `spec`'s stylesheets: a class goes when they define it,
 * `isPruned` says nothing renders it, and neither `content` nor `keep`
 * names it. A selector `safelist` matches stays whole.
 */
export function libraryStylePruner(input: {
  spec: LibrarySpec;
  projectRoot: string;
  isPruned: (cls: string) => boolean;
  /** Files whose class names stay: the app's, as `content` reads them. */
  files: Iterable<{ code: string }>;
  safelist?: readonly SafelistEntry[];
}): StylePruner | undefined {
  const { spec, projectRoot, isPruned } = input;
  const tokens = classTokensOf(spec);
  if (!spec.styles || !tokens) return undefined;
  const library = newDefined();
  for (const file of stylesheetFiles(spec.styles.stylesheets, projectRoot)) {
    definedIn(readFileSync(file, "utf8"), library);
  }
  const defined = library.classes;
  // Custom properties and keyframes the app's files or the library's own
  // sources name stay: a script may read or set them.
  const external: ExternalReads = { words: new Set(), propertyPrefixes: [] };
  for (const { code } of input.files) readsIn(code, external);
  for (const code of librarySources(spec, projectRoot)) readsIn(code, external);
  // What the app's files name stays: a class it writes itself, or passes
  // to a component.
  const named = new Set<string>(spec.styles.keep ?? []);
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
  const safelist = input.safelist ?? [];
  const pruneRules = createStylePruner(
    (cls) =>
      defined.has(cls) &&
      !named.has(cls) &&
      readable(cls) &&
      isPruned(`.${cls}`),
    safelist.length > 0
      ? (selector) => isSafelisted(selector, safelist)
      : undefined,
  );
  return (css) => {
    const pruned = pruneRules(css);
    const unread = pruneUnread(pruned.css, library, external);
    return {
      css: unread.css,
      rules: pruned.rules + unread.rules,
      selectors: pruned.selectors,
      declarations: unread.declarations,
    };
  };
}

const SOURCE = /\.(?:svelte|[cm]?[jt]s)$/;

/** The library's `.svelte` and script files, as text. */
function librarySources(spec: LibrarySpec, projectRoot: string): string[] {
  const src = path.join(requirePackageDir(spec.name, projectRoot), spec.srcDir);
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => SOURCE.test(file) && !file.includes("node_modules"))
    .map((file) => readFileSync(path.join(src, file), "utf8"));
}
