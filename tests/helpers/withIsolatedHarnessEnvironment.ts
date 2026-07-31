import { BUILTIN_HARNESS_SIGNAL_DESCRIPTORS } from "../../src/core/shared/author.js";

const HARNESS_ENVIRONMENT_KEYS = [
  "PM_AUTHOR",
  "PM_AGENT_MODEL",
  "PM_AGENT_EFFORT",
  "PM_AGENT_ROLE",
  ...BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.flatMap((descriptor) => [
    ...(descriptor.environment_keys ?? []),
    ...(descriptor.model_environment_keys ?? []),
    ...(descriptor.session_environment_keys ?? []),
    ...Object.values(descriptor.provenance_environment_keys ?? {}).flat(),
  ]),
] as const;

/**
 * Run a test with every built-in harness signal cleared, then restore the
 * caller's environment exactly. The registry-derived key set prevents new
 * harness descriptors from silently invalidating isolation.
 */
export async function withIsolatedHarnessEnvironment<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  run: () => T | Promise<T>,
): Promise<T> {
  const keys = new Set([
    ...HARNESS_ENVIRONMENT_KEYS,
    ...Object.keys(overrides),
  ]);
  const previous = new Map(
    [...keys].map((key) => [key, process.env[key]] as const),
  );
  for (const key of keys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
