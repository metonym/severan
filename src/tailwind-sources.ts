/**
 * Tailwind generates a utility for every class string it scans, and an app
 * points it at the library's files on disk. With Tailwind installed, each
 * build writes what of the library can render to `node_modules/.severan/<name>`:
 * its script modules and the components that can render, rewritten where
 * severan rewrote them. An `@source` (or v3 `content` glob) there, in place
 * of the package's own directory, leaves out the classes that can't render.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Library } from "./library";
import type { LibrarySpec } from "./library-paths";
import { realpath } from "./util";
import { scriptRendersComponents } from "./variant-tables";

const MODULE_SCRIPT = /<script\b[^>]*\b(?:module|context=["']module["'])/;

/** Where Tailwind should scan instead of the package. */
function tailwindSourcesDir(root: string, spec: LibrarySpec): string {
  return path.join(root, "node_modules", ".severan", spec.name);
}

export type Rewrite = {
  /** Rewritten sources, by real path. */
  sources: ReadonlyMap<string, { code: string }>;
  /** Module keys of the components that can render. */
  liveComponents: ReadonlySet<string>;
};

/** Files no class renders from. */
const NEVER_RENDERED = /\.d\.[cm]?ts$|\.map$/;

/** Every file in `dir`, by path relative to it with `/`. */
async function listFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    );
}

/**
 * The library's files as Tailwind should see them, by key: every module but
 * the components that can't render (one with a `<script module>` may be
 * imported for what it exports, so stays). Without `rewrite`, all of them as
 * they are.
 */
async function sourcesFor(
  library: Library,
  rewrite: Rewrite | undefined,
): Promise<Map<string, string>> {
  const src = realpath(library.src) ?? library.src;
  // A script module that mounts a component renders it where no call site shows.
  const everyComponent =
    !rewrite || (await scriptRendersComponents(library)) !== undefined;
  const files = new Map<string, string>();
  await Promise.all(
    (await listFiles(src)).map(async (key) => {
      if (NEVER_RENDERED.test(key)) return;
      const file = path.join(src, key);
      const rewritten = rewrite?.sources.get(file)?.code;
      if (rewritten !== undefined) {
        files.set(key, rewritten);
        return;
      }
      const code = await readFile(file, "utf8");
      if (
        everyComponent ||
        !key.endsWith(".svelte") ||
        rewrite?.liveComponents.has(key) ||
        MODULE_SCRIPT.test(code)
      ) {
        files.set(key, code);
      }
    }),
  );
  return files;
}

/** Makes `dir` hold exactly `files`, rewriting only what changed. */
async function sync(dir: string, files: ReadonlyMap<string, string>) {
  let existing: string[] = [];
  try {
    existing = await listFiles(dir);
  } catch {
    // Not written yet.
  }
  await Promise.all(
    existing
      .filter((key) => !files.has(key))
      .map((key) => rm(path.join(dir, key), { force: true })),
  );
  const present = new Set(existing);
  await Promise.all(
    [...files].map(async ([key, code]) => {
      const file = path.join(dir, key);
      if (present.has(key)) {
        try {
          if ((await readFile(file, "utf8")) === code) return;
        } catch {
          // Gone since it was listed.
        }
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, code);
    }),
  );
}

/** Writes the library for Tailwind to scan; every module as it is without `rewrite`. */
export async function writeTailwindSources(
  library: Library,
  root: string,
  rewrite?: Rewrite,
): Promise<void> {
  await sync(
    tailwindSourcesDir(root, library.spec),
    await sourcesFor(library, rewrite),
  );
}
