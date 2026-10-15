# Changelog

## Unreleased

**Features**

- `severan/vite` (Vite, Rollup, Rolldown) and `severan/webpack` (webpack,
  Rspack): on production builds, read every call site in `content`, work
  out which values each prop of a library's components can take, and
  hand Svelte each component rewritten for them. Props that never change
  become literals, `{#if}` branches that can't run are removed (unwrapped
  on Svelte 5), and child components only those branches render are no
  longer bundled. Rewritten components come with source maps.
- The app's own components are rewritten too when every file that renders
  them is in `content`, so a wrapper's props reach the library components
  inside it.
- Unknown means open: a prop the analysis can't evaluate, a spread, a
  `bind:`, a component used as a value or imported dynamically, a custom
  element, or an instance bound with `bind:this` keeps every value.
- Builds fail rather than ship a rewrite made without a call site: a
  module outside `content` that imports the library, an import through an
  alias, or a virtual module that renders it.
- Svelte 3, 4 and 5 (runes included).
- Options: `content`, `unwrap`, `silent`, `report`.
- `specializeFiles` in `severan`: the same analysis and rewrite for a set
  of files, without a bundler.
- Zero runtime dependencies.
