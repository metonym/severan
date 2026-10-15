/**
 * Text that remembers which source slices it was built from, so a rewrite
 * can hand the bundler a source map without a dependency.
 */

/** `[outStart, sourceStart, length]`, in order in both texts. */
type Run = readonly [number, number, number];

export type MappedText = { text: string; runs: Run[] };

export type SourceMap = {
  version: 3;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
};

export function sliceOf(
  source: string,
  start: number,
  end: number,
): MappedText {
  return {
    text: source.slice(start, end),
    runs: end > start ? [[0, start, end - start]] : [],
  };
}

export function concat(...parts: Array<MappedText | string>): MappedText {
  let text = "";
  const runs: Run[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    for (const [out, from, length] of part.runs) {
      runs.push([out + text.length, from, length]);
    }
    text += part.text;
  }
  return { text, runs };
}

export type Splice = { start: number; end: number; text?: string };

/** Replaces sorted, non-overlapping ranges; inserted text isn't mapped. */
export function splice(
  input: MappedText,
  edits: readonly Splice[],
): MappedText {
  if (edits.length === 0) return input;
  let text = "";
  let cursor = 0;
  /** `[inStart, inEnd, outStart]` of each kept input range. */
  const kept: Array<readonly [number, number, number]> = [];
  for (const edit of edits) {
    kept.push([cursor, edit.start, text.length]);
    text += input.text.slice(cursor, edit.start) + (edit.text ?? "");
    cursor = edit.end;
  }
  kept.push([cursor, input.text.length, text.length]);
  text += input.text.slice(cursor);

  const runs: Run[] = [];
  for (const [out, from, length] of input.runs) {
    for (const [inStart, inEnd, outStart] of kept) {
      const start = Math.max(out, inStart);
      const end = Math.min(out + length, inEnd);
      if (start < end) {
        runs.push([
          outStart + start - inStart,
          from + start - out,
          end - start,
        ]);
      }
    }
  }
  return { text, runs };
}

/** Removes every match of the global `pattern` in `[from, to)` of the text. */
export function removeMatches(
  input: MappedText,
  pattern: RegExp,
  from = 0,
  to = input.text.length,
): MappedText {
  const edits: Splice[] = [];
  for (const match of input.text.slice(from, to).matchAll(pattern)) {
    const start = from + match.index;
    edits.push({ start, end: start + match[0].length });
  }
  return splice(input, edits);
}

/**
 * Copied text gets a mapping at every word (like magic-string's `hires:
 * "boundary"`); inserted text maps to the source it replaced.
 */
export function toSourceMap(
  mapped: MappedText,
  source: string,
  sourceName: string,
): SourceMap {
  const builder = new MappingsBuilder();
  const { text } = mapped;
  let out = 0;
  let from = 0;
  for (const [runOut, runFrom, length] of mapped.runs) {
    // Runs follow the source in order; one that doesn't is left unmapped.
    if (runFrom < from) continue;
    if (runOut > out) {
      builder.replace(text.slice(out, runOut), source, from, runFrom);
    } else if (runFrom > from) {
      builder.skip(source, from, runFrom);
    }
    builder.copy(text.slice(runOut, runOut + length));
    out = runOut + length;
    from = runFrom + length;
  }
  if (out < text.length) {
    builder.replace(text.slice(out), source, from, source.length);
  }
  return {
    version: 3,
    sources: [sourceName],
    sourcesContent: [source],
    names: [],
    mappings: builder.toString(),
  };
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const COMMA = 44;
const SEMICOLON = 59;
const BASE64_A = 65;

/** Base64 digit of a non-negative one-digit VLQ (`value < 16`). */
const VLQ_DIGIT = new Uint8Array(16);
for (let value = 0; value < 16; value++) {
  VLQ_DIGIT[value] = BASE64_CHARS.charCodeAt(value << 1);
}

const WORD_CHAR = new Uint8Array(128);
for (let code = 0; code < 128; code++) {
  WORD_CHAR[code] =
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95
      ? 1
      : 0;
}

const ascii = new TextDecoder("latin1");

/** Shared across builders: `toSourceMap` is synchronous and never nested. */
const SCRATCH_RETAIN_LIMIT = 1 << 20;
let scratch = new Uint8Array(4096);

/** Writes ASCII bytes: appending a string per segment builds slow ropes. */
class MappingsBuilder {
  private buffer = scratch;
  private length = 0;
  private line = 0;
  private column = 0;
  private genColumn = 0;
  private lineHasSegments = false;
  // Previous segment's fields: mappings are delta-encoded.
  private prevGenColumn = 0;
  private prevLine = 0;
  private prevColumn = 0;

  copy(text: string): void {
    const length = text.length;
    if (length === 0) return;

    // Worst case is a segment per character: `,` + digit + `AA` + digit.
    // Longer segments (delta 16+) only follow 16+ characters that wrote none.
    this.reserve(length * 5 + 64);
    const buffer = this.buffer;
    let out = this.length;

    // The generated column is `column + offset` until a newline resets both.
    let column = this.column;
    let offset = this.genColumn - column;
    let prevColumn = this.prevColumn;
    let inWord = false;
    let sameLine = false;

    for (let i = 0; i < length; i++) {
      const code = text.charCodeAt(i);

      if (code === 10) {
        buffer[out++] = SEMICOLON;
        this.line++;
        column = 0;
        offset = 0;
        this.prevGenColumn = 0;
        this.lineHasSegments = false;
        inWord = false;
        sameLine = false;
        continue;
      }

      const word = code < 128 && WORD_CHAR[code] === 1;
      if (!word || !inWord) {
        if (sameLine) {
          // After the first segment on a line: `,<vlq(d)>AA<vlq(d)>`.
          const delta = column - prevColumn;
          buffer[out++] = COMMA;
          if (delta < 16) {
            const digit = VLQ_DIGIT[delta];
            buffer[out++] = digit;
            buffer[out++] = BASE64_A;
            buffer[out++] = BASE64_A;
            buffer[out++] = digit;
          } else {
            out = writeVlq(buffer, out, delta);
            buffer[out++] = BASE64_A;
            buffer[out++] = BASE64_A;
            out = writeVlq(buffer, out, delta);
          }
          prevColumn = column;
        } else {
          this.length = out;
          this.column = column;
          this.genColumn = column + offset;
          this.prevColumn = prevColumn;
          this.addSegment();
          out = this.length;
          prevColumn = column;
          sameLine = true;
        }
      }
      inWord = word;
      column++;
    }

    this.length = out;
    this.column = column;
    this.genColumn = column + offset;
    this.prevColumn = prevColumn;
    if (sameLine) this.prevGenColumn = prevColumn + offset;
  }

  replace(content: string, original: string, start: number, end: number): void {
    this.addSegment();

    let lineStart = 0;
    let newline = content.indexOf("\n");
    while (newline !== -1) {
      lineStart = newline + 1;
      // Each further line maps to the same original position (all deltas
      // zero); a trailing newline leaves an empty last line with no segment.
      this.reserve(5);
      const buffer = this.buffer;
      buffer[this.length++] = SEMICOLON;
      if (lineStart < content.length) {
        buffer[this.length++] = BASE64_A;
        buffer[this.length++] = BASE64_A;
        buffer[this.length++] = BASE64_A;
        buffer[this.length++] = BASE64_A;
      }
      newline = content.indexOf("\n", lineStart);
    }

    if (lineStart === 0) {
      this.genColumn += content.length;
    } else {
      this.genColumn = content.length - lineStart;
      this.prevGenColumn = 0;
      this.lineHasSegments = lineStart < content.length;
    }

    this.skip(original, start, end);
  }

  skip(original: string, start: number, end: number): void {
    let lastNewline = -1;
    let newline = original.indexOf("\n", start);
    while (newline !== -1 && newline < end) {
      this.line++;
      lastNewline = newline;
      newline = original.indexOf("\n", newline + 1);
    }
    this.column =
      lastNewline === -1 ? this.column + (end - start) : end - lastNewline - 1;
  }

  private addSegment(): void {
    const { genColumn, line, column } = this;
    // Three VLQs of at most 6 digits, plus separators.
    this.reserve(25);
    const buffer = this.buffer;
    let out = this.length;
    if (this.lineHasSegments) buffer[out++] = COMMA;
    out = writeVlq(buffer, out, genColumn - this.prevGenColumn);
    buffer[out++] = BASE64_A;
    out = writeVlq(buffer, out, line - this.prevLine);
    out = writeVlq(buffer, out, column - this.prevColumn);
    this.length = out;
    this.lineHasSegments = true;
    this.prevGenColumn = genColumn;
    this.prevLine = line;
    this.prevColumn = column;
  }

  private reserve(bytes: number): void {
    const needed = this.length + bytes;
    if (needed <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    if (size <= SCRATCH_RETAIN_LIMIT) scratch = next;
  }

  toString(): string {
    return ascii.decode(this.buffer.subarray(0, this.length));
  }
}

function writeVlq(buffer: Uint8Array, out: number, value: number): number {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    buffer[out++] = BASE64_CHARS.charCodeAt(digit);
  } while (vlq > 0);
  return out;
}
