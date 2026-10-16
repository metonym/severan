import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LibrarySpec } from "../../src/library-paths";
import { TAILWIND_VARIANTS } from "../../tests/helpers/tailwind-variants";

/**
 * A library shaped like flowbite-svelte: each component reads its classes
 * from a slot table of 23 colors, 5 sizes, two booleans and compound
 * variants, and the barrel exports every component and table.
 */
export const TABLES: LibrarySpec = {
  name: "tables-bench",
  srcDir: "dist",
  barrel: "index.js",
  componentPackages: [],
  contextKeyPrefix: "tables-bench:",
  label: "TablesBench",
  tool: "severan",
  tailwind: true,
};

export const COMPONENTS = 60;
const COLORS = ["primary", "dark", "alternative", "light", "secondary", "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"];
const SIZES = ["xs", "sm", "md", "lg", "xl"];

function theme(i: number): string {
  const colors = COLORS.map(
    (c) => `      ${c}: { base: "text-white bg-${c}-700 hover:bg-${c}-800 dark:bg-${c}-600 focus-within:ring-${c}-300", icon: "text-${c}-500 dark:text-${c}-400", label: "border-${c}-700 hover:bg-${c}-800 dark:border-${c}-500" },`,
  );
  const sizes = SIZES.map((s, n) => `      ${s}: { base: "px-${n + 2} py-${n + 1} text-${s}", icon: "w-${n + 3} h-${n + 3}" },`);
  const compounds = COLORS.slice(0, 10).map(
    (c) => `    { color: "${c}", pill: true, class: { base: "ring-2 ring-${c}-400" } },`,
  );
  return `import { tv } from "tailwind-variants";
export const c${i} = tv({
  slots: { base: "inline-flex items-center font-medium", icon: "shrink-0", label: "truncate" },
  variants: {
    color: {
${colors.join("\n")}
    },
    size: {
${sizes.join("\n")}
    },
    pill: { true: { base: "rounded-full" }, false: { base: "rounded-lg" } },
    disabled: { true: { base: "cursor-not-allowed opacity-50" } },
  },
  compoundVariants: [
${compounds.join("\n")}
  ],
  defaultVariants: { color: "primary", size: "md" },
});
`;
}

const component = (i: number) => `<script>
  import { c${i} } from "./theme.js";
  let { color, size = "md", pill = false, disabled = false, children } = $props();
  const { base, icon, label } = $derived(c${i}({ color, size, pill, disabled }));
</script>
<button class={base()} {disabled}><i class={icon()}></i><span class={label({ pill })}>{@render children?.()}</span></button>
`;

/** Writes only what changed, so mtimes (and the library's caches) hold across runs. */
function write(file: string, code: string) {
  try {
    if (readFileSync(file, "utf8") === code) return;
  } catch {
    // Not written yet.
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, code);
}

/**
 * A project under `root` with the library, the stand-in `tailwind-variants`,
 * a `tailwindcss` manifest, and `src/App.svelte` rendering half the components.
 */
export function writeTablesProject(root: string): { app: { file: string; code: string } } {
  const lib = path.join(root, "node_modules", TABLES.name);
  write(path.join(lib, "package.json"), JSON.stringify({ name: TABLES.name, version: "1.0.0", type: "module", svelte: "./dist/index.js" }));
  const barrel: string[] = [];
  for (let i = 0; i < COMPONENTS; i++) {
    write(path.join(lib, `dist/c${i}/theme.js`), theme(i));
    write(path.join(lib, `dist/c${i}/C${i}.svelte`), component(i));
    barrel.push(`export { default as C${i} } from "./c${i}/C${i}.svelte";`, `export * from "./c${i}/theme.js";`);
  }
  write(path.join(lib, "dist/index.js"), `${barrel.join("\n")}\n`);
  const variants = path.join(root, "node_modules/tailwind-variants");
  write(path.join(variants, "index.js"), TAILWIND_VARIANTS["index.js"]);
  write(path.join(variants, "package.json"), JSON.stringify({ name: "tailwind-variants", version: "3.0.0", type: "module", main: "index.js" }));
  write(path.join(root, "node_modules/tailwindcss/package.json"), JSON.stringify({ name: "tailwindcss", version: "4.1.0" }));
  const rendered = Array.from({ length: COMPONENTS / 2 }, (_, i) => i * 2);
  const code = `<script>
  import { ${rendered.map((i) => `C${i}`).join(", ")} } from "${TABLES.name}";
</script>
${rendered.map((i) => `<C${i} color="${COLORS[i % COLORS.length]}"${i % 3 === 0 ? " pill" : ""}${i % 4 === 0 ? ' size="lg"' : ""}>Item ${i}</C${i}>`).join("\n")}
`;
  const file = path.join(root, "src/App.svelte");
  write(file, code);
  return { app: { file, code } };
}
