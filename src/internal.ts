/**
 * Internals carbon-preprocess-svelte builds on. Unstable: anything here may
 * change in any release. Nothing here loads the parser; the analysis and
 * its types are in `internal-analysis.ts`.
 */
// The bundled copies of sveast's lexer and walker, so a package bundling
// severan doesn't ship them twice.
export {
  type LexedImport,
  lexComponent,
  lexImportsExports,
  lexStrings,
} from "sveast/lexer";
export { type AST, walk } from "sveast/walk";
export { collectLibraryImports } from "./imports";
export {
  type LibraryImport,
  type LibrarySpec,
  libraryPaths,
} from "./library-paths";
export { default as loader, optimizerRegistry } from "./loader";
export { MappingsBuilder } from "./mapped-text";
export { libraryImports } from "./module-graph";
export type { PluginNames, SeveranOptions } from "./optimizer";
export {
  isLinkedCheckout,
  listJsAndSvelteFiles,
  packageSignature,
  requirePackageDir,
} from "./package";
export {
  isIdentifierName,
  type PackageExport,
  readPackageExports,
} from "./package-exports";
export {
  errorMessage,
  isSvelteFile,
  RE_EXT_STYLESHEET,
  RE_EXT_SVELTE,
  stripQuery,
} from "./util";
export { severan } from "./vite";
export { SeveranPlugin, type WebpackCompiler } from "./webpack";
export {
  importEdges,
  isProduction,
  moduleSource,
  type WebpackConnection,
  type WebpackModule,
} from "./webpack-util";
