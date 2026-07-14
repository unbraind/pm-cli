/**
 * @module sdk/runtime-input
 *
 * Normalizes untyped action payload values at the SDK runtime boundary. These
 * primitives are shared by native action dispatchers and MCP-specific adapters.
 */
import { PmCliError } from "../core/shared/errors.js";

/** Read a non-empty string without altering its caller-provided whitespace. */
export function readRuntimeString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Normalize a non-empty string or finite number into a scalar string. */
export function readRuntimeScalarString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

/** Normalize a string, including blank text, or a finite number into text. */
export function readRuntimeScalarStringAllowBlank(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

/** Narrow unknown values to plain record-shaped action payloads. */
export function isRuntimeRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse an integer-valued MCP option while retaining a caller-specific label. */
export function parseRuntimeInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return parsed;
  }
  return undefined;
}
