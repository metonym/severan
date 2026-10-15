import { statSync } from "node:fs";
import path from "node:path";
import {
  createExportResolver,
  type Export,
  type ExportResolver,
} from "./exports";
import { LibraryPaths, type LibrarySpec, libraryPaths } from "./library-paths";
import { installedMajor, requirePackageDir } from "./package";
import { readPackageExports } from "./package-exports";

export class Library extends LibraryPaths {
  readonly root: string;
  /** Export name -> module key in `srcDir` (`Button` -> `Button/Button.svelte`). */
  readonly components: ReadonlyMap<string, string>;

  constructor(
    spec: LibrarySpec,
    root: string,
    components: ReadonlyMap<string, string>,
  ) {
    super(spec);
    this.root = root;
    this.components = components;
  }

  get src(): string {
    return path.join(this.root, this.spec.srcDir);
  }

  private exports?: ExportResolver;

  exportOf(name: string): Export {
    this.exports ??= createExportResolver(this.src);
    return this.exports.exportOf(this.spec.barrel, name);
  }

  private svelte?: { major: number | undefined };

  /** Resolved from the library's root: it decides whether content is passed as `children` (Svelte 5). */
  get svelteMajor(): number | undefined {
    this.svelte ??= { major: installedMajor("svelte", this.root) };
    return this.svelte.major;
  }
}

const componentsCache = new Map<
  string,
  { mtimeMs: number; components: ReadonlyMap<string, string> }
>();

/** Cached by the barrel's mtime, so a linked checkout edited between watch rebuilds is reread. */
export function libraryAt(spec: LibrarySpec, root: string): Library {
  const barrel = path.join(root, spec.srcDir, spec.barrel);
  const { mtimeMs } = statSync(barrel);
  const cacheKey = `${spec.name}\0${root}`;
  let cached = componentsCache.get(cacheKey);
  if (cached?.mtimeMs !== mtimeMs) {
    const components = new Map<string, string>();
    const prefix = libraryPaths(spec).srcPrefix;
    for (const [name, target] of readPackageExports(root, spec)) {
      if (target.name === "default" && target.path.endsWith(".svelte")) {
        components.set(name, target.path.slice(prefix.length));
      }
    }
    cached = { mtimeMs, components };
    componentsCache.set(cacheKey, cached);
  }
  return new Library(spec, root, cached.components);
}

export function loadLibrary(spec: LibrarySpec, projectRoot: string): Library {
  return libraryAt(spec, requirePackageDir(spec.name, projectRoot));
}
