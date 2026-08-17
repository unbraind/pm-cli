/**
 * @module sdk/host-environment-errors
 *
 * Classifies host filesystem/resource failures at SDK boundaries without
 * leaking local paths or swallowing genuine implementation defects.
 */
import { constants as osConstants } from "node:os";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

const HOST_ENVIRONMENT_FAULTS: ReadonlyMap<
  string,
  {
    summary: string;
    recovery: string;
    category: "capacity" | "permission" | "resource";
  }
> = new Map([
  [
    "EACCES",
    {
      summary: "was denied filesystem permission",
      recovery: "Grant the required filesystem access, then retry.",
      category: "permission",
    },
  ],
  [
    "EDQUOT",
    {
      summary: "exceeded the filesystem quota",
      recovery: "Raise or reclaim the filesystem quota, then retry.",
      category: "capacity",
    },
  ],
  [
    "EMFILE",
    {
      summary: "exhausted the process file-descriptor limit",
      recovery:
        "Close unused file handles or raise the process limit, then retry.",
      category: "resource",
    },
  ],
  [
    "ENFILE",
    {
      summary: "exhausted the host file-descriptor limit",
      recovery:
        "Free host file descriptors or raise the host limit, then retry.",
      category: "resource",
    },
  ],
  [
    "ENOMEM",
    {
      summary: "ran out of available memory",
      recovery: "Free memory or reduce concurrent work, then retry.",
      category: "resource",
    },
  ],
  [
    "ENOSPC",
    {
      summary: "ran out of storage space",
      recovery:
        "Free storage on the filesystem holding the project, then retry.",
      category: "capacity",
    },
  ],
  [
    "EPERM",
    {
      summary: "was denied by the host permission policy",
      recovery: "Grant the required filesystem permission, then retry.",
      category: "permission",
    },
  ],
  [
    "EROFS",
    {
      summary: "targeted a read-only filesystem",
      recovery:
        "Use a writable project filesystem or remount it read-write, then retry.",
      category: "permission",
    },
  ],
]);
const OPERATION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const HOST_ENVIRONMENT_ERRNO_NAMES: ReadonlyMap<number, string> = new Map([
  [osConstants.errno.EACCES, "EACCES"],
  [osConstants.errno.EDQUOT, "EDQUOT"],
  [osConstants.errno.EMFILE, "EMFILE"],
  [osConstants.errno.ENFILE, "ENFILE"],
  [osConstants.errno.ENOMEM, "ENOMEM"],
  [osConstants.errno.ENOSPC, "ENOSPC"],
  [osConstants.errno.EPERM, "EPERM"],
  [osConstants.errno.EROFS, "EROFS"],
]);
const HOST_ENVIRONMENT_FAULT_CODES = {
  capacity: { code: "host_environment_capacity_fault" },
  permission: { code: "host_environment_permission_fault" },
  resource: { code: "host_environment_resource_fault" },
} as const;

/** Optional stable codes used by an existing SDK surface for each fault class. */
export interface HostEnvironmentFaultCodeOverrides {
  /** Code used for quota and storage exhaustion. */
  capacity?: string;
  /** Code used for access policy and read-only filesystems. */
  permission?: string;
  /** Code used for file-descriptor and memory exhaustion. */
  resource?: string;
}

/** Context and compatibility controls for a host-environment boundary. */
export interface HostEnvironmentBoundaryOptions {
  /** Existing surface-specific codes that must remain compatible. */
  codes?: HostEnvironmentFaultCodeOverrides;
  /** Human explanation of why the operation needs host resources. */
  why?: string;
  /** Additional ordered recovery guidance. */
  nextSteps?: readonly string[];
  /** Copyable retry command when one is safe. */
  suggestedRetry?: string;
}

/** Return a declared host errno only when it represents recoverable environment state. */
export function classifyHostEnvironmentFault(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const errorRecord = error as { code?: unknown; errno?: unknown };
  if (
    typeof errorRecord.code === "string" &&
    HOST_ENVIRONMENT_FAULTS.has(errorRecord.code)
  ) {
    return errorRecord.code;
  }
  if (
    typeof errorRecord.errno !== "number" ||
    !Number.isInteger(errorRecord.errno)
  ) {
    return null;
  }
  return HOST_ENVIRONMENT_ERRNO_NAMES.get(Math.abs(errorRecord.errno)) ?? null;
}

/** Translate one known host fault into a stable path-redacted SDK refusal. */
export function translateHostEnvironmentFault(
  error: unknown,
  operation: string,
  options: HostEnvironmentBoundaryOptions = {},
): PmCliError | null {
  const errno = classifyHostEnvironmentFault(error);
  if (errno === null) return null;
  if (!OPERATION_PATTERN.test(operation)) {
    throw new PmCliError(
      "Host environment operation labels must be bounded identifiers.",
      EXIT_CODE.USAGE,
      { code: "host_environment_operation_invalid", field: "operation" },
    );
  }
  const fault = HOST_ENVIRONMENT_FAULTS.get(errno)!;
  return new PmCliError(
    `Host filesystem operation ${operation} ${fault.summary}.`,
    EXIT_CODE.GENERIC_FAILURE,
    {
      code:
        options.codes?.[fault.category] ??
        HOST_ENVIRONMENT_FAULT_CODES[fault.category].code,
      reason: errno,
      required: fault.recovery,
      why:
        options.why ??
        "The operating system refused a required project filesystem operation.",
      nextSteps: [fault.recovery, ...(options.nextSteps ?? [])],
      ...(options.suggestedRetry
        ? { recovery: { suggested_retry: options.suggestedRetry } }
        : {}),
    },
  );
}

/** Run one SDK filesystem stage and translate only declared host faults. */
export async function withHostEnvironmentBoundary<T>(
  operation: string,
  run: () => Promise<T>,
  options: HostEnvironmentBoundaryOptions = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateHostEnvironmentFault(error, operation, options) ?? error;
  }
}
