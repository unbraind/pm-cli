import type { GlobalOptions } from "../../core/shared/command-types.js";
import type { LinkedDoc } from "../../types/index.js";
import {
  renameArtifactsResultKey,
  runLinkedArtifacts,
  type LinkedArtifactResult,
  type LinkedPathAuditEntry,
  type LinkedPathValidation,
} from "./linked-artifacts.js";

export interface DocsCommandOptions {
  add?: string[];
  addGlob?: string[];
  remove?: string[];
  migrate?: string[];
  list?: boolean;
  validatePaths?: boolean;
  audit?: boolean;
  author?: string;
  message?: string;
  force?: boolean;
}

export interface DocsResult {
  id: string;
  docs: LinkedDoc[];
  changed: boolean;
  count: number;
  migrations_applied?: number;
  validation?: LinkedPathValidation;
  audit?: LinkedPathAuditEntry[];
}

export async function runDocs(id: string, options: DocsCommandOptions, global: GlobalOptions): Promise<DocsResult> {
  const result: LinkedArtifactResult = await runLinkedArtifacts(id, options, global, {
    metadataKey: "docs",
    op: "docs_add",
    bareNoun: "doc",
    supportsAppendStable: false,
  });
  return renameArtifactsResultKey(result, "docs") as unknown as DocsResult;
}
