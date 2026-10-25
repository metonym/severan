# Examples

Apps that use real component libraries, each built with Vite with and
without severan. One page per library, from what a real app renders:

| Example           | Library                       | CSS                                        |
| :---------------- | :---------------------------- | :----------------------------------------- |
| `carbon`          | carbon-components-svelte      | Carbon's stylesheet                        |
| `sveltestrap`     | @sveltestrap/sveltestrap      | Bootstrap                                  |
| `flowbite-svelte` | flowbite-svelte               | Tailwind v4, flowbite's plugin             |
| `svelte-5-ui-lib` | svelte-5-ui-lib               | Tailwind v4, flowbite's plugin             |
| `svelte-ux`       | svelte-ux                     | Tailwind v4, @layerstack/tailwind's plugin |
| `skeleton`        | @skeletonlabs/skeleton-svelte | Tailwind v4, Skeleton's theme              |
| `bits-ui`         | bits-ui                       | none (headless)                            |

```sh
bun install --cwd examples   # once: the libraries live here, not in severan's devDependencies
bun run examples             # fails on any change from each example's snapshot.json
bun run examples --update    # writes them
bun run examples --only flowbite-svelte
```

Each run builds `dist/` and, per example, a client and an SSR build both
ways (in `.out/`), then writes `snapshot.json`: the shipped JS and CSS
(bytes and gzip), what severan rewrote, and the rendered HTML, which must
be the same both ways. With severan, a Tailwind example's `src/app.css` is
swapped for `src/app.severan.css`, whose `@source` points at
`node_modules/.severan`: the one line an app changes. Commit the snapshots
with the change that moved them.
