import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LibrarySpec } from "../../src/library-paths";

/**
 * A stand-in for the `tailwind-variants` package: `tv()` as its 3.x
 * resolves variants, defaults, compound variants and slots, without merging
 * classes. Installed with `LibraryApp.packages`.
 */
export const TAILWIND_VARIANTS = {
  "index.js": `const fts = (v) => (v === false ? "false" : v === true ? "true" : v === 0 ? "0" : v);
const nullishOrFalse = (v) => v == null || v === false;
const same = (e, a) => e === a || (nullishOrFalse(e) && nullishOrFalse(a));
const join = (...parts) => parts.flat(Infinity).filter(Boolean).join(" ");

export function tv(config) {
  const { base, slots, variants = {}, defaultVariants = {}, compoundVariants = [] } = config;
  const value = (variant, props, slotProps) => {
    const raw = slotProps?.[variant] ?? props?.[variant];
    if (raw === null) return null;
    const key = fts(raw);
    if (typeof key === "object") return null;
    return variants[variant][(key ?? fts(defaultVariants[variant])) || "false"];
  };
  const complete = (props, slotProps) => {
    const all = { ...defaultVariants };
    for (const given of [props, slotProps]) {
      for (const [key, v] of Object.entries(given ?? {})) if (v !== undefined) all[key] = v;
    }
    return all;
  };
  const compounds = (props, slotProps, slot) => {
    const all = complete(props, slotProps);
    return compoundVariants
      .filter((compound) =>
        Object.entries(compound).every(([key, expected]) =>
          key === "class" || key === "className"
            ? true
            : Array.isArray(expected)
              ? expected.some((e) => same(e, all[key]))
              : same(expected, all[key]),
        ),
      )
      .map(({ class: cls, className }) => {
        const classes = cls ?? className;
        return typeof classes === "string" ? (slot === "base" ? classes : null) : classes?.[slot];
      });
  };
  const forSlot = (slot, props, slotProps) =>
    join(
      slot === "base" ? base : null,
      slots?.[slot],
      Object.keys(variants).map((variant) => {
        const v = value(variant, props, slotProps);
        return typeof v === "string" ? (slot === "base" ? v : null) : v?.[slot];
      }),
      compounds(props, slotProps, slot),
      slotProps?.class,
      slotProps?.className,
    );
  if (!slots) return (props) => join(forSlot("base", props), props?.class, props?.className);
  return (props) =>
    Object.fromEntries(
      ["base", ...Object.keys(slots)].map((slot) => [slot, (slotProps) => forSlot(slot, props, slotProps)]),
    );
}
`,
};

/** A library whose `Button` reads its classes from a tailwind-variants table. */
export const TVLIB: LibrarySpec = {
  name: "tvlib",
  srcDir: "src",
  barrel: "index.js",
  componentPackages: [],
  contextKeyPrefix: "tvlib:",
  label: "TvLib",
  tool: "severan",
  tailwind: true,
};

const TVLIB_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "tvlib",
    version: "1.0.0",
    type: "module",
    svelte: "./src/index.js",
    exports: { ".": "./src/index.js", "./*": "./src/*" },
  }),
  "src/index.js": `export { default as Button } from "./Button.svelte";\nexport { default as Badge } from "./Badge.svelte";\nexport * from "./theme.js";\n`,
  "src/Badge.svelte": `<span class="badge-only"></span>`,
  "src/theme.js": `import { tv } from "tailwind-variants";
export const button = tv({ variants: { color: { red: "bg-red", green: "bg-green" } } });
`,
  "src/Button.svelte": `<script>
  import { button } from "./theme.js";
  let { color } = $props();
</script>
<button class={button({ color })}></button>`,
};

/** Installs `tvlib` and the stand-in `tailwind-variants` (and `tailwindcss`, a manifest only) in `root`'s `node_modules`. */
export function installTableLibrary(
  root: string,
  { tailwind = false } = {},
): string {
  const write = (file: string, code: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, code);
  };
  const tvlib = path.join(root, "node_modules", "tvlib");
  for (const [file, code] of Object.entries(TVLIB_FILES)) {
    write(path.join(tvlib, file), code);
  }
  const variants = path.join(root, "node_modules", "tailwind-variants");
  write(path.join(variants, "index.js"), TAILWIND_VARIANTS["index.js"]);
  write(
    path.join(variants, "package.json"),
    JSON.stringify({
      name: "tailwind-variants",
      version: "3.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  if (tailwind) {
    write(
      path.join(root, "node_modules", "tailwindcss", "package.json"),
      JSON.stringify({ name: "tailwindcss", version: "4.1.0" }),
    );
  }
  return tvlib;
}
