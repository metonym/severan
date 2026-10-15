import { realpathSync } from "node:fs";

export const RE_EXT_SVELTE = /\.svelte$/;

export const RE_EXT_JS = /\.js$/;

const RE_MODULE_QUERY = /[?#].*$/;

/** `.css` and the preprocessor files a bundler compiles to CSS. */
export const RE_EXT_STYLESHEET =
  /\.(css|scss|sass|less|styl|stylus|pcss|postcss)$/;

export function isSvelteFile(id: string): id is `${string}.svelte` {
  return RE_EXT_SVELTE.test(id);
}

/** `App.svelte?svelte&type=style&lang.css` -> `App.svelte`. */
export function stripQuery(id: string): string {
  return id.replace(RE_MODULE_QUERY, "");
}

export function realpath(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The key a bundler-resolved import is recorded under: `import … from source` in file `from`. */
export function importKey(from: string, source: string): string {
  return `${from}\0${source}`;
}
