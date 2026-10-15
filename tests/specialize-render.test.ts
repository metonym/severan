import {
  appRendering,
  type LibraryApp,
  renderSpecialized,
  specializedLibrary,
} from "./helpers/render-library";
import { TAILWIND_VARIANTS } from "./helpers/tailwind-variants";

// Each app renders the same HTML with the library rewritten for it as
// without: SSR, Svelte 5, `unwrap` off and on.

const CONTENT_LIBRARY = {
  "Card.svelte": `<script>
  let { children, header, title = "t" } = $props();
</script>
<div class="card">
  {#if header}<h2>{@render header()}</h2>{:else}<h2>no header</h2>{/if}
  {#if children}<div class="body">{@render children()}</div>{:else}<p>empty</p>{/if}
  <span>{title}</span>
</div>`,
  "Legacy.svelte": `<script>
  export let children = undefined;
</script>
<section>
  {#if $$slots.header}<slot name="header" />{:else}<i>no header slot</i>{/if}
  {#if $$slots.default}<slot />{:else}<i>no default slot</i>{/if}
  {#if children}<b>children prop</b>{:else}<b>no children prop</b>{/if}
  {#if $$props.children}<u>in $$props</u>{:else}<u>not in $$props</u>{/if}
</section>`,
  "Inner.svelte": `<script>
  let { children, header } = $props();
</script>
{#if children}<em>children</em>{:else}<em>no children</em>{/if}
{#if header}<em>header</em>{:else}<em>no header</em>{/if}`,
  "Outer.svelte": `<script>
  import Inner from "./Inner.svelte";
  let { mode = "a" } = $props();
</script>
{#if mode === "a"}
  <Inner>{#snippet header()}H{/snippet}</Inner>
{:else if mode === "b"}
  <Inner>text</Inner>
{:else}
  <Inner />
{/if}`,
  "RestLegacy.svelte": `<script>
  import Inner from "./Inner.svelte";
</script>
<Inner {...$$restProps} />`,
  "RestRunes.svelte": `<script>
  import Inner from "./Inner.svelte";
  let { ...rest } = $props();
</script>
<Inner {...rest} />`,
};

const content = (app: Record<string, string>): LibraryApp => ({
  lib: CONTENT_LIBRARY,
  app,
});

const SHAPES: Record<string, LibraryApp> = {
  "content as children": content(appRendering("<Card>hi</Card>")),
  "a snippet as its prop": content(
    appRendering("<Card>{#snippet header()}H{/snippet}</Card>"),
  ),
  "content at one site, a snippet at another": content(
    appRendering(
      "<Card>body</Card><Card>{#snippet header()}H{/snippet}</Card>",
    ),
  ),
  "a snippet named children": content(
    appRendering("<Card>{#snippet children()}C{/snippet}</Card>"),
  ),
  "children as an attribute": content(
    appRendering("{#snippet s()}S{/snippet}<Card children={s} />"),
  ),
  "no content": content(appRendering("<Card />")),
  "a slot attribute, in legacy mode": content(
    appRendering('<Legacy><span slot="header">h</span></Legacy>'),
  ),
  "a snippet filling a slot, in legacy mode": content(
    appRendering("<Legacy>{#snippet header()}H{/snippet}</Legacy>"),
  ),
  "content as children, in legacy mode": content(
    appRendering("<Legacy>content</Legacy>"),
  ),
  "no content, in legacy mode": content(appRendering("<Legacy />")),
  "content one library component passes another": content(
    appRendering('<Outer /><Outer mode="b" /><Outer mode="c" />'),
  ),
  "a snippet one library component passes another": content(
    appRendering("<Outer />"),
  ),
  "content left out of $$restProps": content(
    appRendering("<RestLegacy>content</RestLegacy>"),
  ),
  "content kept in the rest of $props()": content(
    appRendering("<RestRunes>content</RestRunes>"),
  ),
  "content an app component passes on": content({
    ...appRendering(
      "<Wrap>x</Wrap><Wrap />",
      'import Wrap from "./Wrap.svelte";',
    ),
    "Wrap.svelte": `<script>
  import { Card } from "mylib";
  let { children } = $props();
</script>
{#if children}<Card>{@render children()}</Card>{:else}<Card />{/if}`,
  }),
};

describe("specialized libraries render as the original", () => {
  const cases = Object.keys(SHAPES).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(SHAPES[name], { unwrap });
    expect(after).toBe(before);
  });
});

// Props a parent sets through the instance `bind:this` binds (`$set`,
// accessors), or that a custom element's attributes set, aren't call
// sites: such a component keeps every value. One whose instance is only
// read for what it exports is still rewritten.

const INSTANCE_LIBRARY = {
  "Kind.svelte": `<svelte:options accessors />
<script>
  export let kind = "a";
  export function open() {}
</script>
{#if kind === "b"}<b>B</b>{:else}<i>A</i>{/if}`,
  "Element.svelte": `<svelte:options customElement="x-element" />
<script>
  export let kind = "a";
</script>
{#if kind === "b"}<b>B</b>{:else}<i>A</i>{/if}`,
  "Outer.svelte": `<script>
  import Kind from "./Kind.svelte";
  let kind;
  $: kind?.$set({ kind: "b" });
</script>
<Kind bind:this={kind} />`,
};

const instance = (markup: string, script = ""): LibraryApp => ({
  lib: INSTANCE_LIBRARY,
  app: appRendering(markup, script),
});

const KEEPS_EVERY_VALUE: Record<string, LibraryApp> = {
  "an accessor written": instance(
    '<Kind bind:this={k} /><button on:click={() => (k.kind = "b")}>b</button>',
    "let k;",
  ),
  "`$set` called": instance(
    '<Kind bind:this={k} /><button on:click={() => k.$set({ kind: "b" })}>b</button>',
    "let k;",
  ),
  "the instance handed on": instance(
    "<Kind bind:this={k} />",
    "import { register } from './register.js';\nlet k;\n$: register(k);",
  ),
  "the instance bound to a property": instance(
    "<Kind bind:this={refs.k} />",
    "const refs = {};",
  ),
  "an accessor read": instance("<Kind bind:this={k} />{k?.kind}", "let k;"),
  "`$set` called by a library component": instance("<Outer />"),
  "a custom element": instance("<Element />"),
};

const STILL_REWRITTEN: Record<string, LibraryApp> = {
  "an export called": instance(
    "<Kind bind:this={k} /><button on:click={() => k.open()}>open</button>",
    "let k;",
  ),
  "an export called after a test": instance(
    "<Kind bind:this={k} /><button on:click={() => k && k.open()}>open</button>{#if k}bound{/if}",
    "let k;",
  ),
  "an export called optionally": instance(
    "<Kind bind:this={k} /><button on:click={() => k?.open()}>open</button>",
    "let k;",
  ),
};

describe("props set outside call sites", () => {
  test.each(Object.keys(KEEPS_EVERY_VALUE))("%s keeps them", async (name) => {
    const sources = await specializedLibrary(KEEPS_EVERY_VALUE[name]);
    const component = name === "a custom element" ? "Element" : "Kind";
    expect(sources[`${component}.svelte`]).toContain("<b>B</b>");
  });

  test.each(Object.keys(STILL_REWRITTEN))("%s still rewrites", async (name) => {
    const sources = await specializedLibrary(STILL_REWRITTEN[name]);
    expect(sources["Kind.svelte"]).not.toContain("<b>B</b>");
    const { before, after } = await renderSpecialized(STILL_REWRITTEN[name], {
      unwrap: false,
    });
    expect(after).toBe(before);
  });
});

// A library component may render another package's components and import
// its own modules as a namespace.

const IMPORTS_LIBRARY = {
  "Inner.svelte": `<script>
  export let kind = "a";
</script>
{#if kind === "b"}<b>B</b>{:else}<i>A</i>{/if}`,
  "Tag.svelte": `<script>
  import * as L from "./index.js";
</script>
<L.Inner kind="b" />`,
  "Value.svelte": `<script>
  import * as L from "./index.js";
</script>
<svelte:component this={L.Inner} kind="b" />`,
  "Bare.svelte": `<script>
  import * as L from "./index.js";
  const all = L;
</script>
<svelte:component this={all.Inner} kind="b" />`,
  "Wraps.svelte": `<script>
  import Frame from "frame-kit";
  import * as Kit from "frame-kit";
  import Inner from "./Inner.svelte";
  export let kind = "a";
</script>
<Frame title={kind}>
  <Inner {kind} />
  {#if kind === "z"}<p>z</p>{/if}
</Frame>
<Kit.Frame><Inner kind="b" /></Kit.Frame>`,
};

const PACKAGES = {
  "frame-kit": {
    "index.js": 'export { default, default as Frame } from "./Frame.svelte";',
    "Frame.svelte": `<script>
  export let title = "";
</script>
<div class="frame" {title}><slot /></div>`,
  },
};

const imports = (markup: string): LibraryApp => ({
  lib: IMPORTS_LIBRARY,
  app: appRendering(markup),
  packages: PACKAGES,
});

describe("imports a library component renders through", () => {
  const RENDER: Record<string, LibraryApp> = {
    "a namespace member as a tag": imports("<Tag />"),
    "a namespace member and an import": imports("<Tag /><Inner />"),
    "a namespace member as a value": imports("<Value /><Inner />"),
    "another package's component": imports("<Wraps />"),
  };
  const cases = Object.keys(RENDER).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(RENDER[name], { unwrap });
    expect(after).toBe(before);
  });

  test("a namespace member's props are read", async () => {
    const sources = await specializedLibrary(imports("<Tag />"));
    expect(sources["Inner.svelte"]).not.toContain("<i>A</i>");
  });

  test("another package's component leaves the rest rewritten", async () => {
    const sources = await specializedLibrary(imports("<Wraps />"));
    expect(sources["Wraps.svelte"]).not.toContain("<p>z</p>");
  });

  test("a namespace used as a value turns the analysis off", async () => {
    await expect(
      specializedLibrary(imports("<Bare /><Inner />")),
    ).rejects.toThrow(
      "Bare.svelte uses `L`, an object of components, as a value",
    );
  });
});

// Svelte syntax the rewrite has to keep working around: each component
// branches on `kind`, which every call site passes as "b".

/** A component that renders `body` and branches on `kind`, in runes mode. */
const runes = (body: string, script = "", lang = "") => `<script${lang}>
  let { kind = "a" } = $props();
  ${script}
</script>
{#if kind === "a"}<i>A</i>{:else}<b>B</b>{/if}
${body}`;

/** The same, in legacy mode. */
const legacy = (body: string, script = "") => `<script>
  export let kind = "a";
  ${script}
</script>
{#if kind === "a"}<i>A</i>{:else}<b>B</b>{/if}
${body}`;

const SYNTAX: Record<string, string> = {
  "$state.raw and $derived.by": runes(
    "<p>{list.length} {label}</p>",
    "let list = $state.raw([1, 2]);\n  let label = $derived.by(() => kind + list.length);",
  ),
  "$effect, $inspect and $props.id": runes(
    "<p id={id}>{kind}</p>",
    "const id = $props.id();\n  $effect(() => { console.log(kind); });\n  $inspect(kind);",
  ),
  "{@attach}": runes(
    "<div {@attach (node) => { node.dataset.kind = kind; }}>x</div>",
  ),
  "<svelte:boundary>": runes(
    "<svelte:boundary><p>{kind}</p>{#snippet failed(error)}<p>failed</p>{/snippet}</svelte:boundary>",
  ),
  "class as an array and an object": runes(
    '<p class={["x", kind === "a" && "is-a", { "is-b": kind === "b" }]}>c</p>',
  ),
  "{#each} without `as`": runes(
    "{#each { length: kind === 'a' ? 1 : 2 }}<span>*</span>{/each}",
  ),
  "<svelte:head>, <svelte:window>, <svelte:document> and <svelte:body>": runes(
    "<svelte:head><title>{kind}</title></svelte:head><svelte:window onresize={() => {}} /><svelte:document onclick={() => {}} /><svelte:body onkeydown={() => {}} />",
  ),
  generics: runes(
    "<p>{items.length}</p>",
    "const items: T[] = [];",
    ' lang="ts" generics="T extends string"',
  ),
  "<script module>": `<script module>
  export const KINDS = ["a", "b"];
</script>
${runes("<p>{KINDS.join()}</p>")}`,
  "use:, transition: and animate:": legacy(
    '{#each [kind] as k (k)}<p use:act={kind} transition:fade={{ duration: kind === "a" ? 1 : 2 }} animate:flip>{k}</p>{/each}',
    'import { fade } from "svelte/transition";\n  import { flip } from "svelte/animate";\n  const act = () => {};',
  ),
  "<svelte:element>": runes(
    '<svelte:element this={kind === "a" ? "em" : "strong"}>e</svelte:element>',
  ),
  "{#key} and {@html}": runes(
    '{#key kind}<p>{@html kind === "a" ? "<u>a</u>" : "<s>b</s>"}</p>{/key}',
  ),
  createEventDispatcher: legacy(
    "<button on:click={() => dispatch(kind)}>d</button>",
    'import { createEventDispatcher } from "svelte";\n  const dispatch = createEventDispatcher();',
  ),
  "<svelte:options>": `<svelte:options immutable />
${legacy("<p>{kind}</p>")}`,
  "<svelte:fragment slot>": legacy('<div><slot name="title" /></div>'),
};

describe("syntax around a rewrite", () => {
  const shape = (component: string): LibraryApp => ({
    lib: { "Syntax.svelte": component },
    app: appRendering(
      '<Syntax kind="b" /><Syntax kind="b"><svelte:fragment slot="title">t</svelte:fragment></Syntax>',
    ),
  });
  const cases = Object.keys(SYNTAX).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after, edits } = await renderSpecialized(
      shape(SYNTAX[name]),
      { unwrap },
    );
    expect(after).toBe(before);
    expect(edits).toBeGreaterThan(0);
  });
});

describe("writes a rewrite keeps", () => {
  const WRITES: Record<string, string> = {
    "in $effect": runes("", '$effect(() => { kind = "a"; });'),
    "in $effect.pre": runes("", '$effect.pre(() => { kind = "a"; });'),
    "in {@attach}": runes('<div {@attach () => { kind = "a"; }}>x</div>'),
    "in an action's argument": runes(
      '<div use:act={() => (kind = "a")}>x</div>',
      "const act = () => {};",
    ),
    "by bind:value": runes("<input bind:value={kind} />"),
    "by a function binding": runes(
      "<input bind:value={() => kind, (value) => (kind = value)} />",
    ),
    "in an event attribute": runes(
      '<button onclick={() => (kind = "a")}>a</button>',
    ),
  };
  test.each(Object.keys(WRITES))("%s", async (name) => {
    const sources = await specializedLibrary({
      lib: { "Syntax.svelte": WRITES[name] },
      app: appRendering('<Syntax kind="b" />'),
    });
    const code = sources["Syntax.svelte"] ?? WRITES[name];
    expect(code).toContain("<i>A</i>");
    expect(code).toContain("<b>B</b>");
  });
});

test("`await` in markup is rewritten around", async () => {
  // Rendering it needs `experimental.async`; only the rewrite is checked.
  const sources = await specializedLibrary({
    lib: {
      "Syntax.svelte": runes(
        "<p>{await load(kind)}</p>",
        "const load = async (k) => k;",
      ),
    },
    app: appRendering('<Syntax kind="b" />'),
  });
  expect(sources["Syntax.svelte"]).toContain('{await load("b")}');
  expect(sources["Syntax.svelte"]).not.toContain("<i>A</i>");
});

// What a library's barrel exports: `export *`, namespaces, components with
// members, and values. One the analysis can't tell keeps every component.

const KIND = `<script>
  export let kind = "a";
</script>
{#if kind === "b"}<b>B</b>{:else}<i>A</i>{/if}`;

const BARREL_LIBRARY = {
  "index.js": `export { default as Outer } from "./Outer.svelte";
export * from "./parts/index.js";
export * from "./parts/index.js";
export * as Parts from "./parts/index.js";
export { Card } from "./card.js";
export * from "./Sizes.svelte";
export { cn, pick } from "./helpers.js";
export { default as Uses } from "./Uses.svelte";
export { Listed } from "./listed.js";`,
  "parts/index.js": 'export { default as Inner } from "./Inner.svelte";',
  "listed.js": `import Inner from "./parts/Inner.svelte";
export {};
export { Inner as Listed };`,
  "parts/Inner.svelte": KIND,
  "Outer.svelte": `<script>
  import Inner from "./parts/Inner.svelte";
</script>
<Inner kind="a" />`,
  "card.js": `import Root from "./Root.svelte";
import Item from "./parts/Inner.svelte";
export const Card = Object.assign(Root, { Item });`,
  "Root.svelte": "<div><slot /></div>",
  "Sizes.svelte": `<script module>
  export const SIZES = ["sm", "md"];
</script>`,
  "Uses.svelte": `<script>
  import { Parts, Card } from "./index.js";
</script>
<Parts.Inner kind="b" />
<Card><Card.Item kind="b" /></Card>`,
  "helpers.js": `import Inner from "./parts/Inner.svelte";
export function cn(...parts) {
  return parts.join(" ");
}
export function pick() {
  return Inner;
}`,
};

const barrel = (markup: string, script = ""): LibraryApp => ({
  lib: BARREL_LIBRARY,
  app: appRendering(markup, script),
});

test.each([false, true])(
  "reads a prop `export { … as … }` renames (unwrap: %p)",
  async (unwrap) => {
    const shape: LibraryApp = {
      lib: {
        "Label.svelte": `<script>
  export let fore = null;
  export { fore as for };
</script>
<label for={fore}>{#if fore}<b>for</b>{:else}<i>none</i>{/if}</label>`,
      },
      app: appRendering('<Label for="e" />'),
    };
    const { before, after } = await renderSpecialized(shape, { unwrap });
    expect(after).toBe(before);
  },
);

describe("barrels", () => {
  const RENDER: Record<string, LibraryApp> = {
    "`export *`": barrel("<Outer /><Inner kind='b' />"),
    "a namespace re-export": barrel("<Outer /><Parts.Inner kind='b' />"),
    "a component with members": barrel(
      "<Outer /><Card><Card.Item kind='b' /></Card>",
    ),
    "an import exported again": barrel("<Outer /><Listed kind='b' />"),
    "the library's own imports of those": barrel("<Uses /><Inner />"),
    "a value it exports": barrel(
      "<Inner kind='b' />{SIZES.length}{cn('x')}",
      'import { SIZES, cn } from "mylib";',
    ),
  };
  const cases = Object.keys(RENDER).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)(
    "%s renders as the original (unwrap: %p)",
    async (name, unwrap) => {
      const { before, after } = await renderSpecialized(RENDER[name], {
        unwrap,
      });
      expect(after).toBe(before);
    },
  );

  test.each([
    ["`export *`", "<Inner kind='b' />"],
    ["a namespace re-export", "<Parts.Inner kind='b' />"],
    ["a component with members", "<Card><Card.Item kind='b' /></Card>"],
    ["an import exported again", "<Listed kind='b' />"],
  ])("reads a call site through %s", async (_, markup) => {
    const sources = await specializedLibrary(barrel(markup));
    expect(sources["parts/Inner.svelte"]).not.toContain("<i>A</i>");
  });

  test("reads the library's own call sites through them", async () => {
    const sources = await specializedLibrary(barrel("<Uses />"));
    expect(sources["parts/Inner.svelte"]).not.toContain("<i>A</i>");
  });

  test("a value it exports leaves the rest rewritten", async () => {
    const sources = await specializedLibrary(
      barrel("<Inner kind='b' />{cn('x')}", 'import { cn } from "mylib";'),
    );
    expect(sources["parts/Inner.svelte"]).not.toContain("<i>A</i>");
  });

  test("an export that may hold a component keeps every one", async () => {
    const sources = await specializedLibrary(
      barrel(
        "<Inner kind='b' /><svelte:component this={pick()} />",
        'import { pick } from "mylib";',
      ),
    );
    expect(sources["parts/Inner.svelte"] ?? KIND).toContain("<i>A</i>");
  });
});

// Svelte 5 drops whitespace-only text that an element like `<thead>` holds
// directly, not what a block inside it holds: a block there stays a block
// under `unwrap`, or the whitespace it held would go.
describe("blocks in elements that drop whitespace", () => {
  const live = (inner: string) =>
    `{#if items}\n    {#if header}\n      {@render header()}\n    {/if}\n    ${inner}\n  {/if}`;
  const MARKUP: Record<string, string> = {
    table: `<table>\n  ${live("<tbody><tr><td>{items}</td></tr></tbody>")}\n</table>`,
    thead: `<table><thead>\n  ${live("<tr><th>{items}</th></tr>")}\n</thead></table>`,
    tbody: `<table><tbody>\n  ${live("<tr><td>{items}</td></tr>")}\n</tbody></table>`,
    tfoot: `<table><tfoot>\n  ${live("<tr><td>{items}</td></tr>")}\n</tfoot></table>`,
    tr: `<table><tbody><tr>\n  ${live("<td>{items}</td>")}\n</tr></tbody></table>`,
    colgroup: `<table><colgroup>\n  ${live('<col span="1" />')}\n</colgroup></table>`,
    select: `<select>\n  ${live("<option>{items}</option>")}\n</select>`,
    datalist: `<datalist>\n  ${live("<option>{items}</option>")}\n</datalist>`,
  };
  const cases = Object.keys(MARKUP).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("<%s> (unwrap: %p)", async (name, unwrap) => {
    const shape: LibraryApp = {
      lib: {
        "Rows.svelte": `<script>\n  let { items, header } = $props();\n</script>\n\n${MARKUP[name]}`,
      },
      app: appRendering('<Rows items="x" />'),
    };
    const { before, after } = await renderSpecialized(shape, { unwrap });
    expect(after).toBe(before);
  });
});

// tailwind-variants tables in the library's script modules lose the keys no
// live call can select, and the compound variants that need one; a table
// nothing calls keeps no classes. Any use the analysis can't read keeps them.

const THEME = `import { tv } from "tailwind-variants";
export const button = tv({
  base: "btn",
  variants: {
    color: { red: "bg-red", green: "bg-green", blue: "bg-blue" },
    size: { sm: "text-sm", md: "text-md", lg: "text-lg" },
    pill: { true: "rounded-full", false: "rounded" },
  },
  compoundVariants: [
    { color: "red", size: "lg", class: "red-lg" },
    { color: ["green", "blue"], pill: true, class: "cool-pill" },
  ],
  defaultVariants: { color: "blue", size: "md" },
});
export const crumb = tv({
  slots: { base: "crumb", icon: "icon" },
  variants: {
    home: { true: { base: "home", icon: "icon-home" }, false: { base: "page" } },
    tone: { dark: { icon: "icon-dark" }, light: { icon: "icon-light" } },
  },
  defaultVariants: { tone: "light" },
});
export const badge = tv({ base: "badge", variants: { tint: { gray: "bg-gray", teal: "bg-teal" } } });
`;

const TABLES_LIBRARY = {
  "theme.js": THEME,
  "index.js": `export { default as Button } from "./Button.svelte";
export { default as Crumb } from "./Crumb.svelte";
export { default as Badge } from "./Badge.svelte";
export { default as Toggle } from "./Toggle.svelte";
export { default as Swatches } from "./Swatches.svelte";
export { default as Picker } from "./Picker.svelte";
export { default as Spread } from "./Spread.svelte";
export * from "./theme.js";
`,
  "Button.svelte": `<script>
  import { button } from "./theme.js";
  let { color, size, pill = false, children } = $props();
  const cls = $derived(button({ color, size, pill }));
</script>
<button class={cls}>{@render children?.()}</button>`,
  "Crumb.svelte": `<script>
  import { crumb } from "./theme.js";
  let { home = false, tone, children } = $props();
  const { base, icon } = $derived(crumb({ tone }));
</script>
<li class={base({ home })}><i class={icon()}></i>{@render children?.()}</li>`,
  "Badge.svelte": `<script>
  import { badge } from "./theme.js";
  let { tint = "gray" } = $props();
</script>
<span class={badge({ tint })}>b</span>`,
  "Toggle.svelte": `<script>
  import { button } from "./theme.js";
  let on = $state(false);
</script>
<button class={button({ pill: on, color: "green" })} onclick={() => (on = !on)}>t</button>`,
  "Swatches.svelte": `<script>
  import { button } from "./theme.js";
</script>
{#each ["red", "green"] as color}<span class={button({ color, size: "sm" })}></span>{/each}`,
  "Picker.svelte": `<script>
  import { button } from "./theme.js";
  const cls = (color) => button({ color });
</script>
<span class={cls("red")}></span>`,
  "Spread.svelte": `<script>
  import { button } from "./theme.js";
  let { ...rest } = $props();
</script>
<span class={button({ ...rest })}></span>`,
};

const tables = (
  markup: string,
  script = "",
  lib: Record<string, string> = {},
): LibraryApp => ({
  lib: { ...TABLES_LIBRARY, ...lib },
  app: appRendering(markup, script),
  packages: { "tailwind-variants": TAILWIND_VARIANTS },
  tailwind: true,
});

const TABLE_APPS: Record<string, LibraryApp> = {
  "one color and size": tables('<Button color="red" size="lg">x</Button>'),
  defaults: tables("<Button>x</Button>"),
  "a boolean variant": tables('<Button pill color="green">x</Button>'),
  "colors from several call sites": tables(
    '<Button color="red" /><Button color="green" pill size="sm" />',
  ),
  "slots, and a slot call's own props": tables(
    '<Crumb home>Home</Crumb><Crumb tone="dark">Page</Crumb>',
  ),
  "state a handler changes": tables("<Toggle />"),
  "each-block items": tables("<Swatches />"),
  "a call inside a function": tables("<Picker />"),
  "props spread into a call": tables('<Spread color="red" />'),
  "a value the app passes on": tables(
    "<Button {color}>x</Button>",
    'let { color = "red" } = $props();',
  ),
};

describe("tailwind-variants tables render as the original", () => {
  const cases = Object.keys(TABLE_APPS).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(TABLE_APPS[name], {
      unwrap,
    });
    expect(after).toBe(before);
  });
});

describe("tailwind-variants tables", () => {
  const theme = async (shape: LibraryApp) =>
    (await specializedLibrary(shape))["theme.js"] ?? THEME;

  test("stay as they are without `tailwind: true`", async () => {
    const shape = { ...TABLE_APPS["one color and size"], tailwind: undefined };
    expect((await specializedLibrary(shape))["theme.js"]).toBeUndefined();
  });

  test("drop the keys and compound variants no call selects", async () => {
    const code = await theme(TABLE_APPS["one color and size"]);
    for (const kept of ["bg-red", "text-lg", "rounded", "red-lg", "crumb"]) {
      expect(code).toContain(kept);
    }
    for (const dropped of ["bg-green", "bg-blue", "text-sm", "text-md"]) {
      expect(code).not.toContain(dropped);
    }
    expect(code).not.toContain("rounded-full");
    expect(code).not.toContain("cool-pill");
  });

  test("keep the default a call leaves out", async () => {
    const code = await theme(TABLE_APPS.defaults);
    expect(code).toContain("bg-blue");
    expect(code).toContain("text-md");
    expect(code).not.toContain("bg-red");
  });

  test("keep what slot calls pass", async () => {
    const code = await theme(TABLE_APPS["slots, and a slot call's own props"]);
    for (const kept of ["icon-home", "page", "icon-dark", "icon-light"]) {
      expect(code).toContain(kept);
    }
  });

  test("empty a table nothing calls", async () => {
    const code = await theme(TABLE_APPS["one color and size"]);
    expect(code).toContain("export const badge = tv({})");
    expect(code).not.toContain("bg-gray");
  });

  test("keep both keys of a boolean that changes", async () => {
    const code = await theme(TABLE_APPS["state a handler changes"]);
    expect(code).toContain("rounded-full");
    expect(code).toContain("cool-pill");
    expect(code).not.toContain("bg-red");
  });

  test.each([
    ["a call inside a function", "color"],
    ["props spread into a call", "color"],
  ])("keep every key a variant may get: %s", async (name) => {
    const code = await theme(TABLE_APPS[name]);
    expect(code).toContain("bg-green");
    expect(code).toContain("bg-blue");
  });

  test.each([
    [
      "the app imports it",
      tables('<Button color="red" />', 'import { button } from "mylib";'),
    ],
    [
      "the app imports the library as a namespace",
      tables('<Button color="red" />', 'import * as L from "mylib";'),
    ],
    [
      "another table extends it",
      tables('<Button color="red" />', "", {
        "more.js": `import { tv } from "tailwind-variants";
import { button } from "./theme.js";
export const big = tv({ extend: button, base: "big" });`,
      }),
    ],
    [
      "a script module reads it",
      tables('<Button color="red" />', "", {
        "classes.js": `import { button } from "./theme.js";
export const red = () => button({ color: "red" });`,
      }),
    ],
    [
      "a component imports its module dynamically",
      tables("<Lazy />", "", {
        "Lazy.svelte": `<script>
  import Button from "./Button.svelte";
  const theme = import("./theme.js");
</script>
<Button color="red" />{#await theme then { button }}<i class={button({ color: "green" })}></i>{/await}`,
        "index.js": `${TABLES_LIBRARY["index.js"]}export { default as Lazy } from "./Lazy.svelte";\n`,
      }),
    ],
    [
      // Lexed as a script, the apostrophe and the URL would hide the import.
      "a component imports its module in markup",
      tables("<Lazy />", "", {
        "Lazy.svelte": `<script>
  import Button from "./Button.svelte";
</script>
<p>It's at https://example.com</p>
<Button color="red" />{#await import("./theme.js") then { button }}<i class={button({ color: "green" })}></i>{/await}`,
        "index.js": `${TABLES_LIBRARY["index.js"]}export { default as Lazy } from "./Lazy.svelte";\n`,
      }),
    ],
    [
      "a script module imports a module it computes",
      tables('<Button color="red" />', "", {
        "load.js": `export const load = (name) => import(\`./\${name}.js\`);`,
      }),
    ],
    [
      "a component hands it on",
      tables("<Hands />", "", {
        "Hands.svelte": `<script>
  import { button } from "./theme.js";
  import Button from "./Button.svelte";
  const make = button;
</script>
<Button color="red" /><span class={make({ color: "green" })}></span>`,
        "index.js": `${TABLES_LIBRARY["index.js"]}export { default as Hands } from "./Hands.svelte";\n`,
      }),
    ],
  ])("keep every class when %s", async (_, shape) => {
    expect(await theme(shape)).toContain("bg-green");
    const { before, after } = await renderSpecialized(shape, { unwrap: true });
    expect(after).toBe(before);
  });

  test("read past an import in a comment or a string", async () => {
    const code = await theme(
      tables('<Button color="red" />', "", {
        "load.js": `// import(\`./\${name}.js\`)
export const help = "require(name) loads it";`,
      }),
    );
    expect(code).toContain("bg-red");
    expect(code).not.toContain("bg-green");
  });

  test("follow a table re-exported through an index", async () => {
    const shape = tables('<Card color="green" />', "", {
      "card/theme.js": `import { tv } from "tailwind-variants";
export const card = tv({ variants: { color: { green: "card-green", gray: "card-gray" } } });`,
      "card/index.js": `import Card from "./Card.svelte";
import { card } from "./theme.js";
export { Card, card };`,
      "card/Card.svelte": `<script>
  import { card } from ".";
  let { color } = $props();
</script>
<div class={card({ color })}></div>`,
      "index.js": `${TABLES_LIBRARY["index.js"]}export * from "./card/index.js";\n`,
    });
    const sources = await specializedLibrary(shape);
    expect(sources["card/theme.js"]).toContain("card-green");
    expect(sources["card/theme.js"]).not.toContain("card-gray");
    const { before, after } = await renderSpecialized(shape, { unwrap: true });
    expect(after).toBe(before);
  });
});

// Svelte 5 infers a fragment's namespace from what it holds: a block whose
// direct elements are all SVG drops the whitespace between its nodes. A
// rewrite that would change what's inferred keeps the block, or the branch.
describe("namespaces Svelte infers", () => {
  const SHAPES: Record<string, string> = {
    "an unwrapped SVG in a block": `<script>
  let { home = false, icon, href } = $props();
</script>
<li>
  {#if home}
    <a href="/">home</a>
  {:else}
    {#if icon}
      {@render icon()}
    {:else}
      <svg></svg>
    {/if}

    {#if href}
      <a {href}>link</a>
    {:else}
      <span>page</span>
    {/if}
  {/if}
</li>`,
    "the only HTML branch removed from a component's root": `<script>
  let { kind = "a" } = $props();
</script>
<svg></svg>
{#if kind === "a"}<span>a</span>{/if}
<svg></svg>`,
    "HTML unwrapped into an SVG block": `<script>
  let { open = true, kind = "a" } = $props();
</script>
<div>
  {#if open}
    <svg></svg>
    {#if kind === "a"}<span>a</span>{:else}<b>b</b>{/if}
    <svg></svg>
  {/if}
</div>`,
  };
  const cases = Object.keys(SHAPES).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(
      {
        lib: { "Shape.svelte": SHAPES[name] },
        // A `home` and an `href` it can't read keep their blocks.
        app: appRendering(
          '<Shape kind="b" home={flag} href={link} />',
          "let { flag, link } = $props();",
        ),
      },
      { unwrap },
    );
    expect(after).toBe(before);
  });
});

// `<svelte:component this={icons[kind]}>` over `const icons = { … }`: only
// the entries `kind` can select render, and the rest go from the map.
describe("component maps", () => {
  const ICONS = `import A from "./icons/A.svelte";
  import B from "./icons/B.svelte";
  import C from "./icons/C.svelte";
  const icons = { a: A, b: B, "c-c": C };`;
  const lib = {
    "icons/A.svelte": "<b>A</b>",
    "icons/B.svelte": "<b>B</b>",
    "icons/C.svelte": "<b>C</b>",
    "Icon.svelte": `<script>\n  export let kind = "a";\n  ${ICONS}\n</script>\n<svelte:component this={icons[kind]} />`,
    "IconRunes.svelte": `<script>\n  let { kind = "a" } = $props();\n  ${ICONS}\n</script>\n<svelte:component this={icons[kind]} />`,
    "Leaks.svelte": `<script>\n  export let kind = "a";\n  ${ICONS}\n  $: count = Object.keys(icons).length;\n</script>\n<svelte:component this={icons[kind]} />{count}`,
    "EachIcon.svelte": `<script>\n  export let kinds = ["a"];\n  ${ICONS}\n</script>\n{#each kinds as k}<svelte:component this={icons[k]} />{/each}`,
    "Dotted.svelte": `<script>\n  export let kind = "a";\n  ${ICONS}\n</script>\n<svelte:component this={icons[kind]} /><svelte:component this={icons.b} />`,
  };
  // `App`'s own props: no call site sets them.
  const SCRIPT = 'export let k = "b";';
  const APPS: Record<string, string> = {
    "a known key": '<Icon kind="b" />',
    "the default key": "<Icon />",
    "a key with no entry": '<Icon kind="zzz" />',
    "a key it can't read": "<Icon kind={k} />",
    runes: '<IconRunes kind="c-c" />',
    "a map read other than by `this`": '<Leaks kind="b" />',
    "a key from `{#each}`": "<EachIcon kinds={['b', 'c-c']} />",
    "a member read by name": '<Dotted kind="a" />',
  };
  const cases = Object.keys(APPS).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)(
    "%s renders as the original (unwrap: %p)",
    async (name, unwrap) => {
      const shape = { lib, app: appRendering(APPS[name], SCRIPT) };
      const { before, after } = await renderSpecialized(shape, { unwrap });
      expect(after).toBe(before);
    },
  );

  const mapOf = async (markup: string, file: string) =>
    (await specializedLibrary({ lib, app: appRendering(markup, SCRIPT) }))[
      file
    ] ?? "";

  test.each([
    ['<Icon kind="b" />', "Icon.svelte", "const icons = { b: B }"],
    ["<Icon />", "Icon.svelte", "const icons = { a: A }"],
    ['<Icon kind="zzz" />', "Icon.svelte", "const icons = {}"],
    [
      '<IconRunes kind="c-c" />',
      "IconRunes.svelte",
      'const icons = { "c-c": C }',
    ],
    ['<Dotted kind="a" />', "Dotted.svelte", "const icons = { a: A, b: B }"],
  ])("%s keeps only what it selects", async (markup, file, map) => {
    expect(await mapOf(markup, file)).toContain(map);
  });

  test.each([
    ["<Icon kind={k} />", "Icon.svelte"],
    ['<Leaks kind="b" />', "Leaks.svelte"],
    ["<EachIcon kinds={['b']} />", "EachIcon.svelte"],
  ])("%s keeps every entry", async (markup, file) => {
    const code = await mapOf(markup, file);
    expect(code === "" || code.includes('{ a: A, b: B, "c-c": C }')).toBe(true);
  });
});
