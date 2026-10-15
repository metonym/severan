import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  Failure,
  RewrittenSource,
  SpecializedComponents,
} from "./analysis";
import { collectLibraryImports } from "./imports";
import {
  type LibraryImport,
  type LibraryPaths,
  type LibrarySpec,
  libraryPaths,
} from "./library-paths";
import { installedMajor } from "./package";
import { importKey, RE_EXT_STYLESHEET, realpath, stripQuery } from "./util";

export type SeveranOptions = {
  /**
   * Globs (relative to the project root) of every file that renders the
   * library's components; a module outside them that imports one fails the
   * build. Components imported from script, Markdown, MDX or Astro files
   * keep every prop value. `node_modules` is skipped unless a pattern names it.
   * @default ["src/**\/*.{svelte,svx,md,mdx,astro,js,jsx,ts,tsx,mjs,mts,cjs,cts}"]
   */
  content?: string[];

  /**
   * Replace an `{#if}` whose only live branch is known with that branch.
   * Svelte 5 only: Svelte 3/4 render whitespace differently without the block.
   * @default true when the installed Svelte is 5 or later
   */
  unwrap?: boolean;

  /** Skip the per-build summary. @default false */
  silent?: boolean;

  /**
   * Print what each build rewrote: edits, child components no longer rendered
   * or bundled, and each call site's prop values. Independent of `silent`.
   * @default false
   */
  report?: boolean;
};

const DEFAULT_CONTENT = [
  "src/**/*.{svelte,svx,md,mdx,astro,js,jsx,ts,tsx,mjs,mts,cjs,cts}",
];
const PATH_SEPARATOR = /[\\/]/;
const ROLLUP_VIRTUAL_PREFIX = /^\0/;
/** Files whose imports `collectLibraryImports` can lex. */
const LEXABLE = /\.(svelte|[cm]?[jt]sx?)$/;
const ALIAS_SVELTE_IMPORT =
  /\b(?:from|import)\s*["']([^"'./][^"']*\.svelte)["']/g;

const isInNodeModules = (file: string) =>
  file.split(PATH_SEPARATOR).includes("node_modules");

/** Whether module `id`, `file` without its query, has no file on disk. */
const isVirtual = (id: string, file: string) =>
  id.startsWith("\0") || !path.isAbsolute(file);

function globContent(patterns: string[], cwd: string): string[] {
  const named = patterns.filter((pattern) => pattern.includes("node_modules"));
  const rest = patterns.filter((pattern) => !named.includes(pattern));
  return [
    ...new Set([
      ...(rest.length > 0
        ? globSync(rest, { cwd, exclude: isInNodeModules })
        : []),
      ...(named.length > 0 ? globSync(named, { cwd }) : []),
    ]),
  ];
}

/**
 * Virtual modules are JS, so they're lexed too: merely mentioning the package
 * doesn't count. In Markdown, MDX or Astro any import of it counts.
 */
function importsLibrary(
  library: LibraryPaths,
  file: string,
  code: string,
  virtual: boolean,
): boolean {
  if (!code.includes(library.name)) return false;
  if (!virtual && !LEXABLE.test(file)) {
    return library.patterns.importText.test(code);
  }
  const imported = new Set<string>();
  return (
    collectLibraryImports(library.spec, code, imported) || imported.size > 0
  );
}

export type ImportResolver = (
  source: string,
  importer: string,
) => Promise<string | undefined>;

/** Aliased `.svelte` imports (`$lib/Card.svelte`) that land on one of `files`, by `importKey`. */
async function resolveAliases(
  library: LibraryPaths,
  files: Array<{ file: string; code: string }>,
  resolve: ImportResolver,
): Promise<Map<string, string>> {
  const byRealPath = new Map(
    files.map(({ file }) => [realpath(file) ?? file, file] as const),
  );
  const resolved = new Map<string, string>();
  const pending: Array<Promise<void>> = [];
  for (const { file, code } of files) {
    if (!code.includes(".svelte")) continue;
    for (const [, source] of code.matchAll(ALIAS_SVELTE_IMPORT)) {
      if (library.isComponentFile(source)) continue;
      pending.push(
        resolve(source, file).then(
          (id) => {
            if (!id) return;
            const target = stripQuery(id);
            const match = byRealPath.get(realpath(target) ?? target);
            if (match) resolved.set(importKey(file, source), match);
          },
          () => {},
        ),
      );
    }
  }
  await Promise.all(pending);
  return resolved;
}

export type PluginNames = {
  plugin: string;
  failure: Failure;
};

export const DEFAULT_NAMES: PluginNames = {
  plugin: "severan",
  failure: {
    feature: "severan",
    fallback: "components were bundled unchanged",
  },
};

function newBuild(root: string) {
  return {
    root,
    sources: new Map() as SpecializedComponents["sources"],
    analyzed: new Set<string>(),
    /** Files that render the library but weren't analyzed. */
    missed: new Set<string>(),
    /** Modules with no file that render the library. */
    virtual: new Set<string>(),
    /** Real paths of app components whose props came from analyzed call sites. */
    closed: new Set<string>(),
    /** Closed components rendered from somewhere else, and by what. */
    escaped: new Map<string, string[]>(),
    /** Analyzed files, by name, and the imports of the library in them it didn't read. */
    unread: new Map<string, Set<string>>(),
    readImport: (() => true) as SpecializedComponents["readImport"],
    realpaths: new Map<string, string | undefined>(),
  };
}

/** Shared by the Vite and webpack plugins. */
export function createComponentOptimizer(
  spec: LibrarySpec,
  options: SeveranOptions | undefined,
  names: PluginNames,
) {
  const name = names.plugin;
  const { label } = spec;
  const library = libraryPaths(spec);
  const content = options?.content ?? DEFAULT_CONTENT;
  let build = newBuild(process.cwd());
  /** Watch rebuilds and SvelteKit's second build reuse it unless `content` changed. */
  let last:
    | { hash: string; result: SpecializedComponents | { warning: string } }
    | undefined;

  const realpathOf = (file: string): string | undefined => {
    if (!build.realpaths.has(file)) build.realpaths.set(file, realpath(file));
    return build.realpaths.get(file);
  };
  const real = (file: string) => realpathOf(file) ?? file;
  const isAnalyzed = (id: string) => build.analyzed.has(real(stripQuery(id)));
  const relative = (file: string) => {
    const resolved = realpathOf(file);
    return resolved
      ? path.relative(real(build.root), resolved)
      : path.relative(build.root, file);
  };

  return {
    async prepare(
      root: string,
      /** The bundler's resolver, for aliased imports (`$lib/X.svelte`). */
      resolve?: ImportResolver,
    ): Promise<{ warning?: string; info?: string; report?: string[] }> {
      build = newBuild(root);
      const files: Array<{ file: string; code: string }> = [];
      const hash = createHash("sha1");
      for (const file of globContent(content, root)) {
        const absolute = path.resolve(root, file);
        let code: string;
        try {
          code = readFileSync(absolute, "utf8");
        } catch {
          continue; // A directory, or gone since the glob ran.
        }
        files.push({ file: absolute, code });
        hash.update(`${absolute}\0${code}\0`);
        build.analyzed.add(real(absolute));
      }

      const resolvedImports = resolve
        ? await resolveAliases(library, files, resolve)
        : undefined;
      for (const [key, file] of resolvedImports ?? []) {
        hash.update(`${key}\0${file}\0`);
      }

      const digest = hash.digest("hex");
      if (last?.hash !== digest) {
        // Loaded lazily: builds without this plugin never evaluate the analyzer.
        const { specializeFiles } = await import("./analysis");
        last = {
          hash: digest,
          result: await specializeFiles({
            library: spec,
            projectRoot: root,
            files,
            resolvedImports,
            failure: names.failure,
            options: {
              unwrap:
                options?.unwrap ?? (installedMajor("svelte", root) ?? 0) >= 5,
            },
          }),
        };
      }
      const { result } = last;
      if ("warning" in result) return { warning: result.warning };
      build.sources = result.sources;
      build.readImport = result.readImport;
      build.closed = new Set([...result.closed].map(real));
      return {
        info: options?.silent
          ? undefined
          : `rewrote ${result.sources.size - result.apps} ${label} components${result.apps > 0 ? ` and ${result.apps} of the app's own` : ""} for this app (${result.edits} edits)`,
        report: options?.report ? result.report() : undefined,
      };
    },

    get analyzed(): ReadonlySet<string> {
      return build.analyzed;
    },

    /** Whether `id` may be served rewritten, now or after `content` changes. */
    rewritable(id: string): boolean {
      const file = stripQuery(id);
      return (
        file.endsWith(".svelte") &&
        (library.isComponentFile(file) || isAnalyzed(file))
      );
    },

    load(id: string): RewrittenSource | undefined {
      if (build.sources.size === 0) return undefined;
      // Svelte's style sub-modules (`?svelte&type=style`) aren't the source.
      const [file, query = ""] = id.split("?");
      if (query.includes("svelte")) return undefined;
      return build.sources.get(real(file));
    },

    /** Records module `id` if it renders the library without having been analyzed. */
    check(id: string, code: string): void {
      if (build.sources.size === 0) return;
      const file = stripQuery(id);
      if (library.isComponentFile(file) || RE_EXT_STYLESHEET.test(file)) {
        return;
      }
      if (isAnalyzed(file)) return;
      const unbacked = isVirtual(id, file);
      if (!importsLibrary(library, file, code, unbacked)) return;
      // Named as the app imports it, without Rollup's `\0` prefix.
      if (unbacked) build.virtual.add(id.replace(ROLLUP_VIRTUAL_PREFIX, ""));
      else build.missed.add(relative(file));
    },

    isClosed(id: string): boolean {
      if (build.closed.size === 0 || id.includes("?")) return false;
      return build.closed.has(real(id));
    },

    /**
     * An `undefined` importer has no file (an entry, a `require.context`);
     * `dynamic` means some `import()` of `id`.
     */
    checkImporters(
      id: string,
      importers: Array<string | undefined>,
      dynamic: boolean,
    ): void {
      const outside = new Set<string>();
      for (const importer of importers) {
        if (importer === undefined) outside.add("the bundler");
        else if (!isAnalyzed(importer)) {
          const file = stripQuery(importer);
          outside.add(path.isAbsolute(file) ? relative(file) : importer);
        }
      }
      if (dynamic) outside.add("a dynamic import");
      if (outside.size > 0) build.escaped.set(relative(id), [...outside]);
    },

    /**
     * Catches graph edges into the library that `check`'s text scan misses,
     * e.g. through an alias (`import { Button } from "@lib"`).
     */
    checkLibraryImport(edge: LibraryImport): void {
      if (build.sources.size === 0) return;
      const { id, importer, specifier } = edge;
      const file = stripQuery(importer);
      if (!library.importKey(id) || library.moduleKey(file)) return;
      if (isVirtual(importer, file)) {
        build.virtual.add(importer.replace(ROLLUP_VIRTUAL_PREFIX, ""));
        return;
      }
      const resolved = real(file);
      if (!build.analyzed.has(resolved)) {
        build.missed.add(relative(file));
        return;
      }
      const target = real(stripQuery(id));
      const aliased =
        specifier !== undefined && !library.isSpecifier(specifier);
      if (!aliased && build.readImport(resolved, target)) return;
      const name = relative(file);
      const imports = build.unread.get(name) ?? new Set();
      imports.add(
        aliased
          ? `\`${specifier}\``
          : library.importKey(target) === library.barrelKey
            ? `\`${spec.name}\``
            : `${label}'s ${path.basename(target, path.extname(target))}`,
      );
      build.unread.set(name, imports);
    },

    error(): string | undefined {
      const { escaped, missed, unread, virtual } = build;
      const errors: string[] = [];
      for (const [component, importers] of escaped) {
        errors.push(
          `${name} read the props of ${component} from its call sites in \`content\`, but ${importers.join(", ")} also ${importers.length === 1 ? "renders" : "render"} it. Add those files to \`content\`.`,
        );
      }
      if (missed.size > 0) {
        errors.push(
          `${name} rewrote ${label} components before seeing ${[...missed].join(", ")}, which ${missed.size === 1 ? "imports" : "import"} them. Add those files to \`content\` (now ${JSON.stringify(content)}); only a pattern that names \`node_modules\` reaches inside it.`,
        );
      }
      for (const [file, imports] of unread) {
        errors.push(
          `${name} can't read how ${file} imports ${[...imports].join(", ")}, so it rewrote ${label} without that file's call sites. Import ${label} from \`${spec.name}\` there, not through an alias, or remove ${name}.`,
        );
      }
      if (virtual.size > 0) {
        errors.push(
          `${name} can't analyze ${[...virtual].join(", ")}, which ${virtual.size === 1 ? `imports ${label} components but has` : `import ${label} components but have`} no file on disk. Import them from a file in \`content\` instead, or remove ${name}.`,
        );
      }
      return errors.length > 0
        ? `${library.logPrefix} ${errors.join(" ")}`
        : undefined;
    },
  };
}

export type ComponentOptimizer = ReturnType<typeof createComponentOptimizer>;
