/**
 * @module core/shared/error-details
 *
 * Admits and bounds producer-owned structured diagnostics carried on an
 * expected error (`PmCliErrorContext.details`, GH-1631). The host never
 * interprets these values: it checks that they are plain, well-formed JSON,
 * renders them whole within a declared byte ceiling, and otherwise replaces
 * them with an omission receipt. Telemetry and crash reporting never read
 * them.
 */
import type { PmCliErrorDetails } from "./errors.js";

/** Declared ceilings for producer-owned error diagnostics. */
export const PM_CLI_ERROR_DETAILS_LIMITS = Object.freeze({
  /** Largest compact UTF-8 JSON encoding rendered; larger diagnostics are omitted whole. */
  max_bytes: 4096,
  /** Deepest container nesting accepted below the `details` object itself. */
  max_depth: 8,
});

/** Why a producer's diagnostics could not be rendered. */
export type PmCliErrorDetailsRejection =
  | "not_plain_object"
  | "unsupported_value"
  | "non_finite_number"
  | "malformed_unicode"
  | "reserved_key"
  | "depth_limit"
  | "byte_limit";

/** Receipt that replaces diagnostics the host could not render. */
export interface PmCliErrorDetailsOmission {
  /** Stable reason the diagnostics were withheld. */
  reason: PmCliErrorDetailsRejection;
  /** JSON path of the first offending value, when the shape was refused. */
  path?: string;
  /** Compact UTF-8 JSON size of oversized diagnostics. */
  byte_length?: number;
  /** Byte ceiling that applied. */
  byte_limit: number;
}

/** Outcome of admitting one diagnostics value. */
export type PmCliErrorDetailsAdmission =
  | { ok: true; details: PmCliErrorDetails; byte_length: number }
  | { ok: false; omission: PmCliErrorDetailsOmission };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Keys that rebind prototypes in common consumers are refused, never renamed. */
const RESERVED_KEYS = new Set(["__proto__"]);

class DetailsShapeError extends Error {
  /** Stable shape rejection. */
  readonly reason: Exclude<PmCliErrorDetailsRejection, "byte_limit">;
  /** JSON path of the offending value. */
  readonly path: string;

  constructor(reason: Exclude<PmCliErrorDetailsRejection, "byte_limit">, path: string) {
    super(reason);
    this.reason = reason;
    this.path = path;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Copy one JSON value, refusing anything a JSON round trip would change or drop. */
function copyDetailValue(value: unknown, path: string, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DetailsShapeError("non_finite_number", path);
    return value;
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new DetailsShapeError("malformed_unicode", path);
    return value;
  }
  if (typeof value !== "object") throw new DetailsShapeError("unsupported_value", path);
  if (depth >= PM_CLI_ERROR_DETAILS_LIMITS.max_depth) throw new DetailsShapeError("depth_limit", path);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // A hole reads as undefined and is refused like any other undefined value.
      copy.push(copyDetailValue(value[index], `${path}[${index}]`, depth + 1));
    }
    return copy;
  }
  if (!isPlainObject(value)) throw new DetailsShapeError("unsupported_value", path);
  return copyDetailObject(value, path, depth + 1);
}

function copyDetailObject(value: Record<string, unknown>, path: string, depth: number): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const keyPath = childPath(path, key);
    if (RESERVED_KEYS.has(key)) throw new DetailsShapeError("reserved_key", keyPath);
    if (LONE_SURROGATE.test(key)) throw new DetailsShapeError("malformed_unicode", keyPath);
    copy[key] = copyDetailValue(value[key], keyPath, depth);
  }
  return copy;
}

/**
 * Admit a diagnostics value: a plain object whose leaves are null, booleans,
 * finite numbers and well-formed strings, nested at most
 * {@link PM_CLI_ERROR_DETAILS_LIMITS}.max_depth containers deep. Returns a
 * detached copy so later mutation of the producer's object cannot change a
 * refusal that was already raised.
 */
export function admitPmCliErrorDetails(value: unknown): PmCliErrorDetailsAdmission {
  const byteLimit = PM_CLI_ERROR_DETAILS_LIMITS.max_bytes;
  if (!isPlainObject(value)) {
    return { ok: false, omission: { reason: "not_plain_object", path: "details", byte_limit: byteLimit } };
  }
  let details: PmCliErrorDetails;
  try {
    details = copyDetailObject(value, "details", 0) as PmCliErrorDetails;
  } catch (error) {
    // Only shape refusals are expected; accessor faults stay visible as faults.
    if (!(error instanceof DetailsShapeError)) throw error;
    return { ok: false, omission: { reason: error.reason, path: error.path, byte_limit: byteLimit } };
  }
  return { ok: true, details, byte_length: Buffer.byteLength(JSON.stringify(details), "utf8") };
}

/** Check the diagnostics shape without applying the rendering byte ceiling. */
export function isPmCliErrorDetails(value: unknown): value is PmCliErrorDetails {
  try {
    return admitPmCliErrorDetails(value).ok;
  } catch {
    return false;
  }
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
  let admission: PmCliErrorDetailsAdmission;
  try {
    admission = admitPmCliErrorDetails(value);
  } catch {
    return { details_omitted: { reason: "unsupported_value", path: "details", byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes } };
  }
  if (!admission.ok) return { details_omitted: admission.omission };
  if (admission.byte_length > PM_CLI_ERROR_DETAILS_LIMITS.max_bytes) {
    return {
      details_omitted: {
        reason: "byte_limit",
        byte_length: admission.byte_length,
        byte_limit: PM_CLI_ERROR_DETAILS_LIMITS.max_bytes,
      },
    };
  }
  return { details: admission.details };
}

/**
 * Bound an error context for a transport that forwards the context as-is
 * (MCP): diagnostics are rendered through {@link projectPmCliErrorDetails},
 * every other host field is left untouched.
 */
export function projectPmCliErrorContextDetails(context: unknown): unknown {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return context;
  if (!Object.hasOwn(context, "details")) return context;
  const { details, ...rest } = context as Record<string, unknown>;
  return { ...rest, ...projectPmCliErrorDetails(details) };
}

/** Remove producer diagnostics from a context bound for telemetry or crash reporting. */
export function omitPmCliErrorDetails(context: unknown): unknown {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return context;
  if (!Object.hasOwn(context, "details")) return context;
  const { details: _details, ...rest } = context as Record<string, unknown>;
  return rest;
}
