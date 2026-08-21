/**
 * @module sdk/extension/output-ownership
 *
 * Classifies output overrides against manifest-declared command ownership.
 */
import { normalizeExtensionNameForMatch } from "./shared.js";

interface OutputActivationSummary {
  services: {
    overrides: Array<{
      service: string;
      layer: string;
      name: string;
      passThrough?: boolean;
    }>;
  };
  renderers: {
    overrides: Array<{
      format: string;
      layer: string;
      name: string;
      commands?: string[];
      resultDiscriminator?: (result: unknown) => boolean;
    }>;
  };
}

interface OutputLoadSummary {
  loaded: Array<{
    layer: string;
    name: string;
    activation?: { commands?: string[] };
  }>;
}

/** Collect doctor warnings for output overrides without an explicit command or result ownership boundary. */
export function collectGlobalOutputOverrideDoctorWarnings(
  activationResult: OutputActivationSummary,
  loadResult?: OutputLoadSummary,
): string[] {
  const commandScopedOwners = new Set((loadResult?.loaded ?? []).flatMap(
    (entry) => (entry.activation?.commands?.length ?? 0) > 0
      ? [`${entry.layer}:${normalizeExtensionNameForMatch(entry.name)}`]
      : [],
  ));
  const serviceWarnings = activationResult.services.overrides
    .filter((entry) => entry.service === "output_format")
    .filter((entry) => entry.passThrough !== true)
    .filter((entry) => !commandScopedOwners.has(
      `${entry.layer}:${normalizeExtensionNameForMatch(entry.name)}`,
    ))
    .map((entry) =>
      `extension_output_service_override_global:${entry.service}:${entry.layer}:${entry.name}`
    );
  const rendererWarnings = activationResult.renderers.overrides
    .filter((entry) =>
      (entry.commands?.length ?? 0) === 0 &&
      entry.resultDiscriminator === undefined
    )
    .map((entry) =>
      `extension_output_renderer_override_global:${entry.format}:${entry.layer}:${entry.name}`
    );
  return [...new Set([...serviceWarnings, ...rendererWarnings])].sort(
    (left, right) => left.localeCompare(right),
  );
}
