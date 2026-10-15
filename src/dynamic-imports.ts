import { lexComponent, lexDynamicImports } from "sveast/lexer";

/** An `import(…)`, a `require(…)` or Vite's `import.meta.glob(…)`. */
export type DynamicImport = {
  kind: "import" | "require" | "glob";
  /** The literal first argument; `null` when it's computed. */
  source: string | null;
  /** The offset of `import` or `require`. */
  start: number;
  /** The offset after the closing `)`. */
  end: number;
};

type Span = { start: number; end: number };

const NONE: readonly DynamicImport[] = [];

/** `import` or `require` before a `(`, a `.` (`import.meta`) or a comment. */
const MAY_IMPORT = /\b(?:import|require)\s*(?:[(.]|\/[*/])/;

/** Most modules have no call: they're skipped without lexing. */
function mayImport(code: string): boolean {
  return MAY_IMPORT.test(code);
}

/** A script module's calls, lexed: none in a comment or a string. */
export function scriptDynamicImports(code: string): readonly DynamicImport[] {
  return mayImport(code) ? lexed(code, 0) : NONE;
}

function lexed(code: string, offset: number): DynamicImport[] {
  return lexDynamicImports(code).map((call) => ({
    kind: call.kind,
    source: call.source?.value ?? null,
    start: call.start + offset,
    end: call.end + offset,
  }));
}

/**
 * A component's calls: its scripts lexed, its markup read as text (the
 * lexer would take an apostrophe or a URL in it for a string or a comment,
 * and miss what follows). `scripts` are the scripts' contents, from
 * `lexComponent` by default.
 */
export function componentDynamicImports(
  code: string,
  scripts?: readonly Span[],
): readonly DynamicImport[] {
  if (!mayImport(code)) return NONE;
  const calls: DynamicImport[] = [];
  let at = 0;
  for (const script of [...(scripts ?? scriptContents(code))].sort(
    (a, b) => a.start - b.start,
  )) {
    calls.push(...textDynamicImports(code, at, script.start));
    calls.push(...lexed(code.slice(script.start, script.end), script.start));
    at = script.end;
  }
  calls.push(...textDynamicImports(code, at, code.length));
  return calls;
}

function scriptContents(code: string): Span[] {
  const { module, instance } = lexComponent(code);
  return [module, instance].flatMap((script) =>
    script ? [script.content] : [],
  );
}

const TEXT_IMPORT = /\b(?:(import|require)\s*\(|import\.meta\.glob\b)/g;
/** A literal argument, read from just after the `(`. */
const LITERAL_ARGUMENT = /\s*(["'`])([^"'`$]+)\1\s*\)/y;

/**
 * The calls in text that may not be a module (markup, or a file that
 * doesn't parse), from `from` to `to`: every match, in comments and strings
 * too, so none is missed. A computed call ends at the first `)`.
 */
export function textDynamicImports(
  code: string,
  from = 0,
  to = code.length,
): DynamicImport[] {
  const calls: DynamicImport[] = [];
  TEXT_IMPORT.lastIndex = from;
  for (
    let match = TEXT_IMPORT.exec(code);
    match && match.index < to;
    match = TEXT_IMPORT.exec(code)
  ) {
    const start = match.index;
    const kind = match[1] as "import" | "require" | undefined;
    if (!kind) {
      calls.push({
        kind: "glob",
        source: null,
        start,
        end: TEXT_IMPORT.lastIndex,
      });
      continue;
    }
    LITERAL_ARGUMENT.lastIndex = TEXT_IMPORT.lastIndex;
    const literal = LITERAL_ARGUMENT.exec(code);
    if (literal) {
      calls.push({
        kind,
        source: literal[2],
        start,
        end: LITERAL_ARGUMENT.lastIndex,
      });
      continue;
    }
    const close = code.indexOf(")", TEXT_IMPORT.lastIndex);
    calls.push({
      kind,
      source: null,
      start,
      end: close === -1 ? code.length : close + 1,
    });
  }
  return calls;
}
