/** @module sdk/history/attestation-command
 * Shared transport adapter for detached proof export and read-only verification.
 */
import fs from "node:fs/promises";
import { PmCliError } from "../../core/shared/errors.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { resolveHistoryHashAlgorithm } from "../../core/history/digest.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { exportAttestation, verifyAttestation } from "./attestation.js";
import type { HistoryAttestation, HistoryAttestationVerification } from "./attestation-contract.js";

/** Filesystem transport options; SDK consumers may instead pass bundles directly. */
export interface HistoryAttestCommandOptions {
  /** Read an independently retained JSON proof and compare the current streams. */
  verify?: string;
  /** Create a new proof file exclusively; existing files are never overwritten. */
  output?: string;
  /** Digest used for new bundles, independently from record algorithms. */
  hashAlgorithm?: string;
}

/** Bounded receipt after a complete bundle has been saved separately. */
export interface HistoryAttestationExportReceipt {
  /** File created by this export. */
  output: string;
  /** Digest committing to the entire bundle. */
  workspace_digest: string;
  /** Number of streams represented by the saved proof. */
  streams: number;
}

/** Export a complete proof or verify one; no tracker mutations or extension hooks occur. */
export async function runHistoryAttest(options: HistoryAttestCommandOptions, global: GlobalOptions): Promise<HistoryAttestation | HistoryAttestationVerification | HistoryAttestationExportReceipt> {
  for (const key of ["verify", "output", "hashAlgorithm"] as const) {
    const value = options[key];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new PmCliError(`history attest ${key} requires a nonempty string.`, EXIT_CODE.USAGE);
    }
  }
  if (options.verify !== undefined) {
    if (options.output !== undefined || options.hashAlgorithm !== undefined) throw new PmCliError("history attest --verify cannot be combined with --output or --hash-algorithm", EXIT_CODE.USAGE);
    let proof: unknown;
    try {
      proof = JSON.parse(await fs.readFile(options.verify, "utf8"));
    } catch {
      throw new PmCliError("Cannot read history attestation proof. Provide --verify with a readable JSON proof file.", EXIT_CODE.USAGE);
    }
    return verifyAttestation(proof, { pmRoot: global.path });
  }
  const bundle = await exportAttestation({ pmRoot: global.path, hashAlgorithm: resolveHistoryHashAlgorithm(options.hashAlgorithm) });
  if (options.output === undefined) return bundle;
  try {
    await fs.writeFile(options.output, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new PmCliError("Cannot create history attestation proof. Choose --output with a new filename in a writable directory; existing files are never overwritten.", EXIT_CODE.USAGE);
  }
  return { output: options.output, workspace_digest: bundle.workspace_digest, streams: bundle.streams.length };
}
