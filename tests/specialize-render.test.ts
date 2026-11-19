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

// A prop nothing reads anymore is removed, unless removing it shows: a
// site passes it and it would land in `$$restProps`, or its default runs.

const UNREAD_LIBRARY = {
  "Rest.svelte": `<script>
  export let warn = false;
  export let mode = "a";
</script>
{#if mode === "b"}<p>{warn}</p>{/if}<div {...$$restProps}></div>`,
  "Props.svelte": `<script>
  export let warn = false;
  export let mode = "a";
</script>
{#if mode === "b"}<p>{warn}</p>{/if}<div data-keys={Object.keys($$props).sort().join()}></div>`,
  "Counter.svelte": `<script context="module">
  let count = 0;
</script>
<script>
  export let id = \`x\${count++}\`;
  export let mode = "a";
</script>
{#if mode === "b"}{id}{/if}<span>{count}</span>`,
};

const unread = (markup: string): LibraryApp => ({
  lib: UNREAD_LIBRARY,
  app: appRendering(markup),
});

const UNREAD: Record<string, LibraryApp> = {
  "passed, with $$restProps": unread("<Rest warn /><Rest warn={false} />"),
  "passed at one site, with $$restProps": unread("<Rest /><Rest warn />"),
  "not passed, with $$restProps": unread('<Rest data-x="1" />'),
  "passed, with $$props": unread("<Props warn /><Props />"),
  "with a default that has effects": unread("<Counter /><Counter />"),
};

describe("props nothing reads anymore", () => {
  const cases = Object.keys(UNREAD).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(UNREAD[name], { unwrap });
    expect(after).toBe(before);
  });

  test("are removed when no site passes them", async () => {
    const sources = await specializedLibrary(unread('<Rest data-x="1" />'));
    expect(sources["Rest.svelte"]).not.toContain("export let");
  });

  test("stay when a site passes them and the component reads its rest", async () => {
    const sources = await specializedLibrary(unread("<Rest /><Rest warn />"));
    expect(sources["Rest.svelte"]).toContain("export let warn");
    expect(sources["Rest.svelte"]).not.toContain("export let mode");
  });
});

// A prop no call site passes or binds holds the component's own state:
// it's declared with `let`, not `export let`.

const LOCAL_LIBRARY = {
  "Toggle.svelte": `<script context="module">
  let count = 0;
</script>
<script>
  export let open = false;
  export let id = \`t\${count++}\`;
  export let format = (value) => \`[\${value}]\`;
  $: open = open || id.length > 5;
</script>
<p {id}>{format(open)}</p><span>{Object.keys($$props).join()}</span>`,
};

const local = (markup: string, script = ""): LibraryApp => ({
  lib: LOCAL_LIBRARY,
  app: appRendering(markup, script),
});

const LOCAL: Record<string, LibraryApp> = {
  "nothing passed": local("<Toggle /><Toggle />"),
  "passed at one site": local("<Toggle /><Toggle open />"),
  "bound at one site": local(
    "<Toggle /><Toggle bind:open={o} />{o}",
    "let o = false;",
  ),
  "an id passed": local('<Toggle id="a-long-id" /><Toggle />'),
};

describe("props no site passes", () => {
  const cases = Object.keys(LOCAL).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(LOCAL[name], { unwrap });
    expect(after).toBe(before);
  });

  test("become the component's own state", async () => {
    const sources = await specializedLibrary(local("<Toggle />"));
    expect(sources["Toggle.svelte"]).not.toContain("export let");
  });

  test("stay props where a site passes or binds them", async () => {
    const sources = await specializedLibrary(
      local("<Toggle bind:open={o} />", "let o = false;"),
    );
    expect(sources["Toggle.svelte"]).toContain("export let open");
    expect(sources["Toggle.svelte"]).not.toContain("export let id");
  });
});

// A bare `on:click` hands the event to the component's listeners; with none
// at any call site, it does nothing and goes. Rendering can't show a
// listener, so these read the rewritten source.

const EVENTS_LIBRARY = {
  "Btn.svelte": `<button on:click on:focus on:keydown|preventDefault><slot /></button>`,
  "Outer.svelte": `<script>
  import Btn from "./Btn.svelte";
</script>
<Btn on:click on:focus={() => {}} />`,
};

const events = (markup: string, script = ""): LibraryApp => ({
  lib: EVENTS_LIBRARY,
  app: appRendering(markup, script),
});

describe("events nothing listens to", () => {
  const forwards = async (shape: LibraryApp, file: string) =>
    (await specializedLibrary(shape))[file] ??
    EVENTS_LIBRARY[file as keyof typeof EVENTS_LIBRARY];

  test("go, and a modifier on an element stays", async () => {
    const code = await forwards(events("<Btn />"), "Btn.svelte");
    expect(code).not.toContain("on:click");
    expect(code).not.toContain("on:focus");
    expect(code).toContain("on:keydown|preventDefault");
  });

  test("stay where a site listens", async () => {
    const code = await forwards(
      events("<Btn on:click={() => {}} /><Btn />"),
      "Btn.svelte",
    );
    expect(code).toContain("on:click");
    expect(code).not.toContain("on:focus");
  });

  test("follow forwarding through the library", async () => {
    const listened = events("<Outer on:click={() => {}} />");
    expect(await forwards(listened, "Outer.svelte")).toContain("<Btn on:click");
    expect(await forwards(listened, "Btn.svelte")).toContain("on:click");
    // Outer's own handler listens to Btn's focus.
    expect(await forwards(listened, "Btn.svelte")).toContain("on:focus");

    const unlistened = events("<Outer />");
    expect(await forwards(unlistened, "Outer.svelte")).not.toContain(
      "on:click",
    );
    expect(await forwards(unlistened, "Btn.svelte")).not.toContain("on:click");
  });

  test("follow forwarding through the app's components", async () => {
    const shape = (markup: string): LibraryApp => ({
      lib: EVENTS_LIBRARY,
      app: {
        ...appRendering(markup, 'import Wrap from "./Wrap.svelte";'),
        "Wrap.svelte": `<script>
  import { Btn } from "mylib";
</script>
<Btn on:click />`,
      },
    });
    expect(
      await forwards(shape("<Wrap on:click={() => {}} />"), "Btn.svelte"),
    ).toContain("on:click");
    expect(await forwards(shape("<Wrap />"), "Btn.svelte")).not.toContain(
      "on:click",
    );
  });

  test.each([
    [
      "`$on` on its instance",
      "<Btn bind:this={b} />",
      'let b;\n$: b?.$on("click", () => {});',
    ],
    ["props it can't read", "<Btn {...props} />", "export let props = {};"],
  ])("stay with %s", async (_, markup, script) => {
    const code = await forwards(events(markup, script), "Btn.svelte");
    expect(code).toContain("on:click");
  });
});

// `dispatch(type, …)` with no listener for `type` only evaluates its
// arguments and returns `true`.

const DISPATCH_LIBRARY = {
  "Picker.svelte": `<script context="module">
  let count = 0;
  function track(value) {
    count++;
    return value;
  }
</script>
<script>
  import { createEventDispatcher } from "svelte";
  export let value = "a";
  const dispatch = createEventDispatcher();
  function pick(next) {
    value = next;
    dispatch("change", { value: next });
    dispatch("select", track(next));
  }
  function relay(dispatch) {
    dispatch("change");
  }
  $: dispatch("update", value);
  $: heard = dispatch("ping", track(value));
</script>
<button on:click={() => pick("b")} on:focus={() => relay(() => {})}>{heard} {count}</button>`,
  "Outer.svelte": `<script>
  import Picker from "./Picker.svelte";
</script>
<Picker on:change />`,
};

const dispatching = (markup: string, script = ""): LibraryApp => ({
  lib: DISPATCH_LIBRARY,
  app: appRendering(markup, script),
});

describe("events dispatched to no listener", () => {
  const picker = async (shape: LibraryApp) =>
    (await specializedLibrary(shape))["Picker.svelte"] ??
    DISPATCH_LIBRARY["Picker.svelte"];

  const RENDERS: Record<string, LibraryApp> = {
    "nothing listening": dispatching("<Picker />"),
    "a listener": dispatching("<Picker on:ping={() => {}} />"),
  };
  const cases = Object.keys(RENDERS).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)(
    "render as the original: %s (unwrap: %p)",
    async (name, unwrap) => {
      const { before, after } = await renderSpecialized(RENDERS[name], {
        unwrap,
      });
      expect(after).toBe(before);
    },
  );

  test("go, keeping what their arguments run", async () => {
    const code = await picker(dispatching("<Picker />"));
    expect(code).not.toContain('dispatch("change", { value: next })');
    expect(code).toContain('void ("select", track(next));');
    expect(code).not.toContain('dispatch("update"');
    // Its result: `true` in the browser, `undefined` on the server.
    expect(code).toContain('$: heard = dispatch("ping", track(value));');
    // A parameter named `dispatch` isn't the dispatcher.
    expect(code).toContain('dispatch("change");');
  });

  test("stay where a site listens", async () => {
    const code = await picker(dispatching("<Picker on:change={() => {}} />"));
    expect(code).toContain('dispatch("change", { value: next })');
    expect(code).not.toContain('dispatch("update"');
  });

  test("follow forwarding through the library", async () => {
    expect(
      await picker(dispatching("<Outer on:change={() => {}} />")),
    ).toContain('dispatch("change", { value: next })');
    expect(await picker(dispatching("<Outer />"))).not.toContain(
      'dispatch("change", { value: next })',
    );
  });

  test("stay with `$on` on its instance", async () => {
    const code = await picker(
      dispatching(
        "<Picker bind:this={p} />",
        'let p;\n$: p?.$on("change", () => {});',
      ),
    );
    expect(code).toContain('dispatch("change", { value: next })');
  });
});

// A rest object no site passes a key to is empty: spreading it on a
// component or into an object adds nothing. On an element it stays, since
// a spread there decides how Svelte renders the element's attributes.

const REST_LIBRARY = {
  "Field.svelte": `<script>
  import Inner from "./Inner.svelte";
  export let label = "l";
  $: attrs = { title: label, ...$$restProps };
</script>
<Inner {...$$restProps} />
<li class:on={false} {...attrs}>{label}</li>`,
  "Inner.svelte": `<script>
  export let kind = "a";
</script>
<span data-keys={Object.keys($$restProps).join()}>{kind}</span>`,
  "Item.svelte": `<script>
  let size = "";
  export function grow() {
    size = "lg";
  }
</script>
<li style="color: red" class={size} {...$$restProps}>x</li>`,
};

const rest = (markup: string): LibraryApp => ({
  lib: REST_LIBRARY,
  app: appRendering(markup),
});

const REST: Record<string, LibraryApp> = {
  "no key passed": rest('<Field /><Field label="m" />'),
  "a key passed at one site": rest('<Field /><Field data-x="1" />'),
  "a key Inner declares": rest('<Field kind="b" />'),
  "on an element": rest("<Item />"),
};

describe("empty rest objects", () => {
  const cases = Object.keys(REST).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(REST[name], { unwrap });
    expect(after).toBe(before);
  });

  test("are no longer spread on components or into objects", async () => {
    const sources = await specializedLibrary(rest("<Field />"));
    expect(sources["Field.svelte"]).not.toContain("$$restProps");
    expect(sources["Field.svelte"]).toContain("{...attrs}");
  });

  test("stay spread on an element", async () => {
    const sources = await specializedLibrary(rest("<Item />"));
    expect(sources["Item.svelte"] ?? "{...$$restProps}").toContain(
      "{...$$restProps}",
    );
  });

  test("keep a spread some site passes a key to", async () => {
    const sources = await specializedLibrary(
      rest('<Field /><Field data-x="1" />'),
    );
    expect(sources["Field.svelte"]).toContain("<Inner {...$$restProps} />");
    expect(sources["Field.svelte"]).toContain("...$$restProps }");
  });
});

// A handler only a removed branch calls goes, and so does the helper it
// creates lazily; a handler the markup still calls stays.
// An action or transition only runs in the browser, so SSR can't show one
// whose function or prop was removed: check the rewrite keeps them.
test("functions and props a directive names are kept", async () => {
  const code = (
    await specializedLibrary({
      lib: {
        "Act.svelte": `<script>
  export let action = (node) => {};
  function reflect(node) {}
  function fade(node) { return {}; }
</script>
<div use:action use:reflect transition:fade />`,
      },
      app: appRendering("<Act />"),
    })
  )["Act.svelte"];
  expect(code ?? "").toContain("action = (node) => {}");
  expect(code ?? "").toContain("function reflect");
  expect(code ?? "").toContain("function fade");
});

describe("functions only a removed branch calls", () => {
  const lib = {
    "handoff.js": "export function createHandoff() { return { enter() {} }; }",
    "Tip.svelte": `<script>
  import { createHandoff } from "./handoff.js";
  export let label = undefined;
  let count = 0;
  let handoff;
  const getHandoff = () => (handoff ??= createHandoff());
  function onEnter() { getHandoff().enter(); }
  function onClick() { count += 1; }
</script>
<button on:click={onClick}>{count}{#if label}<span on:mouseenter={onEnter}>{label}</span>{/if}</button>`,
  };
  const shapes: Record<string, LibraryApp> = {
    "without the branch": { lib, app: appRendering("<Tip />") },
    "with the branch": { lib, app: appRendering('<Tip label="L" />') },
  };
  const cases = Object.keys(shapes).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(shapes[name], {
      unwrap,
    });
    expect(after).toBe(before);
  });

  test("are removed", async () => {
    const code = (await specializedLibrary(shapes["without the branch"]))[
      "Tip.svelte"
    ];
    expect(code).toContain("function onClick()");
    expect(code).not.toContain("onEnter");
    expect(code).not.toContain("createHandoff()");
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
export { Listed } from "./listed.js";
export { Either } from "./either.js";`,
  "parts/index.js": 'export { default as Inner } from "./Inner.svelte";',
  "either.js": `import Outer from "./Outer.svelte";
import Inner from "./parts/Inner.svelte";
export const Either = globalThis.outer ? Outer : Inner;`,
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
    // Each may render `Inner`, which no site names: only `Outer`'s does.
    "an export it can't tell": barrel("<Outer /><Either kind='b' />"),
    "a namespace member it can't tell": barrel(
      "<Outer />{#each ['Inner'] as name}<svelte:component this={L[name]} kind='b' />{/each}",
      'import * as L from "mylib";',
    ),
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

  test.each([
    ["an export it can't tell", "<Outer /><Either kind='b' />", ""],
    [
      "a namespace member it can't tell",
      "<Outer /><svelte:component this={L[name]} kind='b' />",
      'import * as L from "mylib"; let { name = "Inner" } = $props();',
    ],
  ])(
    "%s keeps components no site names unchanged",
    async (_, markup, script) => {
      const sources = await specializedLibrary(barrel(markup, script));
      expect(sources["parts/Inner.svelte"] ?? KIND).toBe(KIND);
    },
  );

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
    ["<EachIcon kinds={['b']} />", "EachIcon.svelte", "const icons = { b: B }"],
  ])("%s keeps only what it selects", async (markup, file, map) => {
    expect(await mapOf(markup, file)).toContain(map);
  });

  test.each([
    ["<Icon kind={k} />", "Icon.svelte"],
    ['<Leaks kind="b" />', "Leaks.svelte"],
  ])("%s keeps every entry", async (markup, file) => {
    const code = await mapOf(markup, file);
    expect(code === "" || code.includes('{ a: A, b: B, "c-c": C }')).toBe(true);
  });
});

// A `{@const}` is read where it's in scope, with the `{#each}` items
// around it: its value folds where it only depends on props, and a child
// given it keeps only those values.

const CONST_LIBRARY = {
  "Row.svelte": `<script>
  export let dense = false;
</script>
{#if dense}<p class="dense">dense</p>{:else}<p class="loose">loose</p>{/if}`,
  "List.svelte": `<script>
  import Row from "./Row.svelte";
  export let size = "md";
  export let items = [];
  export let promise = Promise.resolve(1);
</script>
{#each items as item}
  {@const compact = size === "sm"}
  {@const label = compact ? "s" : item.label}
  {#if compact}<small>{item.label}</small>{:else}<b>{label}</b>{/if}
  <Row dense={compact} />
{/each}
{#if items.length > 0}
  {@const wide = size === "lg"}
  {#if wide}<i>wide</i>{:else}<u>narrow</u>{/if}
{/if}
{#await promise then value}
  {@const big = size !== "sm"}
  {#if big}<em>{value}</em>{:else}<s>{value}</s>{/if}
{/await}`,
  "Mixed.svelte": `<script>
  import Row from "./Row.svelte";
  export let size = "md";
  export let items = [];
</script>
{#each items as item}
  {@const compact = size === "sm"}
  {@const dense = compact || item.dense}
  <Row {dense} />
{/each}`,
  "Destructured.svelte": `<script>
  export let size = "md";
  export let items = [];
</script>
{#each items as { label, tone = "plain", tags: [first] = [] }}
  {@const { compact, sizes: [main, fallback = "md"] } = { compact: size === "sm", sizes: [size] }}
  {@const { kind, ...rest } = { kind: tone, size }}
  {#if compact}<small>{label}</small>{:else}<b>{label}</b>{/if}
  {#if main === "lg"}<i>lg</i>{:else}<u>{main}</u>{/if}
  {#if fallback === "md"}<s>md</s>{:else}<em>other</em>{/if}
  {#if kind === "loud"}<strong>!</strong>{:else}<span>{kind}</span>{/if}
  {#if first === "x"}<mark>x</mark>{:else}<q>{first}</q>{/if}
  {#if rest.size === "sm"}<sub>sm</sub>{:else}<sup>not sm</sup>{/if}
{/each}`,
  "Snippets.svelte": `<script>
  let { size = "md", children } = $props();
</script>
{#snippet row(n)}
  {@const compact = size === "sm"}
  {#if compact}<small>{n}</small>{:else}<b>{n}</b>{/if}
{/snippet}
{@render row(1)}
{#if children}{@render children()}{/if}`,
};

const constTag = (markup: string, script = ""): LibraryApp => ({
  lib: CONST_LIBRARY,
  app: appRendering(markup, script),
});

const CONST_TAGS: Record<string, LibraryApp> = {
  "a size every site passes": constTag(
    '<List size="md" items={[{ label: "a" }, { label: "b" }]} />',
  ),
  "sizes that differ by site": constTag(
    '<List size="sm" items={[{ label: "a" }]} /><List size="lg" items={[{ label: "b" }]} />',
  ),
  "an item the app reads at runtime": constTag(
    '<Mixed size="md" items={data} /><Mixed size="sm" items={data} />',
    'const data = JSON.parse(\'[{"dense": true}, {"dense": false}]\');',
  ),
  "destructured names": constTag(
    '<Destructured size="md" items={[{ label: "a", tags: ["x"] }, { label: "b", tone: "loud" }]} /><Destructured size="sm" items={[{ label: "c" }]} />',
  ),
  "destructured names of app data": constTag(
    '<Destructured size="lg" items={data} />',
    'const data = JSON.parse(\'[{"label": "a", "tone": "loud", "tags": ["x"]}]\');',
  ),
  "a snippet's `{@const}`": constTag('<Snippets size="sm" />'),
  "a `{@const}` in component content": constTag(
    '<Snippets size="md">{@const label = "x"}<i>{label}</i></Snippets>',
  ),
};

describe("values `{@const}` declares", () => {
  const cases = Object.keys(CONST_TAGS).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(CONST_TAGS[name], {
      unwrap,
    });
    expect(after).toBe(before);
  });

  test("fold where they only depend on props", async () => {
    const sources = await specializedLibrary(
      constTag('<List size="md" items={[{ label: "a" }]} />'),
    );
    const list = sources["List.svelte"];
    expect(list).not.toContain("<small>");
    expect(list).not.toContain("<i>wide</i>");
    expect(list).not.toContain("<s>{value}</s>");
    // With `compact` false, `label` is the item's: known here too.
    expect(list).toContain('<b>{"a"}</b>');
    expect(sources["Row.svelte"]).not.toContain("dense</p>");
  });

  test("fold where they're destructured", async () => {
    const sources = await specializedLibrary(
      constTag(
        '<Destructured size="md" items={[{ label: "a", tags: ["y"] }]} />',
      ),
    );
    const code = sources["Destructured.svelte"];
    for (const gone of ["<small>", "<i>lg</i>", "<em>", "<strong>", "<mark>"]) {
      expect(code).not.toContain(gone);
    }
    // A rest element's names stay unknown.
    expect(code).toContain("<sub>sm</sub>");
  });

  test("fold for a child the app imports but never renders", async () => {
    const shape = constTag(
      '<List size="md" items={[{ label: "a" }]} />',
      'import { Row } from "mylib";',
    );
    const { before, after } = await renderSpecialized(shape, { unwrap: true });
    expect(after).toBe(before);
    const sources = await specializedLibrary(shape);
    expect(sources["Row.svelte"]).not.toContain("dense</p>");
  });

  test("fold in a snippet", async () => {
    const sources = await specializedLibrary(
      constTag('<Snippets size="md" />'),
    );
    expect(sources["Snippets.svelte"]).not.toContain("<small>");
  });

  test("stay unknown where they read app data", async () => {
    const sources = await specializedLibrary(
      constTag(
        '<Mixed size="md" items={data} />',
        "const data = JSON.parse('[]');",
      ),
    );
    // Row keeps both branches, unless it isn't rewritten at all.
    const row = sources["Row.svelte"] ?? CONST_LIBRARY["Row.svelte"];
    expect(row).toContain("dense</p>");
    expect(row).toContain("loose</p>");
  });
});

// A snippet parameter is what every call of the snippet passes it, when
// nothing else uses the snippet: not a component it's handed to.

const SNIPPET_LIBRARY = {
  "Row.svelte": `<script>
  let { dense = false } = $props();
</script>
{#if dense}<p class="dense">dense</p>{:else}<p class="loose">loose</p>{/if}`,
  "Cell.svelte": `<script>
  let { item, children } = $props();
</script>
<td>{@render children?.()}{@render item?.("cell")}</td>`,
  "Table.svelte": `<script>
  import Row from "./Row.svelte";
  import Cell from "./Cell.svelte";
  let { size = "md", rows = [] } = $props();
</script>
{#snippet line(s, { label } = {}, mark = "-")}
  {#if s === "sm"}<small>{label}</small>{:else}<b>{label}</b>{/if}
  {#if mark === "-"}<i>-</i>{:else}<u>{mark}</u>{/if}
  <Row dense={s === "sm"} />
{/snippet}
{#snippet item(kind)}{#if kind === "cell"}<em>cell</em>{:else}<s>{kind}</s>{/if}{/snippet}
{@render line(size)}
{#each rows as row}{@render line?.(size, row)}{/each}
<Cell {item} />
<Cell>{#snippet item(kind)}{#if kind === "cell"}<em>inner</em>{:else}<s>inner</s>{/if}{/snippet}</Cell>`,
};

const snippetParams = (markup: string): LibraryApp => ({
  lib: SNIPPET_LIBRARY,
  app: appRendering(markup),
});

const SNIPPET_PARAMS: Record<string, LibraryApp> = {
  "one size": snippetParams(
    '<Table size="md" rows={[{ label: "a" }, { label: "b" }]} />',
  ),
  "sizes that differ by site": snippetParams(
    '<Table size="sm" rows={[{ label: "a" }]} /><Table size="lg" />',
  ),
  "no rows": snippetParams("<Table />"),
};

describe("snippet parameters", () => {
  const cases = Object.keys(SNIPPET_PARAMS).flatMap(
    (name): [string, boolean][] => [
      [name, false],
      [name, true],
    ],
  );
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(SNIPPET_PARAMS[name], {
      unwrap,
    });
    expect(after).toBe(before);
  });

  test("fold to what every call passes", async () => {
    const sources = await specializedLibrary(
      snippetParams('<Table size="md" />'),
    );
    const table = sources["Table.svelte"];
    expect(table).not.toContain("<small>");
    expect(table).not.toContain("<u>{mark}</u>");
    expect(sources["Row.svelte"]).not.toContain('class="dense"');
  });

  test("stay unknown in a snippet a component is given", async () => {
    const table = (
      await specializedLibrary(snippetParams('<Table size="md" />'))
    )["Table.svelte"];
    expect(table).toContain("<s>{kind}</s>");
    expect(table).toContain("<s>inner</s>");
  });
});
// An array a name holds stays known through `x = …`, which rebinds `x`
// and leaves the array alone; a mutation, an alias or a rebind to
// something else still makes it unknown.

const LIST_MARKUP = `{#if xs.length > 0}<p>{xs.length}</p>{:else}<i>empty</i>{/if}{#each xs as x}<b>{x}</b>{/each}`;

const listLegacy = (script: string) => `<script>
  export let mode = "a";
  ${script}
</script>
${LIST_MARKUP}`;

const listRunes = (script: string) => `<script>
  let { mode = "a" } = $props();
  ${script}
</script>
${LIST_MARKUP}`;

const REBINDS: Record<string, string> = {
  "a `$:` ternary": listLegacy('$: xs = mode === "b" ? ["b"] : [];'),
  "a `$:` array, then a guarded `$:` rebind": listLegacy(
    '$: xs = [];\n  $: if (mode === "b") xs = ["b"];',
  ),
  "a `$:` array a `$:` mutates": listLegacy(
    '$: xs = [];\n  $: if (mode === "b") xs.push("b");',
  ),
  "a top-level rebind": listLegacy('let xs = [];\n  xs = ["x"];'),
  "a rebind in a function called at init": listLegacy(
    'let xs = [];\n  function fill() { xs = ["x"]; }\n  fill();',
  ),
  "a rebind in an arrow called at init": listLegacy(
    'let xs = [];\n  const fill = () => (xs = ["x"]);\n  fill();',
  ),
  "a push, then a self-rebind": listLegacy(
    'let xs = [];\n  xs.push("x");\n  xs = xs;',
  ),
  "a rebind to a concat": listLegacy('let xs = [];\n  xs = xs.concat("x");'),
  "an alias rebound, then mutated": listLegacy(
    'let xs = [];\n  let ys;\n  ys = xs;\n  ys.push("x");',
  ),
  "a destructuring rebind": listLegacy('let xs = [];\n  [xs] = [["x"]];'),
  "an object-pattern rebind": listLegacy(
    'let xs = [];\n  ({ xs } = { xs: ["x"] });',
  ),
  "a nullish rebind": listLegacy('let xs;\n  xs ??= ["x"];'),
  "a logical rebind of an empty array": listLegacy(
    'let xs = [];\n  xs ||= ["x"];',
  ),
  "a `$state` rebind": listRunes('let xs = $state([]);\n  xs = ["x"];'),
  "a `$state` push": listRunes('let xs = $state([]);\n  xs.push("x");'),
  "a `$derived` ternary": listRunes(
    'let xs = $derived(mode === "b" ? ["b"] : []);',
  ),
};

describe("arrays through rebinds", () => {
  const cases = Object.keys(REBINDS).flatMap(
    (name): [string, string, boolean][] =>
      ["<List />", '<List /><List mode="b" />'].flatMap(
        (markup): [string, string, boolean][] => [
          [name, markup, false],
          [name, markup, true],
        ],
      ),
  );
  test.each(cases)("%s, %s (unwrap: %p)", async (name, markup, unwrap) => {
    const { before, after } = await renderSpecialized(
      { lib: { "List.svelte": REBINDS[name] }, app: appRendering(markup) },
      { unwrap },
    );
    expect(after).toBe(before);
  });

  test("a `$:` array that stays empty is folded", async () => {
    const sources = await specializedLibrary({
      lib: { "List.svelte": REBINDS["a `$:` ternary"] },
      app: appRendering("<List />"),
    });
    expect(sources["List.svelte"]).not.toContain("<p>");
  });

  test("assigning an `{#each}` item keeps its array unknown", async () => {
    const list = (item: string) => `<script>
  let xs = ["a"];
</script>
{#each xs as x}${item}{/each}{#if xs[0] === "a"}<i>A</i>{:else}<u>U</u>{/if}`;
    const read = await specializedLibrary({
      lib: { "List.svelte": list("<b>{x}</b>") },
      app: appRendering("<List />"),
    });
    expect(read["List.svelte"]).toContain("{#if true}");
    const assigned = await specializedLibrary({
      lib: { "List.svelte": list('<b on:click={() => (x = "")}>{x}</b>') },
      app: appRendering("<List />"),
    });
    expect(assigned["List.svelte"]).toContain('{#if xs[0] === "a"}');
  });
});

// A context object a provider also hands to `getContext(key)?.m(…)` flows
// to its readers when nothing provides `key`; when something does, that
// may change what's in it.

const HANDOFF_LIBRARY = {
  "Group.svelte": `<script>
  import { getContext, setContext } from "svelte";
  import { writable } from "svelte/store";
  export let compact = false;
  const compactStore = writable(compact);
  $: compactStore.set(compact);
  const ctx = { compact: compactStore };
  setContext("group", ctx);
  getContext("outer")?.register(ctx);
</script>
<slot />`,
  "Item.svelte": `<script>
  import { getContext } from "svelte";
  const { compact } = getContext("group");
</script>
{#if $compact}<small>compact</small>{:else}<b>loose</b>{/if}`,
  "Outer.svelte": `<script>
  import { setContext } from "svelte";
  setContext("outer", { register: (group) => group.compact.set(true) });
</script>
<slot />`,
};

const handoff = (markup: string): LibraryApp => ({
  lib: HANDOFF_LIBRARY,
  app: appRendering(markup),
});

const HANDOFFS: Record<string, LibraryApp> = {
  "nothing provides the key": handoff("<Group><Item /></Group>"),
  "a provider above takes the object": handoff(
    "<Outer><Group><Item /></Group></Outer>",
  ),
};

describe("context objects handed to an optional provider", () => {
  const cases = Object.keys(HANDOFFS).flatMap((name): [string, boolean][] => [
    [name, false],
    [name, true],
  ]);
  test.each(cases)("%s (unwrap: %p)", async (name, unwrap) => {
    const { before, after } = await renderSpecialized(HANDOFFS[name], {
      unwrap,
    });
    expect(after).toBe(before);
  });

  test("flow when nothing provides the key", async () => {
    const sources = await specializedLibrary(
      handoff("<Group><Item /></Group>"),
    );
    expect(sources["Item.svelte"]).not.toContain("<small>");
  });

  test("stay unknown when something does", async () => {
    const sources = await specializedLibrary(
      handoff("<Outer><Group><Item /></Group></Outer>"),
    );
    expect(sources["Item.svelte"] ?? HANDOFF_LIBRARY["Item.svelte"]).toContain(
      "<small>",
    );
  });
});
