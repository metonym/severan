/**
 * The analysis internals carbon-preprocess-svelte builds on. Unstable:
 * anything here may change in any release. Loads the parser, so import it
 * when a build starts; import its types from here, not `internal.ts`, so
 * they match what its functions take.
 */
export {
  analyzeFiles,
  createUsageCollector,
  type Failure,
  formatPropAwareReport,
  type SpecializedComponents,
  specializeFiles,
  type UsageCollector,
  type UsageResult,
} from "./analysis";
export type { UsageOptions } from "./analyze-usage";
export { collectAppUsage } from "./app-usage";
export { parse } from "./ast";
export { loadComponentModel } from "./component-model";
export { libraryAt } from "./library";
export { specializeComponent } from "./specialize";
