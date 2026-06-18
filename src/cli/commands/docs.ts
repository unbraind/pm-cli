/**
 * @module cli/commands/docs
 *
 * Implements the pm docs command surface and its agent-facing runtime behavior.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import type { LinkedDoc } from "../../types/index.js";
import {
  renameArtifactsResultKey,
  runLinkedArtifacts,
  type LinkedArtifactResult,
  type LinkedPathAuditEntry,
  type LinkedPathValidation,
} from "./linked-artifacts.js";

/**
 * Documents the docs command options payload exchanged by command, SDK, and package integrations.
 */
export interface DocsCommandOptions {
  add?: string[];
  addGlob?: string[];
  remove?: string[];
  migrate?: string[];
  /** GH-170 (pm-pfnx): standalone note applied to every --add/--add-glob link in this invocation. */
  note?: string;
  list?: boolean;
  validatePaths?: boolean;
  audit?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

/**
 * Documents the docs result payload exchanged by command, SDK, and package integrations.
 */
export interface DocsResult {
  id: string;
  docs: LinkedDoc[];
  changed: boolean;
  count: number;
  migrations_applied?: number;
  validation?: LinkedPathValidation;
  audit?: LinkedPathAuditEntry[];
}

/**
 * Implements run docs for the public runtime surface of this module.
 */
export async function runDocs(id: string, options: DocsCommandOptions, global: GlobalOptions): Promise<DocsResult> {
  const result: LinkedArtifactResult = await runLinkedArtifacts(id, options, global, {
    metadataKey: "docs",
    op: "docs_add",
    bareNoun: "doc",
    supportsAppendStable: false,
  });
  return renameArtifactsResultKey(result, "docs") as unknown as DocsResult;
}
