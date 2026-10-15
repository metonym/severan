# Contributing

This guide covers how severan is built, the rules every change must keep, and how to verify a change before it merges. Read it in full before changing anything under `src/`.

## Setup

[Bun](https://bun.sh/) is the package manager, test runner and bundler. The published package runs on Node 22+.

```sh
bun ci
bun run test          # analysis, rewriting, rendering, and both plugins on real builds
bun run test:package  # build, pack, install, and use it as a consumer would
bun run typecheck
bun run lint          # biome; `bun run lint:fix` formats and applies fixes
bun run knip          # unused files, exports and dependencies
bun run build         # dist/: minified ESM, rolled-up declarations, slimmed package.json
```

## How it works

A build runs in three steps: read every call site, work out what can render, then rewrite.

- [`library.ts`](src/library.ts) turns a `LibrarySpec` into the installed `Library` (root, exported components); [`library-paths.ts`](src/library-paths.ts) holds the spec and the module-key and specifier helpers every other file uses. The plugins import only the latter, so the parser and the analysis load with `import("./analysis")` when a build starts, not when the plugin does (`test:package` checks it). [`exports.ts`](src/exports.ts) resolves what a library module exports, one name at a time, for the app's imports of the barrel and the library's own imports: through re-exports, `export *`, namespace re-exports and components with members (`Object.assign(Root, { Item })`). A name it can't tell is **unknown**, and an app that imports one keeps every component.
- [`call-sites.ts`](src/call-sites.ts) reads one module: its imports of the library (static ones with sveast's `lexImportsExports`, `import()` and `require()` from the text) and the props each `<Component>` passes, its content included (snippets as props, the rest as Svelte 5's `children`). A component it can't follow (used as a value, spread, imported dynamically or through an alias) is **open**: rendered with any props.
- [`app-usage.ts`](src/app-usage.ts) follows props through the app's own components (wrappers) until no wrapper's usage grows. A wrapper whose every call site is known is **closed**, and may be rewritten; the plugins check the module graph that nothing else imports it.
- [`analyze-usage.ts`](src/analyze-usage.ts) runs the same fixpoint over the library's components (a component's child call sites feed its children), with the contexts and stores they hand each other, and answers `isPruned(cls)` for a library that describes its class names (`classTokens`).
- [`component-model.ts`](src/component-model.ts) models one component (props, declarations, what escapes and may change, the contexts it sets and reads) from sveast's AST and scope analysis, cached by path and mtime. [`evaluate.ts`](src/evaluate.ts) evaluates expressions to the set of values they can take ([`values.ts`](src/values.ts): up to 32 values, then `UNKNOWN`), calling functions with their arguments. [`live-walk.ts`](src/live-walk.ts) walks only what can render, collecting classes and child call sites.
- [`specialize.ts`](src/specialize.ts) rewrites a component's source for its usage, with source maps from [`mapped-text.ts`](src/mapped-text.ts); [`analysis.ts`](src/analysis.ts) puts it together for a set of files (`specializeFiles`).
- [`variant-tables.ts`](src/variant-tables.ts) finds the tailwind-variants tables (`const t = tv({…})`) in the library's script modules, follows them through every import and re-export to the components that call them, and walks each live one again (`walkLive`'s watched calls) for the values its calls and their slot calls pass. Keys no call selects go, with the compound variants that need one; a table nothing calls becomes `tv({})`. Any other reader (the app, another module, a namespace, a result handed on) keeps a table whole.

[`optimizer.ts`](src/optimizer.ts) is what the Vite plugin ([`vite.ts`](src/vite.ts)) and the webpack plugin ([`webpack.ts`](src/webpack.ts)) share: analyze `content` before the build, serve the rewritten sources, and fail the build if a module outside `content` imports the library. After the build it checks each edge of the bundler's module graph into the library against the imports the analysis read (`readLibraryImport`): an edge it didn't read is an import it can't see, such as one through an alias, and fails the build. Under webpack and Rspack the sources are served by [a pre-loader](src/loader.ts), built as its own file, that finds its optimizer in a process-wide registry on `globalThis`.

## Rules every change must keep

- **Unknown must mean open.** Anything the analysis can't read keeps every value, and is never skipped: a missed call site removes code the app runs. Don't skip a file because of what its text lacks, and verify a change to what the analysis removes by rendering (see Tests).
- **Zero runtime dependencies.** sveast is bundled into `dist/`; nothing in it may import `svelte`, which `bun run build` checks. Dev-only code (`tests/`, `bench/`, `scripts/`) may use anything.
- **Self-contained types.** `dist/*.d.ts` roll up only what the public entries reference, so the analysis's own types (and sveast's) stay out of a consumer's program. `test:package` type-checks a consumer with `skipLibCheck: false`.
- **Keep the public API small and explicit.** `src/index.ts`, `src/vite.ts` and `src/webpack.ts` export only what a user needs, by name (`noReExportAll`). Tests import internals from `src/` directly. New options default to current behavior. `src/internal.ts` and `src/internal-analysis.ts` (`severan/internal`, `severan/internal/analysis`) are carbon-preprocess-svelte's, unstable and undocumented for users: `internal` must never load the parser (`test:package` checks it), and the analysis's types come only from `internal/analysis`, since each entry's declarations are rolled up on their own.

## Tests

| File | Covers |
|:---|:---|
| `tests/specialize-render.test.ts` | Libraries written to disk ([`tests/helpers/render-library.ts`](tests/helpers/render-library.ts)), specialized, and SSR-rendered both ways: content and snippets, props set through an instance, imports through namespaces and other packages, barrels, Svelte 4 and 5 syntax around a rewrite, the writes that keep a value, and tailwind-variants tables (with a stand-in `tv`, [`tests/helpers/tailwind-variants.ts`](tests/helpers/tailwind-variants.ts)) |
| `tests/specialize.test.ts` | `specializeComponent`: folding, branch removal, `unwrap`, whitespace around a removed block, shorthands, class directives, and what it never folds |
| `tests/analyzer.test.ts` | Call sites, the component model, the usage fixpoint, contexts and stores, on carbon-components-svelte and mock libraries |
| `tests/app-usage.test.ts` | Props through the app's own components, and when they're closed |
| `tests/analyzer-values.test.ts` | The value lattice: joins, truthiness, binary operators, shapes |
| `tests/mapped-text.test.ts` | Source maps for rewritten components |
| `tests/vite.test.ts` | The Vite plugin on real Vite builds: rewriting, rebuilds when `content` changes, `report`, and the module-graph checks (modules outside `content`, aliases, virtual modules) |
| `tests/webpack.test.ts` | The webpack plugin on real webpack builds: rewriting, production only, wrappers, and the module-graph checks |
| `scripts/test-package.ts` | `bun run test:package`: packs `dist/`, installs it into a scratch project, specializes a library in Node, loads both plugins, and type-checks a consumer |

carbon-components-svelte is the reference library, configured in [`tests/helpers/carbon.ts`](tests/helpers/carbon.ts).

A fix to what the analysis removes needs a render test that fails before the fix and passes after: add a library and app to `tests/specialize-render.test.ts` that render differently once rewritten, with `unwrap` off and on.

## Releasing

Only the maintainer releases. `feat:`/`fix:` commits land first, each with its `CHANGELOG.md` entry under "Unreleased"; the release is a `vX.Y.Z` commit (version and changelog heading) and its tag. Pushing the tag runs `.github/workflows/release.yml`, which builds, publishes and then waits until the npm tarball itself downloads. Create the GitHub release (its body is the changelog entry) and bump dependents only once that workflow is green.

## Performance

Changes to `src/` must not make things slower.

| Command | Use |
|:---|:---|
| `bun run bench:ab` | **The regression check** (`ostia ab`): `HEAD` against the working tree, alternating in one process |
| `bun run bench` | Per-task numbers: `analyzeFiles` and `specializeFiles` on apps of growing size, modeling cold, the app-component fixpoint at bundle scale, source maps, and the plugins' per-build checks |

Commit first, then run `bun run bench:ab` against the commit before your change (`--base <ref>` for older refs).

## Style

- Match the surrounding code: TypeScript, biome formatting, plain-sentence comments at a similar density.
- Conventional commits: `feat`, `fix`, `perf`, `refactor`, `bench`, `test`, `docs`, `chore`, with `!` for breaking changes. Put measured numbers in the body of `perf:` commits.
- Update the README when behavior, options or benchmark numbers change.

## Before you finish

- [ ] `bun run lint`, `bun run typecheck`, `bun run knip`, `bun run test` and `bun run test:package` pass.
- [ ] `src/` changes: `bun run bench:ab` shows no confirmed regression.
- [ ] Changes to what the analysis removes: a render test covers them.
- [ ] The README and this guide still describe what the code does.
