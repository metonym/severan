# Changelog

## Unreleased

**Features**

- `svelte-prune/internal/analysis` exports `siblingAnalysis(build,
  library)`: given a build (Vite's resolved config, a webpack or Rspack
  compiler, or Rollup's list of plugins), it returns a reader of the
  analysis the `sveltePrune` or `SveltePrunePlugin` there made for
  `library`: what renders (`liveComponents`, `isPruned`) and the `content`
  files it read, or the warning it failed with. A sibling plugin, such as
  carbon-preprocess-svelte's CSS optimizer, prunes from the same reading
  of the call sites as the rewrite instead of collecting its own.
  `specializeFiles` returns it as `usage`.

## 0.10.1

**Fixes**

- The bundled parser is svelte-ast 0.12.0, sveast's new name, and the
  declarations of `svelte-prune/internal` and
  `svelte-prune/internal/analysis` import its types from `svelte-ast/*`
  instead of `sveast/*`.

## 0.10.0

**Breaking changes**

- Renamed from `severan` to `svelte-prune`. Install `svelte-prune` and
  update imports and names:
  - `severan`, `severan/vite`, `severan/webpack` → `svelte-prune`,
    `svelte-prune/vite`, `svelte-prune/webpack` (and `/internal`,
    `/internal/analysis`)
  - `severan()` → `sveltePrune()`
  - `SeveranPlugin` → `SveltePrunePlugin`
  - `SeveranOptions` → `SveltePruneOptions`
  - Tailwind's `@source` (or v3 `content` glob):
    `node_modules/.severan/<name>` → `node_modules/.svelte-prune/<name>`
  - The default `plugin`, `failure.feature` and `id` in `names` are now
    `"svelte-prune"`.

## 0.9.0

**Features**

- `Array.isArray()`, `Math.round()` and the other rounding, sign and
  min/max functions, and `includes()`, `some()` and `every()` on arrays
  and strings are evaluated (`some` and `every` with a callback written
  inline that only reads). Calling one of those methods on an array no
  longer makes its contents unknown; on any other object it still does.
  A `&&`, `||` or `??` whose left side decides it folds even when its
  right side couldn't be removed on its own. Gzipped JS of the svelte-ux
  example 7.4% smaller (6.8%), flowbite-svelte 37.3% (37.2%), Carbon 23
  bytes less.
- A name a destructuring declaration declares (`const { compact } =
  getContext("group")`) no longer counts as handing its value on, so an
  object or store it holds stays known, and a context a component may be
  rendered without no longer makes it unknown: destructuring `undefined`
  throws before anything renders. A context object a provider also hands
  to `getContext(key)?.register(ctx)` flows to its readers when nothing
  provides `key` (Carbon's `Tabs`, without `PageHeader`). Gzipped JS of
  the examples: svelte-5-ui-lib 22.9% smaller (18.8%), flowbite-svelte
  37.8% (37.3%), Carbon 34.0% (33.5%); Carbon's CSS 70.7% (70.4%).
- A store a context object holds under two names, or feeds to
  `derived`, still flows to its readers, unless a reader may write it
  through any of those names. Carbon's example: gzipped JS 34.1% smaller
  (34.0%), CSS 70.8% (70.7%).

**Fixes**

- A library `.js` module that reads a context no longer stops every
  context's stores from flowing to the components that read them: only
  the keys it reads stay unknown (all of them if it reads one by a key
  that can't be read). Carbon 0.114's script modules read five keys, so
  without this a Toolbar lost the size its DataTable hands it.
- `getContext(k)?.p` reads only `p` of the context, not every property.
  Carbon's example on 0.114.3: JS 33.5% smaller (33.4%), CSS 70.4%
  (70.0%).

## 0.8.0

**Features**

- `safelist` keeps whole selectors: a class (with or without its `.`)
  keeps every selector it's in, and it takes RegExps, tested against
  each selector (`/^\.x--tag--/`), as carbon-preprocess-svelte's does.
  Before, a safelisted class only kept itself, so a selector with
  another class that nothing renders still went.
- Stylesheet pruning also removes the custom properties and `@keyframes`
  the library's stylesheets define that nothing reads once their rules
  are gone: no `var()` or animation left in the emitted CSS, and no app
  file or library source naming them (a name a script builds, like
  `` `--tone-${t}` ``, keeps every property with that prefix). Gzipped
  CSS of the sveltestrap example 46.8% smaller (44.2%), Carbon's 71.5%
  (71.3%).
- `severan/internal/analysis` exports `libraryStylePruner`, for a pruner
  from an analysis made without `specializeFiles` (carbon-preprocess-svelte's
  per-module `createUsageCollector`).
- A name `{@const}` declares is read as its value where it's in scope, with
  the `{#each}` items around it, in `{#each}`, `{#if}`, `{:then}`, snippets
  and component content. An `{#if}` on one that depends only on props keeps
  only the branch that can render, and a child component given it keeps only
  those values. Carbon's example: 256 bytes less JS.
- Destructuring is read in `{@const}` and `{#each}`: nested patterns,
  arrays and defaults (`{#each items as { label, tags: [first] = [] }}`).
  Only a rest element's names stay unknown, and handing on a name
  destructured from an item no longer makes the whole item unknown.
- A snippet parameter is read as what every call of the snippet passes it
  (`{@render row(size)}`), when nothing else uses the snippet: not a
  component it's handed to, by name or as content. A `{@const}` or
  `{#each}` item is also read outside the walk that binds it, such as
  where a snippet is called, or in a component map's key
  (`{#each kinds as k}<svelte:component this={icons[k]} />`).
- A library component a file imports but names nowhere else (not in its
  markup, scripts, comments or strings) has no call site there. It was
  rendered with any props, which kept every variant of it even where
  another component renders it with known props: svelte-ux's example
  imports `Field` without rendering it, so `TextField`'s `Field` kept
  everything. The svelte-ux example: gzipped JS 6.8% smaller (5.5%),
  Tailwind's CSS 35.3% (24.9%). A name the text mentions anywhere else,
  such as in markup another preprocessor generates, keeps it open.

**Fixes**

- Assigning or binding an `{#each}` item (`bind:value={item}`) keeps
  what its array holds unknown: Svelte writes it back to the array, and a
  read of the array (`{#if items[0] === "a"}`) was folded.

## 0.7.2

**Fixes**

- An element's `value={…}` that may be nullish is no longer folded, and a
  prop it reads is no longer declared with `let`: Svelte skips an initial
  nullish `value` it reads from state but writes a literal one as `""`, so
  a checkbox submitted `""` instead of `"on"` and an `<option>` lost its
  text as its value (svelte-ux's `Checkbox`). SSR renders both the same.

## 0.7.1

**Fixes**

- A function, or a prop, that only an action, transition or animation
  names (`use:tip`, `transition:fade`, `animate:flip`) is kept. 0.6.0 and
  0.7.0 removed it as unread, so the browser threw `tip is not defined`
  (Carbon's `SelectItem` and `MultiSelect`). SSR never runs these, which
  is why rendered HTML stayed identical.

## 0.7.0

**Features**

- `styles` in the `LibrarySpec` names the library's stylesheets, and
  production builds remove from the CSS they emit the rules that need a
  class those stylesheets define and nothing can render: no live component
  under the app's props, no script module of the library, no file in
  `content`. Classes they don't define never remove a rule. A `safelist`
  option keeps classes the app builds from data. Gzipped CSS of the
  examples: Carbon's `white.css` 71.3% smaller, sveltestrap's Bootstrap
  44.2%. `specializeFiles` returns the pruner as `pruneStyles`.
- `classTokens` is optional with `styles`: without it, every run of word
  characters and hyphens reads as a class.
- A `class` attribute built from text and `{expressions}`
  (`class="btn btn-{size}"`) is read as its values when the analysis can
  evaluate them, not as the prefix `btn-`, so `isPruned` keeps fewer
  classes.

## 0.6.0

**Features**

- Props nothing reads after the rewrite are removed, not only marked with
  `svelte-ignore`, so Svelte no longer compiles a prop for each one. One
  stays when its default has effects, something writes it, or a call site
  passes it to a component that reads `$$restProps` or `$$props`. Gzipped
  client JS of the Carbon example is 27.9% smaller (24.4% before), and
  sveltestrap's 20.8% (17.6%).
- A bare `on:click` that passes an event on is removed when no call site
  listens to it, through the library's and the app's own components. An
  instance whose `$on` the app calls keeps every one. sveltestrap's
  gzipped client JS is 21.6% smaller (20.8%); Carbon's loses 5 KB before
  gzip.
- `{...$$restProps}` on a component, and `...$$restProps` in an object, are
  removed when no call site passes a key the rest would hold. A spread on
  an element stays: it decides how Svelte renders the element's
  attributes. Carbon's gzipped client JS is 28.0% smaller (27.9%).
- A prop no call site passes or binds is declared with `let`, not
  `export let`: Svelte compiles it as the component's own state instead of
  a prop. Carbon's gzipped client JS is 29.5% smaller (28.0%), and
  sveltestrap's 22.0% (21.6%).
- `dispatch(type, …)` from `createEventDispatcher()` is removed where no
  call site listens to `type` and its result is unused, keeping whatever
  its arguments run. Carbon's gzipped client JS is 29.7% smaller (29.5%).
- `dropUnused` removes top-level `function` declarations nothing calls
  once the rewrite has removed their callers, and with them whatever only
  they read: a handler only a removed branch used no longer keeps a
  helper (and its import) alive. A function with TypeScript overload
  signatures is kept.

## 0.5.0

**Features**

- `isPruned` reads each call site's classes on its own: values from
  different sites no longer combine into classes none of them renders
  (one Button's `iconDescription` with another's `portalTooltip`).

**Fixes**

- A `.js` module that calls `setContext` with a key held in a constant,
  local or imported, provides that key alone. It used to make every
  context read unknown, so no context value could prune a class.
  Components also read a key from a local `const`, not only an imported
  one.
- `import()`, `require()` and `import.meta.glob()` in scripts are read
  with sveast's lexer: one in a comment or a string no longer opens the
  app's components or keeps the library's tailwind-variants tables whole.
  An `import.meta.glob()` in the library keeps every table, as a computed
  `import()` does.
- An import of the library the analysis can't tell (an export it can't
  resolve, a namespace read with a computed key) keeps every one of its
  components whole, not only those the app renders: a component only
  another one renders was rewritten for that one's props alone, and could
  render the wrong branch.

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
