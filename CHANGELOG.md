# Changelog

## 0.4.0

**Features**

- Breaking: Tailwind support is opt-in. Set `tailwind: true` in the
  `LibrarySpec` of a library whose classes are Tailwind's, for its
  tailwind-variants tables and `node_modules/.severan`. Without it, the
  analysis neither scans for tables nor loads that code (23 ms off a
  Carbon build), and the plugins skip the dev server and non-production
  webpack builds again.

## 0.3.0

**Features**

- tailwind-variants tables in the library's script modules are rewritten
  for the values its live components pass them: variant keys no call can
  select are removed, with the compound variants that need one, and a
  table nothing calls keeps no classes. Gzipped client JS of a realistic
  page built with Vite: flowbite-svelte 37.2% smaller, svelte-5-ui-lib
  18.7%.
- With Tailwind installed, every build writes what of the library can
  render to `node_modules/.severan/<name>`, for Tailwind to scan in place
  of the package (`@source`, or a v3 `content` glob; the dev server writes
  it as it is). Gzipped Tailwind CSS on the same pages: flowbite-svelte
  60.9% smaller, svelte-5-ui-lib 71.7%, svelte-ux 24.9%.
- Builds fail when a module outside the library imports a script module
  whose tables were rewritten (through an alias).
- A component picked from a constant object with
  `<svelte:component this={icons[kind]}>`: only the entries `kind` can
  select render, and the others leave the object and the bundle.

**Fixes**

- A rewrite no longer changes the namespace Svelte 5 infers for a block or
  a component's root: unwrapping an `<svg>` into a block, or removing the
  branch with a fragment's only HTML element, could make it SVG and drop
  the whitespace between its nodes (flowbite-svelte's `BreadcrumbItem`).

## 0.2.0

**Features**

- `severan/internal` and `severan/internal/analysis`: the internals
  carbon-preprocess-svelte builds on, unstable and not for apps.
  `severan/internal` never loads the parser.

**Fixes**

- A wrapper's `report` heading names its `tool` before the feature
  (`my-tool optimizeComponents report`), unless they're the same.

## 0.1.0

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
