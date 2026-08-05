/**
 * @module core/extensions/preflight-ownership
 *
 * Normalizes preflight ownership and diagnoses competing registrations.
 */
import { normalizeCommandName } from "./extension-runtime-helpers.js";
import type {
  ExtensionPreflightRegistry,
  PreflightOverride,
  RegisteredExtensionPreflightOverride,
  ScopedPreflightOverrideDefinition,
} from "./extension-types.js";

/** Normalize one callback or scoped definition into a registered handler payload. */
export function normalizePreflightOverride(
  override: PreflightOverride | ScopedPreflightOverrideDefinition,
): Pick<RegisteredExtensionPreflightOverride, "run" | "commands"> {
  const run = typeof override === "function" ? override : override.run;
  if (typeof run !== "function") {
    throw new TypeError("registerPreflight override requires a function handler");
  }
  const commands = [
    ...new Set(
      (typeof override === "function" ? [] : (override.commands ?? [])).map(
        (command) => {
          if (typeof command !== "string" || command.trim().length === 0) {
            throw new TypeError(
              "registerPreflight ownership.commands must contain non-empty command paths",
            );
          }
          return normalizeCommandName(command);
        },
      ),
    ),
  ];
  return { run, ...(commands.length > 0 ? { commands } : {}) };
}

/** Report pairwise overlap while permitting disjoint scoped ownership. */
export function collectPreflightCollisionWarnings(
  preflight: ExtensionPreflightRegistry,
): string[] {
  const warnings: string[] = [];
  for (
    let winnerIndex = 1;
    winnerIndex < preflight.overrides.length;
    winnerIndex += 1
  ) {
    const winner = preflight.overrides[winnerIndex]!;
    for (const displaced of preflight.overrides.slice(0, winnerIndex)) {
      if (
        winner.commands?.length &&
        displaced.commands?.length &&
        !displaced.commands.some((command) => winner.commands!.includes(command))
      ) {
        continue;
      }
      warnings.push(
        `extension_preflight_override_collision:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
      );
    }
  }
  return warnings;
}
