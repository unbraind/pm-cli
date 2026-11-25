/**
 * @module sdk/extension/npm-spec
 *
 * Whether an npm install source names a registry package or a local artifact
 * (a path or a `file:` spec). Upgrades reinstall a local artifact as it is, so a
 * registry release is never an update for it (pm-gh1778).
 */
import path from "node:path";
import type { ManagedExtensionSource } from "./managed-state.js";

/** Whether a raw npm spec names a local path or `file:` artifact rather than a registry package. */
export function isLocalNpmSpec(spec: string): boolean {
  return path.isAbsolute(spec) || spec.startsWith(".") || spec.startsWith("file:");
}

/** Whether a managed source installs from the npm registry, so a newer registry release can replace it. */
export function isRegistryNpmSource(source: ManagedExtensionSource): boolean {
  if (source.kind !== "npm") return false;
  const spec = source.input.startsWith("npm:") ? source.input.slice("npm:".length).trim() : source.input.trim();
  return !isLocalNpmSpec(spec);
}
