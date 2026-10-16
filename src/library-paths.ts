import { isSvelteFile, stripQuery } from "./util";

/** How the analysis reads a library's class names: see `LibrarySpec.classTokens`. */
export type ClassTokens = {
  /** Text that may name a class contains it (`"x--"`). */
  marker: string;
  text(text: string): string[];
};

/** A Svelte component library severan reads and rewrites. */
export type LibrarySpec = {
  /** The package apps import: `"my-library"`. */
  name: string;
  /** The directory of its modules in the package: `"src"`. */
  srcDir: string;
  /** Its barrel, in `srcDir`: `"index.js"`. */
  barrel: string;
  /** Packages whose exports are components (an icon set): passing one as a prop passes an object. */
  componentPackages: readonly string[];
  /** Its context key prefix (`"my-library:"`): an app module holding one may use its contexts. */
  contextKeyPrefix: string;
  /** Names the library in messages: `"My Library"`. */
  label: string;
  /** Names the tool in messages, and starts each warning and error: `"my-plugin"`. */
  tool: string;
  /**
   * Reads class names, for pruning the library's styles: `text` a string
   * containing `marker`, `script` a whole script module. Omit to read none.
   */
  classTokens?: ClassTokens & {
    script(code: string, into: Set<string>): void;
  };
  /**
   * `true` for a library whose classes are Tailwind's: its tailwind-variants
   * tables are rewritten, and with Tailwind installed, every build (the dev
   * server's included) writes what of it can render to
   * `node_modules/.severan/<name>`, for Tailwind to scan. @default false
   */
  tailwind?: boolean;
};

/** An edge of the bundler's module graph into library module `id`; `specifier` is what `importer` wrote, when the bundler says. */
export type LibraryImport = {
  id: string;
  importer: string;
  specifier?: string;
};

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIAL, "\\$&");
}

function perSpec<T>(make: (spec: LibrarySpec) => T): (spec: LibrarySpec) => T {
  const cache = new WeakMap<LibrarySpec, T>();
  return (spec) => {
    let value = cache.get(spec);
    if (value === undefined) {
      value = make(spec);
      cache.set(spec, value);
    }
    return value;
  };
}

const libraryPatterns = perSpec(patternsOf);

function patternsOf(spec: LibrarySpec) {
  const name = escapeRegExp(spec.name);
  const component = `${name}\\/${escapeRegExp(spec.srcDir)}\\/`;
  return {
    /** A computed `import()` argument that starts with the package name. */
    argument: new RegExp(`\\s*["'\`]${name}\\b`, "y"),
    directComponentPath: new RegExp(`^${component}(.+\\.svelte)$`),
    contextKey: new RegExp(
      `(["'\`])(${escapeRegExp(spec.contextKeyPrefix)}[^"'\`\\s]+)\\1`,
      "g",
    ),
    /** A specifier of one of its modules that's neither a component nor a stylesheet. */
    valueSubpath: new RegExp(
      `["'\`]${name}\\/(?![^"'\`]*\\.(?:svelte|css)["'\`])`,
    ),
    /** An import of one of its modules that isn't a component. */
    scriptSpecifier: new RegExp(
      `["']${component}(?![^"']*\\.svelte["'])[^"']*["']`,
    ),
    barrelImport: new RegExp(
      `\\bimport\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*(["'])${name}\\3`,
      "g",
    ),
    barrelSpecifier: new RegExp(`["']${name}["']`, "g"),
    directComponentSpecifier: new RegExp(
      `["']${component}([^"']+\\.svelte)["']`,
      "g",
    ),
    /** Imports that are components: passing one as a prop passes an object. */
    componentSource: new RegExp(
      spec.componentPackages.length > 0
        ? `\\.svelte$|^(?:${spec.componentPackages.map(escapeRegExp).join("|")})(\\/|$)`
        : "\\.svelte$",
    ),
    /** An import or `require` of it in a file the lexer can't read. */
    importText: new RegExp(
      `\\b(?:from|import|require)\\s*\\(?\\s*["'\`]${name}(?:["'\`]|\\/)`,
    ),
    dynamicImport: new RegExp(
      `\\b(?:import|require)\\s*\\(\\s*(["'\`])(${name}(?:\\/[^"'\`]*)?)\\1`,
      "g",
    ),
    directComponentName: new RegExp(
      `^${component}.+\\/([A-Za-z0-9_]+)\\.svelte$`,
    ),
    segment: new RegExp(`(^|[\\\\/])${name}([\\\\/]|$)`),
    srcSegment: new RegExp(
      `(?:^|[\\\\/])${name}[\\\\/]${escapeRegExp(spec.srcDir)}[\\\\/](.+)$`,
    ),
  };
}

const BACKSLASH = /\\/g;

export class LibraryPaths {
  readonly spec: LibrarySpec;
  readonly patterns: ReturnType<typeof patternsOf>;

  constructor(spec: LibrarySpec) {
    this.spec = spec;
    this.patterns = libraryPatterns(spec);
  }

  get name(): string {
    return this.spec.name;
  }

  get logPrefix(): string {
    return `${this.spec.tool}:`;
  }

  /** `pkg/src/` */
  get srcPrefix(): string {
    return `${this.name}/${this.spec.srcDir}/`;
  }

  get barrelKey(): string {
    return this.spec.barrel;
  }

  /** `…/pkg/src/Button/Button.svelte` -> `Button/Button.svelte`. */
  moduleKey(id: string): string | undefined {
    return this.patterns.srcSegment.exec(id)?.[1].replace(BACKSLASH, "/");
  }

  /** `moduleKey` of a component or the barrel, the modules whose imports the analysis reads. */
  importKey(id: string): string | undefined {
    const key = this.moduleKey(stripQuery(id));
    return key && (key === this.barrelKey || isSvelteFile(key))
      ? key
      : undefined;
  }

  /** Other imports resolving into the package (bundler aliases) are invisible to the analysis. */
  isSpecifier(specifier: string): boolean {
    return specifier === this.name || specifier.startsWith(`${this.name}/`);
  }

  isComponentFile(id: string): boolean {
    return isSvelteFile(id) && this.patterns.segment.test(id);
  }
}

export const libraryPaths = perSpec((spec) => new LibraryPaths(spec));
