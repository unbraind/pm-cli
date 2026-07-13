/**
 * @module sdk/docs
 *
 * Implements the pm docs command surface and its agent-facing runtime behavior.
 */
import type { GlobalOptions } from "../core/shared/command-types.js";
import type { LinkedDoc } from "../types/index.js";
import {
  renameArtifactsResultKey,
  runLinkedArtifacts,
  type LinkedArtifactResult,
  type LinkedPathValidation,
} from "./linked-artifacts.js";

/** Documents the docs command options payload exchanged by command, SDK, and package integrations. */
export interface DocsCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string[];
  /** Value that configures or reports add glob for this contract. */
  addGlob?: string[];
  /** Value that configures or reports remove for this contract. */
  remove?: string[];
  /** Value that configures or reports migrate for this contract. */
  migrate?: string[];
  /** GH-170 (pm-pfnx): standalone note applied to every --add/--add-glob link in this invocation. */
  note?: string;
  /** Value that configures or reports list for this contract. */
  list?: boolean;
  /** Value that configures or reports validate paths for this contract. */
  validatePaths?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the docs result payload exchanged by command, SDK, and package integrations. */
export interface DocsResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports docs for this contract. */
  docs: LinkedDoc[];
  /** Value that configures or reports changed for this contract. */
  changed: boolean;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports migrations applied for this contract. */
  migrations_applied?: number;
  /** Value that configures or reports validation for this contract. */
  validation?: LinkedPathValidation;
}

/** Implements run docs for the public runtime surface of this module. */
export async function runDocs(
  id: string,
  options: DocsCommandOptions,
  global: GlobalOptions,
): Promise<DocsResult> {
  const result: LinkedArtifactResult = await runLinkedArtifacts(
    id,
    options,
    global,
    {
      metadataKey: "docs",
      op: "docs_add",
      bareNoun: "doc",
      supportsAppendStable: false,
    },
  );
  return renameArtifactsResultKey(result, "docs");
}
