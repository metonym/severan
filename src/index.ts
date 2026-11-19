/**
 * Reads how an app renders a Svelte component library's components, and
 * rewrites each one (and the app's own components whose every call site
 * it sees) for the props it's given. The bundler plugins are in
 * `svelte-prune/vite` and `svelte-prune/webpack`.
 */
export {
  type Failure,
  type SpecializedComponents,
  specializeFiles,
} from "./analysis";
export type { LibrarySpec } from "./library-paths";
export type { SveltePruneOptions } from "./optimizer";
