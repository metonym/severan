import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import path from "node:path";

const JS_OR_SVELTE = /\.(js|svelte)$/;

export async function listJsAndSvelteFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries
    .filter((entry) => JS_OR_SVELTE.test(entry))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort((a, b) => a.localeCompare(b));
}

const nodeRequire = createRequire(import.meta.url);

type PnpApi = {
  resolveToUnqualified(request: string, issuer: string): string | null;
};

function resolveWithPnp(name: string, from: string): string | undefined {
  const { findPnpApi } = Module as {
    findPnpApi?: (lookupSource: string) => PnpApi | null;
  };
  if (typeof findPnpApi !== "function") return undefined;

  // A trailing separator makes the issuer the directory itself.
  const issuer = `${path.resolve(from)}${path.sep}`;
  try {
    const dir = findPnpApi(issuer)?.resolveToUnqualified(name, issuer);
    return dir ? path.resolve(dir) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Searches from `from`, then from this package (hoisted in a monorepo). Walks
 * `require.resolve.paths`: an `exports` map may block `<name>/package.json`.
 */
function resolvePackageDir(
  name: string,
  from: string = process.cwd(),
): string | undefined {
  const pnp = resolveWithPnp(name, from);
  if (pnp) return pnp;

  // `createRequire` wants a module filename; it need not exist on disk.
  const projectRequire = createRequire(path.join(from, "__resolve__.js"));
  const searchPaths = new Set([
    ...(projectRequire.resolve.paths(name) ?? []),
    ...(nodeRequire.resolve.paths(name) ?? []),
  ]);

  for (const base of searchPaths) {
    const candidate = path.join(base, name);
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return undefined;
}

export function requirePackageDir(name: string, from?: string): string {
  const dir = resolvePackageDir(name, from);
  if (!dir) {
    throw new Error(`Could not resolve an installed "${name}" package.`);
  }
  return dir;
}

export function installedMajor(
  name: string,
  from: string = process.cwd(),
): number | undefined {
  const dir = resolvePackageDir(name, from);
  if (!dir) return undefined;
  const major = Number.parseInt(String(readVersion(dir)), 10);
  return Number.isNaN(major) ? undefined : major;
}

function readVersion(root: string): unknown {
  try {
    const manifest: { version?: unknown } = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    return manifest.version;
  } catch {
    return undefined;
  }
}

/** A linked checkout (`bun link`, `workspace:`) changes under a fixed version. */
const isLinked = (real: string) =>
  !real.split(path.sep).includes("node_modules");

export function isLinkedCheckout(root: string): boolean {
  try {
    return isLinked(realpathSync(root));
  } catch {
    return false;
  }
}

/** Cache key for a package's contents: real path and version, plus `srcDir` mtimes when linked. */
export async function packageSignature(
  root: string,
  srcDir: string,
): Promise<string> {
  const version = readVersion(root);
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return "";
  }
  let signature = `${real}@${String(version)}`;
  if (version !== undefined && !isLinked(real)) return signature;
  // Linked or unversioned: only its sources tell it apart.
  const src = path.join(root, srcDir);
  try {
    for (const file of await listJsAndSvelteFiles(src)) {
      signature += `:${statSync(path.join(src, file)).mtimeMs}`;
    }
  } catch {
    // No `src`: indexing it fails, and says so.
  }
  return signature;
}
