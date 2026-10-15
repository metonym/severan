import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LibraryImport,
  type LibrarySpec,
  libraryPaths,
} from "./library-paths";
import { optimizerRegistry } from "./loader";
import {
  createComponentOptimizer,
  DEFAULT_NAMES,
  type ImportResolver,
  type PluginNames,
  type SeveranOptions,
} from "./optimizer";
import { RE_EXT_SVELTE } from "./util";

// Structural subsets of the webpack/Rspack APIs this plugin uses, so it
// works with either bundler without depending on either package.

type WebpackModule = {
  resource?: unknown;
  /** On `NormalModule`: the loader output. */
  originalSource?: () => { source(): string | Buffer } | null | undefined;
};

type WebpackConnection = {
  originModule?: WebpackModule | null;
  /** `request` is the specifier the import was written with. */
  dependency?: { type?: string; request?: unknown } | null;
};

type AsyncHook = {
  tapPromise(name: string, callback: () => Promise<void>): void;
};

type WebpackCompilation = {
  moduleGraph: {
    getIncomingConnections(module: WebpackModule): Iterable<WebpackConnection>;
  };
  hooks: {
    finishModules: {
      tap(
        name: string,
        callback: (modules: Iterable<WebpackModule>) => void,
      ): void;
    };
  };
  warnings: { push(error: Error): void };
  errors: { push(error: Error): void };
};

type Resolver = {
  resolve(
    context: object,
    path: string,
    request: string,
    resolveContext: object,
    callback: (error: Error | null, result?: string | false) => void,
  ): void;
};

export type WebpackCompiler = {
  options: { mode?: string; module: { rules: unknown[] } };
  context: string;
  webpack: { WebpackError: new (message: string) => Error };
  hooks: {
    beforeRun: AsyncHook;
    watchRun: AsyncHook;
    /** webpack 5.40+ and Rspack. */
    shutdown?: { tap(name: string, callback: () => void): void };
    thisCompilation: {
      tap(
        name: string,
        callback: (compilation: WebpackCompilation) => void,
      ): void;
    };
  };
  getInfrastructureLogger(name: string): { info(message: string): void };
  resolverFactory?: { get(type: "normal"): Resolver };
};

function resolveWith(compiler: WebpackCompiler): ImportResolver | undefined {
  const resolver = (() => {
    try {
      return compiler.resolverFactory?.get("normal");
    } catch {
      return undefined;
    }
  })();
  if (!resolver) return undefined;
  return (source, importer) =>
    new Promise((resolve) => {
      try {
        resolver.resolve(
          {},
          path.dirname(importer),
          source,
          {},
          (error, result) => resolve(error || !result ? undefined : result),
        );
      } catch {
        resolve(undefined);
      }
    });
}

/** The loader output of `module`, if it has one as text. */
function moduleSource(module: WebpackModule): string | undefined {
  let source: string | Buffer | undefined;
  try {
    source = module.originalSource?.()?.source();
  } catch {
    // Some module types throw when asked for a source.
  }
  return typeof source === "string" || Buffer.isBuffer(source)
    ? source.toString()
    : undefined;
}

/** The edges into library module `id` from modules with a file. */
function importEdges(
  id: string,
  connections: Iterable<WebpackConnection>,
): LibraryImport[] {
  const edges: LibraryImport[] = [];
  for (const { originModule, dependency } of connections) {
    const importer = originModule?.resource;
    const request = dependency?.request;
    if (typeof importer === "string") {
      edges.push({
        id,
        importer,
        specifier: typeof request === "string" ? request : undefined,
      });
    }
  }
  return edges;
}

/** The built loader next to this file, or its source in a checkout. */
const LOADER = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "loader.js"),
    path.join(here, "loader.ts"),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[0];
})();

/**
 * `severan` for webpack and Rspack: rewrites each component of `library`
 * the app renders for the props it passes.
 *
 * Runs on production builds only. It adds a loader before `svelte-loader`
 * on `.svelte` files, and fails the build if a module outside `content`
 * imports one of the library's components.
 */
export class SeveranPlugin {
  private readonly spec: LibrarySpec;
  private readonly options: SeveranOptions | undefined;
  /** `plugin` also names webpack's hooks; `loader` is the built loader's path. */
  private readonly names: PluginNames & { loader: string };

  public constructor(
    library: LibrarySpec,
    options?: SeveranOptions,
    names: Partial<SeveranPlugin["names"]> = {},
  ) {
    this.spec = library;
    this.options = options;
    this.names = { ...DEFAULT_NAMES, loader: LOADER, ...names };
  }

  public apply(compiler: WebpackCompiler): void {
    // Plugins apply before the bundler fills in its defaults, and an unset
    // `mode` means production. The dev server's single-module rebuilds
    // would leave rewritten components stale.
    if ((compiler.options.mode ?? "production") !== "production") return;

    const { WebpackError } = compiler.webpack;
    const { spec } = this;
    const name = this.names.plugin;
    const library = libraryPaths(spec);
    const optimizer = createComponentOptimizer(spec, this.options, this.names);
    // Unique across copies of this package, which share the registry.
    const id = randomUUID();
    optimizerRegistry().set(id, optimizer);
    compiler.hooks.shutdown?.tap(name, () => {
      optimizerRegistry().delete(id);
    });

    // A pre-loader runs before normal loaders, so `svelte-loader` compiles
    // the rewritten source wherever this plugin sits in `plugins`. Every
    // `.svelte` file: which of the app's own get rewritten depends on the
    // analysis, and the loader passes the rest through.
    compiler.options.module.rules.push({
      test: RE_EXT_SVELTE,
      enforce: "pre",
      use: [{ loader: this.names.loader, options: { id } }],
    });

    let warning: string | undefined;
    const prepare = async () => {
      const result = await optimizer.prepare(
        compiler.context,
        resolveWith(compiler),
      );
      warning = result.warning;
      if (result.info) compiler.getInfrastructureLogger(name).info(result.info);
      for (const line of result.report ?? []) console.log(line);
    };
    compiler.hooks.beforeRun.tapPromise(name, prepare);
    compiler.hooks.watchRun.tapPromise(name, prepare);

    compiler.hooks.thisCompilation.tap(name, (compilation) => {
      if (warning) compilation.warnings.push(new WebpackError(warning));
      compilation.hooks.finishModules.tap(name, (modules) => {
        for (const module of modules) {
          const { resource } = module;
          if (typeof resource !== "string") continue;
          const code = moduleSource(module);
          if (code !== undefined) optimizer.check(resource, code);
          const { moduleGraph } = compilation;
          if (library.importKey(resource)) {
            for (const edge of importEdges(
              resource,
              moduleGraph.getIncomingConnections(module),
            )) {
              optimizer.checkLibraryImport(edge);
            }
          } else if (optimizer.isClosed(resource)) {
            const importers: Array<string | undefined> = [];
            let dynamic = false;
            for (const {
              originModule,
              dependency,
            } of moduleGraph.getIncomingConnections(module)) {
              if (originModule === module) continue;
              importers.push(
                typeof originModule?.resource === "string"
                  ? originModule.resource
                  : undefined,
              );
              dynamic ||= dependency?.type === "import()";
            }
            optimizer.checkImporters(resource, importers, dynamic);
          }
        }
        const error = optimizer.error();
        if (error) compilation.errors.push(new WebpackError(error));
      });
    });
  }
}
