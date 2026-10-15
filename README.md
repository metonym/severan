# severan

> Zero-dependency Svelte component specializer. Rewrites each component a library ships for the props your app passes it, so branches that can never render are cut from the build.

A component library's `Button` handles every `kind`, `size` and state any app might ask for, and your bundle carries all of it. severan reads every call site in your app before the build, works out which values each prop can take, and hands Svelte a copy of each component rewritten for those values: props that never change become literals, `{#if}` branches that can't run are removed, and child components only those branches render are no longer bundled.

```svelte
<!-- the library's Button.svelte -->
<script>
  import Icon from "./Icon.svelte";
  export let kind = "primary";
  export let size = "default";
</script>
{#if kind === "ghost"}
  <button class="ghost {size}"><slot /></button>
{:else if kind === "danger"}
  <button class="danger {size}"><Icon name="warning" /><slot /></button>
{:else}
  <button class="primary {size}"><slot /></button>
{/if}
```

If your app only ever writes `<Button kind="ghost">`, Svelte compiles this instead, and the bundler drops `Icon`, which nothing renders anymore. On Svelte 5 the `{#if true}` goes too (`unwrap`):

```svelte
<script>
  import Icon from "./Icon.svelte";
  // svelte-ignore unused-export-let export_let_unused
  export let kind = "primary";
  // svelte-ignore unused-export-let export_let_unused
  export let size = "default";
</script>
{#if true}
  <button class="ghost {"default"}"><slot /></button>
{/if}
```

Libraries that keep their classes in [tailwind-variants](https://www.tailwind-variants.org/) tables (`tv({ variants: { color: { red: "…", green: "…" } } })`) get those tables rewritten too: keys no live call can select are removed, and a table nothing calls keeps no classes. With Tailwind, scanning what severan writes for it leaves those classes out of your CSS as well (see [Tailwind](#tailwind)).

It runs on production builds, in Vite, Rollup, Rolldown, webpack and Rspack, for Svelte 3, 4 and 5 (runes included). Rewritten components come with source maps back to their original source.

```sh
bun i -d severan
```

## Usage

### Vite, Rollup and Rolldown

```ts
// vite.config.ts
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { severan } from "severan/vite";

const library = {
  name: "my-library", // the package your app imports
  srcDir: "src", // where its .svelte files are, in the package
  barrel: "index.js", // its entry, in srcDir
  componentPackages: [], // packages whose exports are components (icon sets)
  contextKeyPrefix: "my-library:", // what its context keys start with
  label: "My Library", // names it in messages
  tool: "severan", // starts every warning and error
};

export default {
  plugins: [severan(library), svelte()],
};
```

### webpack and Rspack

```js
// webpack.config.js
import { SeveranPlugin } from "severan/webpack";

export default {
  plugins: [new SeveranPlugin(library)],
};
```

It adds a loader that runs before `svelte-loader` on `.svelte` files.

### Tailwind

Tailwind generates a utility for every class string it scans, and a library's setup has it scan the package (`@source "../node_modules/my-library/dist"`). With Tailwind installed, every build writes what of the library can render to `node_modules/.severan/<name>`: every file but the components that can't render, as severan rewrote them (components and tailwind-variants tables). Scan that instead, with Tailwind v4's `@source`:

```css
@source "../node_modules/.severan/my-library";
```

or a Tailwind v3 `content` glob: `"./node_modules/.severan/my-library/**/*.{svelte,js}"`. The dev server and development builds write the library as it is, so their CSS has every class.

## API reference

severan has no CLI: it runs inside your bundler (`severan/vite`, `severan/webpack`), or from your own script with `specializeFiles` (`severan`). Each entry ships its own types:

```ts
import { type LibrarySpec, type SeveranOptions, specializeFiles } from "severan";
import type { Failure, SpecializedComponents } from "severan";
import { severan } from "severan/vite";
import { SeveranPlugin, type WebpackCompiler } from "severan/webpack";
```

### `severan(library, options?, names?)`

```ts
import { severan } from "severan/vite";

function severan(
  library: LibrarySpec,
  options?: SeveranOptions,
  names?: PluginNames & { id: string },
): Plugin;
```

A Vite, Rollup and Rolldown plugin. Put it before the Svelte plugin.

- Rewrites on `vite build` only (`--watch` included), never on the dev server, which only writes the library as it is for [Tailwind](#tailwind). Rollup and Rolldown have no dev server: add it only to production configs there.
- `buildStart` reads `content`, resolving aliased `.svelte` imports (`$lib/Card.svelte`) with the bundler. A watch rebuild where nothing in `content` changed reuses the last analysis.
- `load` serves the rewritten components, with source maps; `transform` and `buildEnd` check the module graph and fail the build when a module the analysis didn't read imports the library (see [Errors](#warnings-and-errors)).

### `new SeveranPlugin(library, options?, names?)`

```ts
import { SeveranPlugin } from "severan/webpack";

class SeveranPlugin {
  constructor(
    library: LibrarySpec,
    options?: SeveranOptions,
    names?: Partial<PluginNames & { loader: string }>,
  );
  apply(compiler: WebpackCompiler): void;
}
```

A webpack 5 and Rspack plugin. It rewrites nothing unless `mode` is `"production"` (an unset `mode` counts); other modes only write the library as it is for [Tailwind](#tailwind). It adds a pre-loader on `.svelte` files and the library's script modules, so `svelte-loader` compiles the rewritten source wherever the plugin sits in `plugins`, analyzes `content` on `beforeRun` and `watchRun`, and checks the module graph on `finishModules`.

### `LibrarySpec`

Describes the library to rewrite. Every field but `classTokens` is required.

| Field | Type | |
|:---|:---|:---|
| `name` | `string` | The package apps import: `"my-library"`. |
| `srcDir` | `string` | The directory of its `.svelte` files in the package: `"src"`. |
| `barrel` | `string` | Its entry, relative to `srcDir`: `"index.js"`. |
| `componentPackages` | `readonly string[]` | Packages whose exports are components (an icon set), so passing one as a prop passes an object. |
| `contextKeyPrefix` | `string` | What its context keys start with (`"my-library:"`): an app module that holds such a string may set or read its contexts. |
| `label` | `string` | Names the library in messages: `"My Library"`. |
| `tool` | `string` | Starts every warning and error: `"severan"`. |
| `classTokens` | `{ marker, text, script }` | Optional. How to read the library's CSS class names, for analyses that prune its styles. The plugins and `specializeFiles` don't use it. |

### `SeveranOptions`

| Option | Default | |
|:---|:---|:---|
| `content` | `["src/**/*.{svelte,svx,md,mdx,astro,js,jsx,ts,tsx,mjs,mts,cjs,cts}"]` | Every file that renders the library's components, relative to the project root. They're analyzed before the build; a module outside them that imports one fails the build. `.svelte` files are read for the props they pass; a component imported from a script, Markdown, MDX or Astro file keeps every value. `node_modules` is skipped unless a pattern names it. |
| `unwrap` | `true` on Svelte 5 | Replace an `{#if}` whose only live branch is known with that branch, instead of `{#if true}`. Svelte 3 and 4 render whitespace differently without the block. |
| `silent` | `false` | Skip the per-build summary (`rewrote N My Library components for this app (M edits)`). |
| `report` | `false` | Print what each build rewrote: edits per component, the children it no longer renders, the components no longer bundled, and the values each call site passes (or why it keeps every value). Independent of `silent`. |

### `names`

For a package that wraps severan and reports under its own name. `severan()` replaces its defaults whole, so pass `plugin`, `failure` and `id`; `SeveranPlugin` takes any of its fields.

| Field | Default | |
|:---|:---|:---|
| `plugin` | `"severan"` | Names the plugin in errors, and webpack's hooks and logger. |
| `failure.feature` | `"severan"` | Names what a failed analysis turns off, in its warning and the `report` heading (after `tool`, unless they're the same). |
| `failure.fallback` | `"components were bundled unchanged"` | What happens instead, in that warning. |
| `id` | `"severan"` | `severan()` only: the plugin's name in the bundler. |
| `loader` | the bundled loader | webpack only: the path of the loader to add. |

### `specializeFiles(input)`

```ts
import { specializeFiles } from "severan";

function specializeFiles(input: {
  library: LibrarySpec;
  projectRoot: string;
  files: Array<{ file: string; code: string }>;
  failure: Failure;
  options?: SpecializeOptions;
  resolvedImports?: ReadonlyMap<string, string>;
}): Promise<SpecializedComponents | { warning: string }>;
```

The analysis and rewrite the plugins run, for a set of files and without a bundler. Pass every file that renders the library: a component a missing file renders is rewritten without its call sites.

| Input | |
|:---|:---|
| `library` | The `LibrarySpec`. |
| `projectRoot` | Where the library is resolved from (Yarn Plug'n'Play included), and what the report's paths are relative to. |
| `files` | Absolute paths and their source. |
| `failure` | `{ feature, fallback }` for the warning if the analysis throws. |
| `options.unwrap` | Default `false`. As in `SeveranOptions`; pass `true` on Svelte 5. |
| `options.dropUnused` | Default `true`. Remove top-level declarations nothing reads after the rewrite. |
| `options.emptyBlock` | Default `{#if false}<!---->{/if}`. What replaces an `{#if}` that renders nothing between whitespace. |
| `options.editFilter` | `(index, { start, end }) => boolean`. Debugging: apply only the top-level edits it accepts. |
| `resolvedImports` | Non-relative `.svelte` imports you resolved yourself (`$lib/Card.svelte`), keyed `` `${importer}\0${specifier}` ``, to the absolute path of a file in `files`. |

It never throws: if the analysis fails, it resolves to `{ warning }` and nothing is rewritten. Otherwise to `SpecializedComponents`:

| Field | Type | |
|:---|:---|:---|
| `sources` | `Map<string, { code: string; map: SourceMap }>` | Rewritten components and script modules by the real path of their source, each with a v3 source map. Serve these instead of the files on disk. |
| `edits` | `number` | Edits made to components, across `sources`. |
| `apps` | `number` | How many of `sources` are the app's own components. |
| `renderable` | `ReadonlySet<string>` | The library components that can render, by path in `srcDir`. |
| `tables` | `{ modules, pruned, emptied, keys, compounds }` | The tailwind-variants tables rewritten: how many of `sources` are their modules, tables pruned and emptied, and variant keys and compound variants removed. |
| `closed` | `Set<string>` | App components whose props came from their call sites in `files`. Nothing outside `files` may render them; the plugins check it. |
| `report` | `() => string[]` | The lines `report: true` prints. |
| `readImport` | `(importer, id) => boolean` | Whether the analysis read file `importer`'s import of library module `id` (both real paths). `false` means an import it can't see, such as one through a bundler alias. |

```ts
const result = await specializeFiles({
  library,
  projectRoot: process.cwd(),
  files: [{ file: "/app/src/App.svelte", code }],
  failure: { feature: "severan", fallback: "components were bundled unchanged" },
  options: { unwrap: true },
});
if ("warning" in result) console.warn(result.warning);
else for (const [file, { code, map }] of result.sources) console.log(file, code, map);
```

### Warnings and errors

Every message starts with `` `${tool}:` ``.

- **Warning** (the build continues, nothing rewritten): `could not analyze this build (…)`, when the analysis throws, for example because the library isn't installed.
- **Errors** (the build fails), when components were rewritten without a call site:
  - a file outside `content` imports the library: add it to `content`;
  - an analyzed file imports the library through an alias the analysis can't read (`import { Button } from "@lib"`): import it from the package name;
  - a virtual module (no file on disk) imports the library: import it from a file in `content`;
  - a module outside `content` renders an app component whose props were read from its call sites: add it to `content`;
  - a module outside the library imports one of its script modules whose tailwind-variants tables were rewritten (through an alias, for example): import them from the package name.

## How it stays safe

**Unknown means open.** A component keeps every value of a prop the analysis can't read, and is rendered with any props wherever it can't see the call site:

- A prop passed as an expression it can't evaluate, spread from an object it can't read, or bound with `bind:` keeps every value.
- A component used as a value (`this={Button}`, passed as a prop), imported dynamically or through an alias, or rendered from a file outside `content` keeps every variant. The plugins check the bundler's module graph after the build and fail it when a module the analysis didn't read imports the library.
- A component whose props something other than a call site can set keeps every value: a custom element, or one bound with `bind:this` whose instance the app uses for more than calling what it exports (`$set`, an accessor, handing it on).
- Content counts: snippets are props, and content outside them is `children` on Svelte 5 and a slot on Svelte 3 and 4.
- An export of the library it can't tell apart from a component (a function that may return one) keeps every component.
- A tailwind-variants table keeps every key when something other than a live component's call can read it: the app imports it, another table extends it, a script module reads it, a namespace or `import()` reaches it, or a component hands on what a call with slots returns. A variant whose value at some call the analysis can't evaluate (a spread, a function's parameter) keeps every key. A table nothing calls is emptied only when nothing else can read it, and a script module that mounts a component keeps every table whole.

The app's own components are rewritten too, when every file that renders them is in `content`: a wrapper's props come from its call sites, so `<Card tone="danger">` reaches the `Button` inside it.

## Results

On real libraries, each component with every prop value it compares against plus random mixes of them, SSR-rendered with the original and the rewritten library:

| Library | Components | Apps rendering identically | Apps rendering differently |
|:---|:---|:---|:---|
| carbon-components-svelte | 262 | 2,330 | 0 |
| @sveltestrap/sveltestrap | 87 | 645 | 0 |
| svelte-ux | 101 | 999 | 0 |
| flowbite-svelte | 181 | 1,591 | 0 |
| svelte-5-ui-lib | 135 | 918 | 0 |
| bits-ui | 159 | 859 | 0 |
| @skeletonlabs/skeleton-svelte | 131 | 327 | 0 |

How much it saves depends on how a library is written. Gzipped client JS of a realistic page built with Vite ([`examples/`](examples/README.md)):

| Library | Style | Smaller by |
|:---|:---|:---|
| flowbite-svelte | Tailwind variants | 37.2% |
| carbon-components-svelte | branches on props | 23.6% |
| svelte-5-ui-lib | Tailwind variants | 18.7% |
| @sveltestrap/sveltestrap | branches on props | 17.6% |
| svelte-ux | Tailwind | 4.7% |
| bits-ui | headless, state in classes | 2.1% |
| @skeletonlabs/skeleton-svelte | headless, state machines | 0% |

Libraries whose markup branches on their props gain the most, and so do those whose tailwind-variants tables hold every variant's classes. Headless libraries that keep their state in classes or hand their props to a state machine leave little to fold.

Tailwind's CSS for the same pages (v4, with each library's plugin), gzipped, scanning `node_modules/.severan` instead of the package:

| Library | Smaller by |
|:---|:---|
| svelte-5-ui-lib | 71.7% |
| flowbite-svelte | 60.9% |
| svelte-ux | 24.9% |

## Limitations

- **Production builds only.** The analysis runs for the whole app before the build, so dev serving and HMR are left alone.
- **tailwind-variants tables only in the library's `.js` modules**, made with `tv` imported from `tailwind-variants`. Tables defined in components, or with `createTV`, keep every class.
- **Every importer must be in `content`.** A module outside it that imports the library fails the build rather than ship components rewritten without its call sites.
- **Values it can't evaluate stay open.** Props read from a whole `$props()` object, or state held in classes (`.svelte.js`), keep every value.
