/**
 * @module core/extensions/registration-values
 *
 * Preserves executable extension registrations while producing deterministic,
 * serializable public inventory snapshots and validates assurance providers.
 */
import {
  KNOWN_EXTENSION_SERVICE_NAMES,
  type AssuranceMeasurementProviderDefinition,
  type ExtensionActivationFailureTrace,
  type ExtensionServiceName,
  type OutputRendererFormat,
} from "./extension-types.js";
import {
  asRegistrationRecord,
  assertOptionalBooleanField,
  assertOptionalStringField,
} from "./registration-validation.js";
import { normalizeCommandName } from "./extension-runtime-helpers.js";

/** Narrow a string to a renderer format accepted by the extension host. */
export function isOutputRendererFormat(
  value: string,
): value is OutputRendererFormat {
  return value === "toon" || value === "json";
}

/** Narrow a string to a service name accepted by the extension host. */
export function isExtensionServiceName(
  value: string,
): value is ExtensionServiceName {
  return KNOWN_EXTENSION_SERVICE_NAMES.includes(value as ExtensionServiceName);
}

/** Require a callable lifecycle hook before registry mutation. */
export function assertHookHandler(hookName: string, hook: unknown): void {
  if (typeof hook !== "function") {
    throw new TypeError(`api.hooks.${hookName} requires a function handler`);
  }
}

const EXTENSION_REGISTRATION_TRACE_SYMBOL = Symbol(
  "extension_registration_trace",
);

type RegistrationTraceCarrier = Error & {
  [EXTENSION_REGISTRATION_TRACE_SYMBOL]?: ExtensionActivationFailureTrace;
};

/** Create a validation error carrying a hidden structured activation trace. */
export function createRegistrationValidationError(
  message: string,
  trace: ExtensionActivationFailureTrace,
): TypeError {
  const error = new TypeError(message) as RegistrationTraceCarrier;
  Object.defineProperty(error, EXTENSION_REGISTRATION_TRACE_SYMBOL, {
    value: trace,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

/** Recover a hidden structured activation trace from a validation error. */
export function extractRegistrationValidationTrace(
  error: unknown,
): ExtensionActivationFailureTrace | undefined {
  return error instanceof Error
    ? (error as RegistrationTraceCarrier)[EXTENSION_REGISTRATION_TRACE_SYMBOL]
    : undefined;
}

/** Recursively project an arbitrary registration value into serializable data. */
export function sanitizeRegistrationValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRegistrationValue(entry));
  }
  if (typeof value === "function") return "[Function]";
  if (typeof value === "bigint" || typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) =>
      left.localeCompare(right),
    )) {
      normalized[key] = sanitizeRegistrationValue(record[key]);
    }
    return normalized;
  }
  return value;
}

/** Recursively clone registration containers while preserving function identities. */
export function cloneRuntimeRegistrationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneRuntimeRegistrationValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) =>
      left.localeCompare(right),
    )) {
      cloned[key] = cloneRuntimeRegistrationValue(record[key]);
    }
    return cloned;
  }
  return value;
}

/** Create a deterministic serializable registration snapshot with functions redacted. */
export function normalizeRegistrationRecord(
  name: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return sanitizeRegistrationValue(value) as Record<string, unknown>;
}

/** Clone a registration record without stripping executable function values. */
export function normalizeRuntimeRegistrationRecord(
  name: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return cloneRuntimeRegistrationValue(value) as Record<string, unknown>;
}

/** Normalize every object in an array into deterministic serializable snapshots. */
export function normalizeRegistrationRecordList<T extends object>(
  name: string,
  value: readonly T[],
): T[];
/** Normalize an untyped array crossing a JavaScript or JSON boundary. */
export function normalizeRegistrationRecordList(
  name: string,
  value: unknown,
): Array<Record<string, unknown>>;
/** Implement the typed and untyped registration-array normalization overloads. */
export function normalizeRegistrationRecordList(
  name: string,
  value: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} requires an array of object definitions`);
  }
  return value.map((entry) => normalizeRegistrationRecord(name, entry));
}

/** Require a trimmed non-empty string at an extension authoring boundary. */
export function assertNonEmptyRegistrationString(
  name: string,
  value: unknown,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} requires a non-empty string`);
  }
  return value.trim();
}

/** Require an executable handler at an extension authoring boundary. */
export function assertRegistrationFunction(name: string, value: unknown): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} requires a function handler`);
  }
}

/** Canonicalize a user-facing registration name for stable routing. */
export function normalizeRegistrationName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

/** Build the canonical command path synthesized for an importer or exporter. */
export function toRegistrationCommandPath(
  name: string,
  action: "import" | "export",
): string {
  return normalizeCommandName(`${name} ${action}`);
}

/** Attach an executable definition as hidden immutable runtime-only state. */
export function attachRuntimeDefinition<
  TEntry extends { definition: Record<string, unknown> },
>(entry: TEntry, runtimeDefinition: Record<string, unknown>): TEntry {
  Object.defineProperty(entry, "runtime_definition", {
    value: runtimeDefinition,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return entry;
}

const ASSURANCE_PROVIDER_COST_CLASSES = new Set(["low", "medium", "high"]);
const ASSURANCE_PROVIDER_VALUE_TYPES = new Set(["number", "string_set"]);
const ASSURANCE_PROVIDER_PARAMETER_TYPES = new Set([
  "string",
  "number",
  "boolean",
]);

function nonEmptyString(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} requires a non-empty string`);
  }
  return value.trim();
}

function validateAssuranceProviderKey(
  providerId: string,
  key: string,
  definition: unknown,
): void {
  const label = `registerAssuranceMeasurementProvider provider.keys.${key}`;
  const record = asRegistrationRecord(label, definition);
  if (!ASSURANCE_PROVIDER_VALUE_TYPES.has(String(record.value_type))) {
    throw new TypeError(`${label}.value_type must be number or string_set`);
  }
  assertOptionalStringField(`${label}.description`, record.description);
  if (record.parameters === undefined) return;
  const parameters = asRegistrationRecord(
    `${label}.parameters`,
    record.parameters,
  );
  for (const [parameter, rawDefinition] of Object.entries(parameters)) {
    const parameterLabel = `${label}.parameters.${parameter}`;
    nonEmptyString(`${parameterLabel}.name`, parameter);
    const parameterDefinition = asRegistrationRecord(
      parameterLabel,
      rawDefinition,
    );
    if (
      !ASSURANCE_PROVIDER_PARAMETER_TYPES.has(String(parameterDefinition.type))
    ) {
      throw new TypeError(
        `${parameterLabel}.type must be string, number, or boolean`,
      );
    }
    assertOptionalBooleanField(
      `${parameterLabel}.required`,
      parameterDefinition.required,
    );
    assertOptionalStringField(
      `${parameterLabel}.description`,
      parameterDefinition.description,
    );
  }
  if (Object.keys(parameters).length > 50) {
    throw new TypeError(
      `assurance provider ${providerId} key ${key} exceeds 50 parameters`,
    );
  }
}

/** Validate the closed provider schema before any activation registry mutation. */
export function validateAssuranceMeasurementProviderDefinition(
  provider: unknown,
): asserts provider is AssuranceMeasurementProviderDefinition {
  const record = asRegistrationRecord(
    "registerAssuranceMeasurementProvider provider",
    provider,
  );
  const id = nonEmptyString(
    "registerAssuranceMeasurementProvider provider.id",
    record.id,
  );
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw new TypeError(
      "registerAssuranceMeasurementProvider provider.id must be a stable lowercase id",
    );
  }
  if (!ASSURANCE_PROVIDER_COST_CLASSES.has(String(record.cost_class))) {
    throw new TypeError(
      "registerAssuranceMeasurementProvider provider.cost_class must be low, medium, or high",
    );
  }
  if (typeof record.network !== "boolean") {
    throw new TypeError(
      "registerAssuranceMeasurementProvider provider.network must be boolean",
    );
  }
  const keys = asRegistrationRecord(
    "registerAssuranceMeasurementProvider provider.keys",
    record.keys,
  );
  if (Object.keys(keys).length === 0) {
    throw new TypeError(
      "registerAssuranceMeasurementProvider provider.keys requires at least one key",
    );
  }
  for (const [key, definition] of Object.entries(keys)) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(key)) {
      throw new TypeError(
        `registerAssuranceMeasurementProvider provider key ${key} must be a stable lowercase id`,
      );
    }
    validateAssuranceProviderKey(id, key, definition);
  }
  if (
    record.timeout_ms !== undefined &&
    (typeof record.timeout_ms !== "number" ||
      !Number.isInteger(record.timeout_ms) ||
      record.timeout_ms < 1 ||
      record.timeout_ms > 300_000)
  ) {
    throw new TypeError(
      "registerAssuranceMeasurementProvider provider.timeout_ms must be an integer from 1 through 300000",
    );
  }
  if (typeof record.resolve !== "function") {
    throw new TypeError(
      "registerAssuranceMeasurementProvider provider.resolve requires a function handler",
    );
  }
}
