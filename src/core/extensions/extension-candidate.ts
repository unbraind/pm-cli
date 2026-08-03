/**
 * @module core/extensions/extension-candidate
 *
 * Projects static scan evidence into an import-ready extension candidate.
 */
import type {
  ExtensionCandidate,
  ExtensionContributionInventory,
  ExtensionLayer,
  ExtensionManifest,
} from "./extension-types.js";

/** Managed package identity attached to a discovered extension directory. */
export interface ExtensionCandidateSourceIdentity {
  /** Registry package name when known. */
  package_name?: string;
  /** Install-source aliases accepted by lifecycle commands. */
  aliases: string[];
  /** Persisted install-time contribution snapshot. */
  contributions?: ExtensionContributionInventory;
}

/** Build an import-ready discovery candidate only after every static gate passes. */
export function buildReadyExtensionCandidate(params: {
  layer: ExtensionLayer;
  directory: string;
  manifestPath: string;
  entryPath: string;
  manifest: ExtensionManifest;
  sourceIdentity: ExtensionCandidateSourceIdentity | undefined;
  extensionReady: boolean;
  enabledForLoad: boolean;
}): ExtensionCandidate | null {
  if (!params.extensionReady || !params.enabledForLoad) return null;
  return {
    layer: params.layer,
    directory: params.directory,
    manifest_path: params.manifestPath,
    entry_path: params.entryPath,
    manifest: params.manifest,
    source_package: params.sourceIdentity?.package_name,
    source_aliases: params.sourceIdentity?.aliases,
    contributions: params.sourceIdentity?.contributions,
  };
}
