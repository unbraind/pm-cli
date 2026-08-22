/**
 * @module sdk/test/trust
 *
 * Provides provenance and clone-local trust decisions for stored linked-test
 * commands. Tracker items remain portable while execution acknowledgements stay
 * outside the merge-unioned project record.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ensureDir,
  isFileMissingError,
  writeFileAtomic,
} from "../../core/fs/fs-utils.js";
import { sha256Hex, stableStringify } from "../../core/shared/serialization.js";
import { isTimestampLiteral } from "../../core/shared/time.js";
import { getRuntimePath } from "../../core/store/paths.js";
import type { LinkedTest } from "../../types/index.js";

const execFileAsync = promisify(execFile);
const LINKED_TEST_TRUST_LEDGER_VERSION = 1;
const LINKED_TEST_TRUST_LEDGER_FILE = "linked-test-trust.json";

interface LinkedTestTrustLedger {
  version: 1;
  acknowledged: Record<string, { acknowledged_at: string }>;
}

/** Classification of one linked-test command against the current clone. */
export interface LinkedTestTrustDecision {
  /** Stable hash binding the decision to command, context, and provenance. */
  fingerprint: string;
  /** Whether execution may proceed without an untrusted-command override. */
  trusted: boolean;
  /** Machine-readable reason for the decision. */
  reason:
    | "legacy"
    | "local_mutation"
    | "local_source_ref"
    | "acknowledged"
    | "invalid_provenance"
    | "foreign_source_ref";
  /** Source ref recorded when the command entered tracker data. */
  source_ref?: string;
  /** Current source ref used for the local decision. */
  current_source_ref?: string;
}

function trustLedgerPath(pmRoot: string): string {
  return path.join(getRuntimePath(pmRoot), LINKED_TEST_TRUST_LEDGER_FILE);
}

function emptyTrustLedger(): LinkedTestTrustLedger {
  return { version: LINKED_TEST_TRUST_LEDGER_VERSION, acknowledged: {} };
}

async function readTrustLedger(pmRoot: string): Promise<LinkedTestTrustLedger> {
  try {
    const parsed = JSON.parse(
      await readFile(trustLedgerPath(pmRoot), "utf8"),
    ) as Partial<LinkedTestTrustLedger>;
    if (
      parsed.version !== LINKED_TEST_TRUST_LEDGER_VERSION ||
      typeof parsed.acknowledged !== "object" ||
      parsed.acknowledged === null ||
      Array.isArray(parsed.acknowledged)
    ) {
      return emptyTrustLedger();
    }
    return {
      version: LINKED_TEST_TRUST_LEDGER_VERSION,
      acknowledged: parsed.acknowledged,
    };
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
      return emptyTrustLedger();
    }
    return emptyTrustLedger();
  }
}

/** Resolve the current Git branch without invoking a shell. */
export async function resolveLinkedTestSourceRef(
  cwd = process.cwd(),
): Promise<string | undefined> {
  const hostedRef =
    process.env.GITHUB_HEAD_REF?.trim() || process.env.GITHUB_REF_NAME?.trim();
  if (hostedRef && hostedRef !== "merge") {
    return hostedRef;
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    const ref = stdout.trim();
    /* c8 ignore start -- successful git symbolic-ref output is non-empty by contract */
    if (ref.length === 0) return undefined;
    /* c8 ignore stop */
    return ref;
  } catch {
    return undefined;
  }
}

/** Resolve the source checkout shared by linked-test provenance and execution. */
export function resolveLinkedTestSourceWorkspaceRoot(
  cwd = process.cwd(),
): string {
  return process.env.PM_SOURCE_WORKSPACE_ROOT?.trim() || cwd;
}

function hasValidLinkedTestProvenance(
  provenance: LinkedTest["provenance"],
): boolean {
  if (provenance === null || typeof provenance !== "object") return false;
  return (
    typeof provenance.author === "string" &&
    provenance.author.trim().length > 0 &&
    typeof provenance.created_at === "string" &&
    isTimestampLiteral(provenance.created_at) &&
    (provenance.source_kind === "local_mutation" ||
      provenance.source_kind === "merge_union")
  );
}

/** Build the optional ref portion shared by clone-local trust decisions. */
function linkedTestTrustRefs(
  sourceRef: string | undefined,
  currentSourceRef: string | undefined,
): Pick<LinkedTestTrustDecision, "source_ref" | "current_source_ref"> {
  return {
    ...(sourceRef ? { source_ref: sourceRef } : {}),
    ...(currentSourceRef ? { current_source_ref: currentSourceRef } : {}),
  };
}

/** Attach immutable author/time/ref provenance to newly stored commands. */
export function attachLinkedTestProvenance(
  tests: LinkedTest[] | undefined,
  author: string,
  createdAt: string,
  sourceRef: string | undefined,
): LinkedTest[] | undefined {
  return tests?.map((test) =>
    test.command && !test.provenance
      ? {
          ...test,
          provenance: {
            author,
            created_at: createdAt,
            source_kind: "local_mutation",
            ...(sourceRef ? { source_ref: sourceRef } : {}),
          },
        }
      : test,
  );
}

/** Attach provenance while avoiding Git inspection for an empty mutation. */
export async function attachLinkedTestMutationProvenance(
  tests: LinkedTest[] | undefined,
  author: string,
  createdAt: string,
): Promise<LinkedTest[] | undefined> {
  if (!tests || tests.length === 0) return tests;
  const sourceWorkspaceRoot = resolveLinkedTestSourceWorkspaceRoot();
  return attachLinkedTestProvenance(
    tests,
    author,
    createdAt,
    await resolveLinkedTestSourceRef(sourceWorkspaceRoot),
  );
}

/** Produce the clone-local trust identity for one linked-test entry. */
export function linkedTestTrustFingerprint(test: LinkedTest): string {
  return sha256Hex(
    stableStringify({
      command: test.command ?? null,
      path: test.path ?? null,
      scope: test.scope,
      pm_context_mode: test.pm_context_mode ?? null,
      workspace_context_mode: test.workspace_context_mode ?? null,
      provenance: test.provenance ?? null,
    }),
  );
}

/** Resolve whether one stored command is trusted by this clone. */
export async function resolveLinkedTestTrust(
  pmRoot: string,
  test: LinkedTest,
  currentSourceRef?: string,
): Promise<LinkedTestTrustDecision> {
  const ledger = await readTrustLedger(pmRoot);
  return resolveLinkedTestTrustFromLedger(test, currentSourceRef, ledger);
}

function resolveLinkedTestTrustFromLedger(
  test: LinkedTest,
  currentSourceRef: string | undefined,
  ledger: LinkedTestTrustLedger,
): LinkedTestTrustDecision {
  const fingerprint = linkedTestTrustFingerprint(test);
  const sourceRef = test.provenance?.source_ref;
  if (test.provenance === undefined) {
    return { fingerprint, trusted: true, reason: "legacy" };
  }
  if (!hasValidLinkedTestProvenance(test.provenance)) {
    return {
      fingerprint,
      trusted: false,
      reason: "invalid_provenance",
      ...linkedTestTrustRefs(undefined, currentSourceRef),
    };
  }
  if (
    test.provenance.source_kind === "local_mutation" &&
    sourceRef === undefined
  ) {
    return {
      fingerprint,
      trusted: true,
      reason: "local_mutation",
      ...linkedTestTrustRefs(undefined, currentSourceRef),
    };
  }
  if (
    test.provenance.source_kind === "local_mutation" &&
    sourceRef !== undefined &&
    sourceRef === currentSourceRef
  ) {
    return {
      fingerprint,
      trusted: true,
      reason: "local_source_ref",
      source_ref: sourceRef,
      current_source_ref: currentSourceRef,
    };
  }
  if (Object.hasOwn(ledger.acknowledged, fingerprint)) {
    return {
      fingerprint,
      trusted: true,
      reason: "acknowledged",
      ...linkedTestTrustRefs(sourceRef, currentSourceRef),
    };
  }
  return {
    fingerprint,
    trusted: false,
    reason: "foreign_source_ref",
    ...linkedTestTrustRefs(sourceRef, currentSourceRef),
  };
}

/** Resolve a collection with one ledger read for validation and batch runs. */
export async function resolveLinkedTestTrustBatch(
  pmRoot: string,
  tests: LinkedTest[],
  currentSourceRef?: string,
): Promise<LinkedTestTrustDecision[]> {
  const ledger = await readTrustLedger(pmRoot);
  return tests.map((test) =>
    resolveLinkedTestTrustFromLedger(test, currentSourceRef, ledger),
  );
}

/** Persist explicit clone-local acknowledgement for selected linked tests. */
export async function acknowledgeLinkedTests(
  pmRoot: string,
  tests: LinkedTest[],
  acknowledgedAt: string,
): Promise<{ acknowledged: number; fingerprints: string[] }> {
  const ledger = await readTrustLedger(pmRoot);
  const fingerprints = tests
    .filter(
      (test) => typeof test.command === "string" && test.command.length > 0,
    )
    .map(linkedTestTrustFingerprint);
  for (const fingerprint of fingerprints) {
    ledger.acknowledged[fingerprint] = { acknowledged_at: acknowledgedAt };
  }
  await ensureDir(path.dirname(trustLedgerPath(pmRoot)));
  await writeFileAtomic(
    trustLedgerPath(pmRoot),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  return { acknowledged: fingerprints.length, fingerprints };
}
