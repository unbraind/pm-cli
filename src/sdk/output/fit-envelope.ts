/**
 * @module sdk/output/fit-envelope
 *
 * Fits ordered, indivisible rows using complete caller-rendered envelopes.
 * Domain ranking and transport framing stay with the caller; the SDK owns
 * bounded fixed-point accounting and an immutable omission receipt.
 */
import { estimatePmOutputTokens } from "../cli-contracts/agent-output-contracts.js";

/** Deterministic admission policy; neither policy reorders or splits rows. */
export type OutputEnvelopeFitPolicy = "prefix" | "skip";

/** SDK-owned receipt included in every measured envelope as output_fit. */
export interface OutputEnvelopeFitReceipt {
  /** Receipt schema version. */
  version: 1;
  /** Admission policy applied in caller order. */
  policy: OutputEnvelopeFitPolicy;
  /** Number of rows offered before fitting. */
  total_candidates: number;
  /** Original positions of the retained rows. */
  included_indices: readonly number[];
  /** Number of whole rows withheld by the policy. */
  omitted_count: number;
  /** Binding ceiling in the caller's token estimator units. */
  token_budget: number;
  /** Greatest complete-envelope estimate across all required renderers. */
  estimated_tokens: number;
  /** Greatest UTF-8 byte count across all required renderers. */
  output_bytes: number;
}

/** Envelope with the reserved, SDK-owned accounting and omission receipt. */
export type FittedOutputEnvelope<Envelope> = Omit<Envelope, "output_fit"> & {
  /** Self-accounting receipt, including its own bytes and framing. */
  readonly output_fit: Readonly<OutputEnvelopeFitReceipt>;
};

/** One complete rendering, ready to emit without reserializing or reframing. */
export interface OutputEnvelopeRendering {
  /** Caller-selected transport identity. */
  name: string;
  /** Complete output, including any caller-supplied newline or framing. */
  text: string;
  /** UTF-8 bytes of text, including the receipt. */
  bytes: number;
  /** Estimate of text under the selected estimator. */
  estimated_tokens: number;
}

/** Actual fitting work, kept outside the measured output to avoid self-counting. */
export interface OutputEnvelopeFitWork {
  /** Candidate admission trials performed, excluding the minimum envelope. */
  evaluated_candidates: number;
  /** Renderer calls across all fixed-point passes and admission trials. */
  render_calls: number;
  /** Hard ceiling on renderer calls. */
  max_render_calls: number;
}

/** Explicit failure to produce a verified packet; no oversized output is returned. */
export class OutputEnvelopeFitError extends RangeError {
  /** Stable refusal reason suitable for package-specific error translation. */
  readonly code: "output_envelope_infeasible" | "output_envelope_work_limit" | "output_envelope_unstable";
  /** Work completed before refusal. */
  readonly work: Readonly<OutputEnvelopeFitWork>;
  /** Measured minimum-envelope estimate when the budget is infeasible. */
  readonly minimum_tokens: number | undefined;

  /** Capture immutable refusal evidence without serializing caller data. */
  constructor(code: OutputEnvelopeFitError["code"], work: OutputEnvelopeFitWork, minimumTokens?: number) {
    super(code);
    this.name = "OutputEnvelopeFitError";
    this.code = code;
    this.work = Object.freeze({ ...work });
    this.minimum_tokens = minimumTokens;
  }
}

/** Caller-owned envelope construction, renderers and finite work controls. */
export interface FitOutputEnvelopeOptions<Row, Envelope extends Record<string, unknown>> {
  /** Maximum complete-envelope estimate accepted by every required renderer. */
  tokenBudget: number;
  /** Preserve a prefix by default; skip may retain later smaller rows. */
  policy?: OutputEnvelopeFitPolicy;
  /** Construct mandatory domain metadata; output_fit is reserved and overwritten by the SDK. Must be pure and deterministic. */
  buildEnvelope: (rows: readonly Row[], receipt: Readonly<OutputEnvelopeFitReceipt>) => Envelope;
  /** Nonempty set of pure deterministic renderers, including all output framing. */
  renderers: Readonly<Record<string, (envelope: FittedOutputEnvelope<Envelope>) => string>>;
  /** Estimate the exact rendered text; defaults to ceil(UTF-8 bytes / 4). Stronger estimators may be supplied. */
  estimateTokens?: (text: string) => number;
  /** Hard renderer-call ceiling; defaults to 10,000. */
  maxRenderCalls?: number;
  /** Fixed-point pass ceiling per admission trial; defaults to 16. */
  maxStabilizationPasses?: number;
}

/** Verified envelope and cached renderings; work is diagnostic, not emitted packet data. */
export interface OutputEnvelopeFitResult<Row, Envelope> {
  /** Whole caller rows retained in original order. */
  rows: readonly Row[];
  /** Domain metadata plus the exact measured receipt. */
  envelope: FittedOutputEnvelope<Envelope>;
  /** Cached complete outputs; every rendering satisfies the budget. */
  renderings: readonly OutputEnvelopeRendering[];
  /** True only when all candidates were retained. */
  complete: boolean;
  /** Actual bounded fitting work. */
  work: Readonly<OutputEnvelopeFitWork>;
}

/** Reject invalid ceilings and counts before calling any caller code. */
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/** Measure all required complete renderings while enforcing the shared work ceiling. */
function renderEnvelope<Envelope extends Record<string, unknown>>(
  envelope: FittedOutputEnvelope<Envelope>,
  renderers: [string, (value: FittedOutputEnvelope<Envelope>) => string][],
  estimateTokens: (text: string) => number,
  work: OutputEnvelopeFitWork,
): OutputEnvelopeRendering[] {
  return renderers.map(([name, render]) => {
    if (work.render_calls >= work.max_render_calls) {
      throw new OutputEnvelopeFitError("output_envelope_work_limit", work);
    }
    work.render_calls += 1;
    const text = render(envelope);
    if (typeof text !== "string") throw new TypeError("Envelope renderers must return strings");
    const estimatedTokens = estimateTokens(text);
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
      throw new RangeError("Envelope token estimates must be non-negative safe integers");
    }
    return { name, text, bytes: Buffer.byteLength(text, "utf8"), estimated_tokens: estimatedTokens };
  });
}

/** Find a fixed point for both byte and token counts, refusing cyclic or unbounded accounting. */
function stabilizeEnvelope<Row, Envelope extends Record<string, unknown>>(
  rows: readonly Row[],
  initial: OutputEnvelopeFitReceipt,
  options: FitOutputEnvelopeOptions<Row, Envelope>,
  work: OutputEnvelopeFitWork,
): { envelope: FittedOutputEnvelope<Envelope>; renderings: OutputEnvelopeRendering[] } {
  let receipt = initial;
  const renderers = Object.entries(options.renderers);
  const estimateTokens = options.estimateTokens ?? ((text: string) => estimatePmOutputTokens(Buffer.byteLength(text, "utf8")));
  for (let pass = 0; pass < (options.maxStabilizationPasses ?? 16); pass += 1) {
    const frozenReceipt = Object.freeze({ ...receipt });
    const envelope = { ...options.buildEnvelope(rows, frozenReceipt), output_fit: frozenReceipt };
    const renderings = renderEnvelope(envelope, renderers, estimateTokens, work);
    const bytes = Math.max(...renderings.map((rendering) => rendering.bytes));
    const tokens = Math.max(...renderings.map((rendering) => rendering.estimated_tokens));
    if (bytes === receipt.output_bytes && tokens === receipt.estimated_tokens) return { envelope, renderings };
    receipt = { ...receipt, output_bytes: bytes, estimated_tokens: tokens };
  }
  throw new OutputEnvelopeFitError("output_envelope_unstable", work);
}

/**
 * Fit whole ordered rows against every required complete rendering. First prove
 * the empty mandatory envelope fits, then admit rows under prefix or skip
 * policy. No monotonic-size assumption or binary search is used. Callbacks
 * must be pure and return promptly; call/pass ceilings bound SDK fitting work,
 * not arbitrary callback execution time. Emit the cached renderings directly.
 *
 * @throws {OutputEnvelopeFitError} When the minimum envelope is too large,
 * accounting fails to stabilize, or the renderer-call ceiling is exhausted.
 */
export function fitOutputEnvelope<Row, Envelope extends Record<string, unknown>>(
  candidates: readonly Row[],
  options: FitOutputEnvelopeOptions<Row, Envelope>,
): OutputEnvelopeFitResult<Row, Envelope> {
  assertPositiveInteger(options.tokenBudget, "tokenBudget");
  assertPositiveInteger(options.maxRenderCalls ?? 10_000, "maxRenderCalls");
  assertPositiveInteger(options.maxStabilizationPasses ?? 16, "maxStabilizationPasses");
  const policy = options.policy ?? "prefix";
  if (policy !== "prefix" && policy !== "skip") throw new TypeError("Unknown output envelope fit policy");
  if (Object.entries(options.renderers).length === 0 || Object.entries(options.renderers).some(([name, render]) => !name.trim() || typeof render !== "function")) {
    throw new TypeError("Envelope fitting requires named callable renderers");
  }
  const work: OutputEnvelopeFitWork = { evaluated_candidates: 0, render_calls: 0, max_render_calls: options.maxRenderCalls ?? 10_000 };
  let rows: Row[] = [];
  let included: number[] = [];
  const receiptFor = (indices: readonly number[]): OutputEnvelopeFitReceipt => ({
    version: 1, policy, total_candidates: candidates.length,
    included_indices: Object.freeze([...indices]), omitted_count: candidates.length - indices.length,
    token_budget: options.tokenBudget, estimated_tokens: 0, output_bytes: 0,
  });
  let fitted = stabilizeEnvelope(rows, receiptFor(included), options, work);
  if (fitted.envelope.output_fit.estimated_tokens > options.tokenBudget) {
    throw new OutputEnvelopeFitError("output_envelope_infeasible", work, fitted.envelope.output_fit.estimated_tokens);
  }
  for (const [index, candidate] of candidates.entries()) {
    work.evaluated_candidates += 1;
    const trialRows = [...rows, candidate];
    const trialIndices = [...included, index];
    const trial = stabilizeEnvelope(trialRows, receiptFor(trialIndices), options, work);
    if (trial.envelope.output_fit.estimated_tokens <= options.tokenBudget) {
      rows = trialRows;
      included = trialIndices;
      fitted = trial;
    } else if (policy === "prefix") break;
  }
  return { rows, ...fitted, complete: rows.length === candidates.length, work: Object.freeze({ ...work }) };
}
