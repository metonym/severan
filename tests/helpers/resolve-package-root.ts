import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Directory of the installed package `packageName`. */
export function resolvePackageRoot(packageName: string): string {
  for (const base of require.resolve.paths(packageName) ?? []) {
    const candidate = path.join(base, packageName);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`Could not resolve installed package "${packageName}".`);
}
