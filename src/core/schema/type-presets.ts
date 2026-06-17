import { normalizeAddTypeInput, type NormalizedAddTypeInput, type RawAddTypeInput } from "./item-types-file.js";

/**
 * Shared domain item-type presets. These power both `pm init --type-preset`
 * (registered during initialization) and the standalone `pm schema apply-preset`
 * subcommand (adopting a preset into an already-initialized project). Keeping the
 * raw definitions and the preset-name normalizer in one place guarantees init and
 * schema register byte-identical types.
 */

export const TYPE_PRESET_NAMES = ["agile", "ops", "research"] as const;
export type TypePresetName = (typeof TYPE_PRESET_NAMES)[number];

/**
 * Raw (pre-normalization) preset definitions keyed by preset name. Each entry is
 * fed through {@link normalizeAddTypeInput} before being upserted so the same
 * validation/normalization the `pm schema add-type` CLI applies governs preset
 * registration too.
 */
export const TYPE_PRESET_DEFINITIONS: Record<TypePresetName, RawAddTypeInput[]> = {
  agile: [
    {
      name: "Story",
      description: "User-facing outcome or capability slice expressed from a stakeholder perspective.",
      defaultStatus: "open",
      folder: "stories",
      aliases: ["user-story"],
    },
    {
      name: "Spike",
      description: "Time-boxed investigation used to reduce uncertainty before implementation.",
      defaultStatus: "open",
      folder: "spikes",
      aliases: ["research-spike"],
    },
  ],
  ops: [
    {
      name: "Incident",
      description: "Operational disruption, degradation, or support escalation with recovery tracking.",
      defaultStatus: "open",
      folder: "incidents",
      aliases: ["outage"],
    },
    {
      name: "Runbook",
      description: "Repeatable operational procedure, diagnostic path, or response playbook.",
      defaultStatus: "open",
      folder: "runbooks",
      aliases: ["playbook"],
    },
  ],
  research: [
    {
      name: "Experiment",
      description: "Validated-learning activity with hypothesis, method, and outcome tracking.",
      defaultStatus: "open",
      folder: "experiments",
      aliases: ["study"],
    },
    {
      name: "Hypothesis",
      description: "Testable claim or assumption that should be supported, rejected, or refined.",
      defaultStatus: "open",
      folder: "hypotheses",
      aliases: ["assumption"],
    },
  ],
};

/**
 * Validates and normalizes a raw preset-name CLI value. Returns `undefined` when
 * the value is omitted (no preset requested). Throws a plain Error with a stable
 * message for an empty or unknown preset; CLI layers map it to a USAGE exit code.
 * Accepts hyphen/underscore-insensitive casing for ergonomics.
 */
export function normalizeTypePresetName(rawValue: string | undefined): TypePresetName | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const normalized = rawValue.trim().toLowerCase().replaceAll("-", "_");
  if (normalized.length === 0) {
    throw new Error("Type preset name must not be empty.");
  }
  if (normalized === "agile" || normalized === "ops" || normalized === "research") {
    return normalized;
  }
  throw new Error(`Invalid type preset "${rawValue}". Allowed: ${TYPE_PRESET_NAMES.join(", ")}.`);
}

/**
 * Returns the normalized add-type inputs for a preset, in the order they should
 * be upserted. Each raw definition is run through normalizeAddTypeInput so callers
 * get the same validated shape as an individual `add-type` invocation.
 */
export function resolveTypePresetDefinitions(preset: TypePresetName): NormalizedAddTypeInput[] {
  return TYPE_PRESET_DEFINITIONS[preset].map((rawDefinition) => normalizeAddTypeInput(rawDefinition));
}
