/**
 * @module core/shared/error-details
 *
 * Admits and bounds producer-owned structured diagnostics carried on an
 * expected error (`PmCliErrorContext.details`, GH-1631). The host never
 * interprets these values: it checks that they are plain, well-formed JSON,
 * renders them whole within a declared byte ceiling, and otherwise replaces
 * them with an omission receipt. Telemetry and crash reporting never read
 * them.
 *
 * Every traversal reads own data properties only (accessors are refused, never
 * invoked) and counts the compact JSON encoding as it walks, so a shared or
 * deeply repeated structure is abandoned as soon as it crosses the ceiling
 * instead of being expanded first.
 */
import type {
  PmCliErrorDetails,
  PmCliErrorDetailsOmission,
  PmCliErrorDetailsRejection,
} from "./errors.js";

export type { PmCliErrorDetailsOmission, PmCliErrorDetailsRejection } from "./errors.js";

/** Declared ceilings for producer-owned error diagnostics. */
export const PM_CLI_ERROR_DETAILS_LIMITS = Object.freeze({
  /** Largest compact UTF-8 JSON encoding rendered; larger diagnostics are omitted whole. */
  max_bytes: 4096,
  /** Deepest container nesting accepted below the `details` object itself. */
  max_depth: 8,
});

/** Largest UTF-8 size of a producer-derived path echoed in an omission receipt. */
const MAX_OMISSION_PATH_BYTES = 160;

const DETAILS_REJECTIONS: ReadonlySet<string> = new Set<PmCliErrorDetailsRejection>([
  "not_plain_object",
  "unsupported_value",
  "non_finite_number",
  "malformed_unicode",
  "reserved_key",
  "depth_limit",
  "byte_limit",
]);

/** Outcome of admitting one diagnostics value. */
export type PmCliErrorDetailsAdmission =
  | { ok: true; details: PmCliErrorDetails; byte_length: number }
  | { ok: false; omission: PmCliErrorDetailsOmission };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Keys that rebind prototypes in common consumers are refused, never renamed. */
const RESERVED_KEYS = new Set(["__proto__"]);

class DetailsShapeError extends Error {
  /** Stable rejection. */
  readonly reason: PmCliErrorDetailsRejection;
  /** JSON path of the offending value. */
  readonly path: string;

  constructor(reason: PmCliErrorDetailsRejection, path: string) {
    super(reason);
    this.reason = reason;
    this.path = path;
  }
}

/** Running compact-JSON size of the value being copied. */
interface ByteBudget {
  bytes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Keep a producer-derived path within a fixed UTF-8 size without splitting a character. */
function boundPath(path: string): string {
  if (Buffer.byteLength(path, "utf8") <= MAX_OMISSION_PATH_BYTES) return path;
  let bounded = "";
  let bytes = Buffer.byteLength("…", "utf8");
  for (const character of path) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > MAX_OMISSION_PATH_BYTES) break;
    bounded += character;
  }
  return `${bounded}…`;
}

/** Charge encoded bytes, abandoning the walk once the ceiling is crossed. */
function charge(budget: ByteBudget, bytes: number, path: string): void {
  budget.bytes += bytes;
  if (budget.bytes > PM_CLI_ERROR_DETAILS_LIMITS.max_bytes) throw new DetailsShapeError("byte_limit", path);
}

/** Read one own data property; accessors and absent slots are refused without invoking anything. */
function readOwnDataValue(container: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new DetailsShapeError("unsupported_value", path);
  return descriptor.value;
}

function copyDetailLeaf(value: unknown, path: string, budget: ByteBudget): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) throw new DetailsShapeError("non_finite_number", path);
  if (typeof value === "string" && LONE_SURROGATE.test(value)) throw new DetailsShapeError("malformed_unicode", path);
  if (value !== null && !["boolean", "number", "string"].includes(typeof value)) {
    throw new DetailsShapeError("unsupported_value", path);
  }
  charge(budget, Buffer.byteLength(JSON.stringify(value), "utf8"), path);
  return value;
}

/** Copy one JSON value, refusing anything a JSON round trip would change or drop. */
function copyDetailValue(value: unknown, path: string, depth: number, budget: ByteBudget): unknown {
  if (typeof value !== "object" || value === null) return copyDetailLeaf(value, path, budget);
  if (depth >= PM_CLI_ERROR_DETAILS_LIMITS.max_depth) throw new DetailsShapeError("depth_limit", path);
  if (Array.isArray(value)) {
    // Brackets plus separating commas.
    charge(budget, value.length > 0 ? value.length + 1 : 2, path);
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entryPath = `${path}[${index}]`;
      copy.push(copyDetailValue(readOwnDataValue(value, String(index), entryPath), entryPath, depth + 1, budget));
    }
    return copy;
  }
  if (!isPlainObject(value)) throw new DetailsShapeError("unsupported_value", path);
  return copyDetailObject(value, path, depth + 1, budget);
}

function copyDetailObject(value: Record<string, unknown>, path: string, depth: number, budget: ByteBudget): Record<string, unknown> {
  const keys = Object.keys(value);
  // Braces plus separating commas.
  charge(budget, keys.length > 0 ? keys.length + 1 : 2, path);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const keyPath = childPath(path, key);
    if (RESERVED_KEYS.has(key)) throw new DetailsShapeError("reserved_key", keyPath);
    if (LONE_SURROGATE.test(key)) throw new DetailsShapeError("malformed_unicode", keyPath);
    // Quoted key plus its colon.
    charge(budget, Buffer.byteLength(JSON.stringify(key), "utf8") + 1, keyPath);
    copy[key] = copyDetailValue(readOwnDataValue(value, key, keyPath), keyPath, depth, budget);
  }
  return copy;
}

/**
 * Admit a diagnostics value: a plain object whose leaves are null, booleans,
 * finite numbers and well-formed strings, nested at most
 * {@link PM_CLI_ERROR_DETAILS_LIMITS}.max_depth containers deep and encoding
 * to at most `max_bytes` of compact UTF-8 JSON. Returns a detached copy so
 * later mutation of the producer's object cannot change a raised refusal.
 * Accessor properties are refused without being invoked, and the walk stops
 * at the byte ceiling, so admission cost is bounded by the ceiling.
 */
export function admitPmCliErrorDetails(value: unknown): PmCliErrorDetailsAdmission {
  const byteLimit = PM_CLI_ERROR_DETAILS_LIMITS.max_bytes;
  const budget: ByteBudget = { bytes: 0 };
  try {
    // Inside the guard: a proxy's getPrototypeOf trap can throw on the root too.
    if (!isPlainObject(value)) throw new DetailsShapeError("not_plain_object", "details");
    const details = copyDetailObject(value, "details", 0, budget) as PmCliErrorDetails;
    return { ok: true, details, byte_length: budget.bytes };
  } catch (error) {
    // Proxy traps are the only other source of faults; they are refused like any non-plain value.
    const refusal = error instanceof DetailsShapeError ? error : new DetailsShapeError("unsupported_value", "details");
    return {
      ok: false,
      omission: refusal.reason === "byte_limit"
        ? { reason: "byte_limit", byte_limit: byteLimit }
        : { reason: refusal.reason, path: boundPath(refusal.path), byte_limit: byteLimit },
    };
  }
}

/** Check the diagnostics shape and byte ceiling. */
export function isPmCliErrorDetails(value: unknown): value is PmCliErrorDetails {
  return admitPmCliErrorDetails(value).ok;
}

/**
 * Project diagnostics for a structured error envelope: render them whole when
 * they are well-formed and fit the byte ceiling, otherwise return only the
 * omission receipt. Partial structures are never emitted.
 */
export function projectPmCliErrorDetails(
  value: unknown,
): { details: PmCliErrorDetails } | { details_omitted: PmCliErrorDetailsOmission } | undefined {
  if (value === undefined) return undefined;
  const admission = admitPmCliErrorDetails(value);
  return admission.ok ? { details: admission.details } : { details_omitted: admission.omission };
}

/** Receipt for a value the host could not even inspect. */
function unsupportedDetailsReceipt(): PmCliErrorDetailsOmission {
  return { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes };
}

/** Re-validate a host receipt recorded on a context; anything else is not a receipt. */
function readRecordedOmission(value: unknown): PmCliErrorDetailsOmission | undefined {
  if (!isPlainObject(value)) return undefined;
  const reason = value.reason;
  if (typeof reason !== "string" || !DETAILS_REJECTIONS.has(reason)) return undefined;
  const path = typeof value.path === "string" ? boundPath(value.path) : undefined;
  return {
    reason: reason as PmCliErrorDetailsRejection,
    ...(path === undefined ? {} : { path }),
    byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes,
  };
}

/**
 * Plain snapshot of a foreign error context, taken once at a host boundary:
 * own enumerable data properties are copied, accessors are never run, a
 * `details` accessor becomes an `unsupported_value` receipt, and a context the
 * host cannot inspect at all (a hostile proxy) becomes an empty object.
 */
export function snapshotPmCliErrorContext(context: unknown): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  try {
    if (typeof context !== "object" || context === null || Array.isArray(context)) return snapshot;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(context))) {
      if (!descriptor.enumerable) continue;
      if ("value" in descriptor) {
        Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
      } else if (key === "details") {
        snapshot.details_omitted = unsupportedDetailsReceipt();
      }
    }
    return snapshot;
  } catch {
    return {};
  }
}

/**
 * Project the diagnostics of an error context: `details` rendered through
 * {@link projectPmCliErrorDetails}, otherwise a valid host-recorded
 * `details_omitted` receipt. Accessors are reported, never run, and an
 * uninspectable context yields an `unsupported_value` receipt.
 */
export function projectPmCliErrorContextDetailsSlot(
  context: unknown,
): ReturnType<typeof projectPmCliErrorDetails> {
  if (typeof context !== "object" || context === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(context, "details");
    if (descriptor !== undefined && !("value" in descriptor)) return { details_omitted: unsupportedDetailsReceipt() };
    if (descriptor !== undefined && descriptor.value !== undefined) return projectPmCliErrorDetails(descriptor.value);
    const recorded = Object.getOwnPropertyDescriptor(context, "details_omitted");
    const omission = recorded !== undefined && "value" in recorded ? readRecordedOmission(recorded.value) : undefined;
    return omission === undefined ? undefined : { details_omitted: omission };
  } catch {
    return { details_omitted: unsupportedDetailsReceipt() };
  }
}

/** Keys that carry producer diagnostics or a receipt describing them. */
const DIAGNOSTIC_KEYS = new Set(["details", "details_omitted"]);

/** Own enumerable properties other than the diagnostics keys, without touching those slots. */
function contextWithoutDiagnostics(context: object): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(context)) {
    if (!DIAGNOSTIC_KEYS.has(key)) {
      Object.defineProperty(rest, key, { value: (context as Record<string, unknown>)[key], enumerable: true, writable: true, configurable: true });
    }
  }
  return rest;
}

/**
 * Bound an error context for a transport that forwards the context as-is
 * (MCP): diagnostics are rendered through {@link projectPmCliErrorContextDetailsSlot},
 * every other host field is left untouched.
 */
export function projectPmCliErrorContextDetails(context: unknown): unknown {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return context;
  try {
    if (!Object.hasOwn(context, "details") && !Object.hasOwn(context, "details_omitted")) return context;
    return { ...contextWithoutDiagnostics(context), ...projectPmCliErrorContextDetailsSlot(context) };
  } catch {
    return { details_omitted: unsupportedDetailsReceipt() };
  }
}

/**
 * Remove producer diagnostics, and the receipt describing them (its path can
 * echo producer keys), from a context bound for telemetry or crash reporting.
 */
export function omitPmCliErrorDetails(context: unknown): unknown {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return context;
  try {
    if (!Object.hasOwn(context, "details") && !Object.hasOwn(context, "details_omitted")) return context;
    return contextWithoutDiagnostics(context);
  } catch {
    return {};
  }
}

/** Deepest event nesting scanned for embedded error contexts. */
const MAX_EMBEDDED_CONTEXT_DEPTH = 12;

/** Embedded keys that carry a serialized error context. */
const EMBEDDED_CONTEXT_KEYS = new Set(["context", "error_context"]);

/**
 * Remove producer diagnostics from every embedded error context (`*.context`
 * and `*.error_context` objects) inside a serialized crash-report payload, in
 * place. Console captures and breadcrumbs carry an error's own properties at
 * arbitrary positions, so a shallow scrub is not enough.
 */
export function omitEmbeddedPmCliErrorDetails(payload: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): void => {
    if (typeof value !== "object" || value === null || depth > MAX_EMBEDDED_CONTEXT_DEPTH || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const entry: unknown = descriptor.value;
      const scrubbed = EMBEDDED_CONTEXT_KEYS.has(key) ? omitPmCliErrorDetails(entry) : entry;
      if (scrubbed !== entry) record[key] = scrubbed;
      visit(scrubbed, depth + 1);
    }
  };
  visit(payload, 0);
}
