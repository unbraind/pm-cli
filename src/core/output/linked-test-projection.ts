/**
 * @module core/output/linked-test-projection
 *
 * Shapes linked-test replies (`pm test --run`, `pm test-all`) so a quiet run
 * reports its verdict instead of every row's sandbox context and full process
 * output, while any run that needs diagnosis keeps everything it produced.
 */
import { stripVTControlCharacters } from "node:util";

/** Presentation selectors that restore what a quiet-run projection withholds. */
export interface LinkedTestReplyOptions {
  /** Lean receipts drop passing rows' streams once their context is hoisted. */
  lean: boolean;
  /** `--check-context`: report every row's full execution context. */
  fullContext: boolean;
  /** `--full-output`: report every row's complete captured stdout and stderr. */
  fullOutput: boolean;
}

/** Lines of a quiet row's stream that survive the projection, counted from the end. */
export const QUIET_LINKED_TEST_STREAM_TAIL_LINES = 6;
/** Characters of a quiet row's stream that survive the projection, counted from the end. */
export const QUIET_LINKED_TEST_STREAM_TAIL_CHARS = 480;
/** The selector that restores complete streams, named by the omission receipt. */
export const LINKED_TEST_FULL_OUTPUT_FLAG = "--full-output";

const LINKED_TEST_STREAM_KEYS = ["stdout", "stderr"] as const;
type LinkedTestStreamKey = (typeof LINKED_TEST_STREAM_KEYS)[number];

/** Streams the projection shortened anywhere in one reply. */
type StreamOmissionTally = Set<LinkedTestStreamKey>;

/** A result row whose own sandbox context is present. */
type LinkedTestRowWithContext = Record<string, unknown> & {
  execution_context: Record<string, unknown>;
};

/** Recognize non-null object records, excluding array collections. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project one linked-test reply for the host renderer. `pm test` replies are
 * one run; `pm test-all` replies hold one run per item under `results`, and
 * each item is judged exactly as `pm test` would judge it.
 */
export function projectLinkedTestReply(
  command: string | undefined,
  value: unknown,
  options: LinkedTestReplyOptions,
): unknown {
  if (command === "test") {
    const omitted: StreamOmissionTally = new Set();
    return withStreamOmissionReceipt(projectLinkedTestRun(value, options, omitted), omitted, "run_results");
  }
  if (command === "test-all") return projectLinkedTestBatch(value, options);
  return value;
}

/** Judge every item run of a batch on its own, then hoist one context they all share. */
function projectLinkedTestBatch(value: unknown, options: LinkedTestReplyOptions): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.results) || !value.results.every(isPlainObject)) {
    return value;
  }
  const omitted: StreamOmissionTally = new Set();
  const results = value.results.map((entry) => projectLinkedTestRun(entry, options, omitted) as Record<string, unknown>);
  const shared = resolveSharedExecutionContext(
    results.filter((entry) => Array.isArray(entry.run_results) && entry.run_results.length > 0),
  );
  const projected = {
    ...value,
    ...(shared === undefined ? {} : { execution_context: shared }),
    results:
      shared === undefined
        ? results
        : results.map((entry) => {
            const { execution_context: _hoisted, ...rest } = entry;
            return rest;
          }),
  };
  return withStreamOmissionReceipt(projected, omitted, "results.run_results");
}

/**
 * Hoist an invocation-wide linked-test sandbox context out of repeated result
 * rows. Lean output also removes successful-process streams while retaining
 * failure diagnostics, so agents pay once for context and only for actionable
 * evidence. A quiet success reports only each row's decision fields in every
 * format, because the sandbox paths, counts and fingerprint explain nothing
 * about a run that passed and carry host paths into pasted evidence;
 * `--check-context` asks for the full context explicitly (GH-1702). Rows are
 * reduced before the hoist: each linked command has its own trust fingerprint
 * and sandbox, so full contexts differ between tests while their decision
 * fields usually match. A quiet success also keeps only an escape-free tail of
 * each trusted row's streams, because a passing runner's report grows with its
 * file count and colour codes are noise in every encoding; `--full-output`
 * keeps the complete streams (pm-v1mp64).
 */
function projectLinkedTestRun(
  value: unknown,
  options: LinkedTestReplyOptions,
  omitted: StreamOmissionTally,
): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.run_results)) {
    return value;
  }
  const sourceRows = value.run_results;
  if (!sourceRows.every(isPlainObject)) {
    return value;
  }
  const quiet = isQuietLinkedTestSuccess(value, sourceRows);
  const boundedRows =
    quiet && !options.fullOutput
      ? sourceRows.map((row) => boundQuietRowStreams(row, omitted))
      : sourceRows;
  const reduceContext = quiet && !options.fullContext;
  const rows: Record<string, unknown>[] =
    reduceContext
      ? boundedRows.map((row) => ({
          ...row,
          execution_context: projectLinkedTestDecisionContext(
            row.execution_context as Record<string, unknown>,
          ),
        }))
      : boundedRows;
  const sharedContext = resolveSharedExecutionContext(rows);
  const runResults = rows.map((row) => {
    if (sharedContext === undefined) {
      return row;
    }
    const {
      execution_context: _executionContext,
      stdout,
      stderr,
      ...rest
    } = row;
    if (!options.lean || row.status !== "passed") {
      return { ...rest, stdout, stderr };
    }
    return rest;
  });
  // Lean receipts for a quiet success also omit the all-zero failure categories.
  const { failure_categories: _zeroCategories, ...withoutCategories } = value;
  return {
    ...(options.lean && reduceContext ? withoutCategories : value),
    ...(sharedContext === undefined
      ? {}
      : { execution_context: sharedContext }),
    run_results: runResults,
  };
}

/** The one execution context every entry shares, or undefined when entries differ or lack one. */
function resolveSharedExecutionContext(
  rows: Record<string, unknown>[],
): unknown {
  const contexts = rows
    .map((row) => row.execution_context)
    .filter((context) => context !== undefined);
  if (contexts.length !== rows.length || contexts.length === 0) return undefined;
  const first = JSON.stringify(contexts[0]);
  return contexts.every((context) => JSON.stringify(context) === first)
    ? contexts[0]
    : undefined;
}

/** A passing run whose every row has a mismatch-free context and whose failure categories are all zero. */
function isQuietLinkedTestSuccess(
  value: Record<string, unknown>,
  rows: Record<string, unknown>[],
): rows is LinkedTestRowWithContext[] {
  if (value.ok !== true || rows.length === 0) return false;
  const quietRow = (row: Record<string, unknown>): boolean =>
    row.status === "passed" &&
    isPlainObject(row.execution_context) &&
    row.execution_context.mismatch_detected === false;
  if (!rows.every(quietRow)) return false;
  const categories = value.failure_categories;
  return !(isPlainObject(categories) && Object.values(categories).some((count) => count !== 0));
}

/**
 * The decision fields of a quiet success's context: the sandbox modes, the
 * mismatch and trust booleans and the trust reason that explain what the
 * tests saw. A passing run can still be untrusted under an explicit override,
 * so `trusted: false` is never dropped. The sandbox and source paths, item
 * counts, seeding flags and trust fingerprint are not retained. The hint names
 * the flag without telling the caller to rerun, because a rerun repeats any
 * mutating flags of the original invocation (pm-covpax).
 */
function projectLinkedTestDecisionContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const trust = isPlainObject(context.trust) ? context.trust : {};
  return {
    pm_context_mode: context.pm_context_mode,
    workspace_context_mode: context.workspace_context_mode,
    mismatch_detected: false,
    ...(typeof trust.trusted === "boolean" ? { trusted: trust.trusted } : {}),
    ...(trust.reason === undefined ? {} : { trust_reason: trust.reason }),
    restore_with: "not retained; a run with --check-context reports the full context",
  };
}

/**
 * Keep an escape-free tail of a quiet row's streams. A row that passed only
 * under an explicit untrusted-command override keeps its complete output,
 * because that output is the evidence a reviewer reads before trusting it.
 */
function boundQuietRowStreams(
  row: Record<string, unknown>,
  omitted: StreamOmissionTally,
): Record<string, unknown> {
  const context = row.execution_context;
  if (isPlainObject(context) && isPlainObject(context.trust) && context.trust.trusted === false) {
    return row;
  }
  let projected = row;
  for (const key of LINKED_TEST_STREAM_KEYS) {
    const stream = row[key];
    if (typeof stream !== "string") continue;
    const tail = quietStreamTail(stream);
    if (tail === stream) continue;
    omitted.add(key);
    projected = {
      ...projected,
      [key]: tail,
      [`${key}_omitted_bytes`]: Buffer.byteLength(stream, "utf8") - Buffer.byteLength(tail, "utf8"),
    };
  }
  return projected;
}

/**
 * The last lines of a stream as a terminal would show them: escape sequences
 * removed, each carriage-return overwrite reduced to its final segment, blank
 * lines dropped, at most {@link QUIET_LINKED_TEST_STREAM_TAIL_LINES} lines and
 * {@link QUIET_LINKED_TEST_STREAM_TAIL_CHARS} characters, cut on code points.
 */
export function quietStreamTail(stream: string): string {
  if (stream.trim().length === 0) return stream;
  const lines = stripVTControlCharacters(stream)
    .split("\n")
    // A CRLF line ending is not an overwrite; only a mid-line carriage return is.
    .map((line) => (line.replace(/\r+$/u, "").split("\r").at(-1) as string).trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-QUIET_LINKED_TEST_STREAM_TAIL_LINES);
  const codePoints = Array.from(lines.join("\n"));
  const tail = codePoints.slice(-QUIET_LINKED_TEST_STREAM_TAIL_CHARS).join("");
  return stream.endsWith("\n") && tail.length > 0 ? `${tail}\n` : tail;
}

/** Declare every shortened stream under its row path, keeping omission groups a reply already carries. */
function withStreamOmissionReceipt(
  value: unknown,
  omitted: StreamOmissionTally,
  rowPath: "run_results" | "results.run_results",
): unknown {
  if (omitted.size === 0 || !isPlainObject(value)) return value;
  const receipt = isPlainObject(value.omission_receipt) ? value.omission_receipt : {};
  const previous = Array.isArray(receipt.omitted_field_groups) ? receipt.omitted_field_groups : [];
  const groups = [
    ...previous,
    ...LINKED_TEST_STREAM_KEYS.filter((key) => omitted.has(key)).map((key) => ({
      name: `${rowPath}.${key}`,
      restore_with: LINKED_TEST_FULL_OUTPUT_FLAG,
    })),
  ];
  return {
    ...value,
    omission_receipt: {
      ...receipt,
      has_omissions: true,
      omitted_field_group_count: groups.length,
      omitted_field_groups: groups,
    },
  };
}
