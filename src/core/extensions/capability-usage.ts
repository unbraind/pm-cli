/**
 * @module core/extensions/capability-usage
 *
 * Reconciles the capabilities an extension manifest *declares* against the
 * capabilities it actually *exercises* during activation.
 *
 * The loader already enforces the opposite direction — registering a surface
 * whose capability is absent from `manifest.capabilities` throws an
 * `extension_capability_missing` activation failure. This module closes the
 * least-privilege loop by detecting capabilities a manifest declares but never
 * registers against, so package authors can trim manifests to the minimum
 * grant. Every declared-but-unused capability is an over-broad permission a
 * reviewer would otherwise have to catch by hand.
 */
import type {
  ExtensionActivationResult,
  ExtensionCapability,
  ExtensionLayer,
} from "./extension-types.js";
import { normalizeKnownExtensionCapability } from "./extension-capability-aliases.js";

/**
 * Canonical map from each known extension capability to the human-readable
 * registration surfaces that exercise it.
 *
 * The `satisfies Record<ExtensionCapability, ...>` guard makes this exhaustive
 * at compile time: adding a capability to `KNOWN_EXTENSION_CAPABILITIES`
 * without giving it a registration surface here fails the build, which prevents
 * a capability that has *no* surface from being perpetually flagged as unused.
 */
export const EXTENSION_CAPABILITY_REGISTRATION_SURFACES = {
  commands: ["registerCommand", "command override", "command handler"],
  renderers: ["registerRenderer"],
  hooks: [
    "hooks.beforeCommand",
    "hooks.afterCommand",
    "hooks.onWrite",
    "hooks.onRead",
    "hooks.onIndex",
  ],
  schema: [
    "registerFlags",
    "registerItemFields",
    "registerItemTypes",
    "registerMigration",
    "registerProfile",
  ],
  importers: ["registerImporter", "registerExporter"],
  search: ["registerSearchProvider", "registerVectorStoreAdapter"],
  parser: ["registerParser"],
  preflight: ["registerPreflight"],
  services: ["registerService"],
} as const satisfies Record<ExtensionCapability, readonly string[]>;

/** Per-extension reconciliation of declared versus exercised capabilities. */
export interface ExtensionCapabilityUsageReconciliation {
  /** Layer the extension was loaded from (`global` or `project`). */
  layer: ExtensionLayer;
  /** Extension name as it appears in the manifest. */
  name: string;
  /** Known capabilities declared in the manifest, sorted and de-duplicated. */
  declared: ExtensionCapability[];
  /** Known capabilities the extension actually registered against, sorted. */
  used: ExtensionCapability[];
  /** Declared capabilities with no matching registration (least-privilege gap). */
  unused: ExtensionCapability[];
}

/** Options for {@link collectUsedExtensionCapabilities}. */
export interface CollectUsedExtensionCapabilitiesOptions {
  /** Restrict the result to a single extension by name. Names are matched case-insensitively after trimming. Omit to union across every extension in the activation result. */
  extensionName?: string;
  /** Restrict the result to a set of extension names. This preserves the single-name option while allowing package aliases that activate multiple extensions to summarize their combined capability surface. */
  extensionNames?: readonly string[];
}

// `layer` is a closed enum (`"global" | "project"`) that never contains a
// colon, so the first colon always separates the layer from the (possibly
// colon-bearing) name — making the key collision-proof without serialization.
const USAGE_KEY_SEPARATOR = ":";

function usageKey(layer: ExtensionLayer, name: string): string {
  return `${layer}${USAGE_KEY_SEPARATOR}${normalizeExtensionName(name)}`;
}

function usageKeyName(key: string): string {
  return key.slice(key.indexOf(USAGE_KEY_SEPARATOR) + 1);
}

/**
 * Canonical extension-name normalization (trim + lowercase) used to match an
 * `extensionName` filter against a registration's stored `name`.
 *
 * Activation stores `extension.name` verbatim — the synthetic test-activation
 * path (`activateExtensionForTest`) never trims it — so any helper that filters
 * by extension name must normalize both sides with this function to stay
 * consistent, including {@link ../extensions/activation-summary.js#describeExtensionActivation}.
 */
export function normalizeExtensionName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeDeclaredCapabilities(
  capabilities: readonly string[] | undefined,
): ExtensionCapability[] {
  if (!Array.isArray(capabilities)) {
    return [];
  }
  const known = new Set<ExtensionCapability>();
  for (const capability of capabilities) {
    // Unknown capabilities are reported by the separate unknown-capability
    // diagnostic; reconciling them here would double-report a typo as "unused".
    const normalized = normalizeKnownExtensionCapability(capability);
    if (normalized !== null) {
      known.add(normalized);
    }
  }
  return [...known].sort((left, right) => left.localeCompare(right));
}

function attributeCapabilityUsage(
  activation: ExtensionActivationResult,
): Map<string, Set<ExtensionCapability>> {
  const usage = new Map<string, Set<ExtensionCapability>>();
  const record = (
    entries: ReadonlyArray<{ layer: ExtensionLayer; name: string }>,
    capability: ExtensionCapability,
  ): void => {
    for (const entry of entries) {
      const key = usageKey(entry.layer, entry.name);
      let exercised = usage.get(key);
      if (exercised === undefined) {
        exercised = new Set<ExtensionCapability>();
        usage.set(key, exercised);
      }
      exercised.add(capability);
    }
  };
  const {
    registrations,
    commands,
    parsers,
    preflight,
    services,
    renderers,
    hooks,
  } = activation;
  record(registrations.commands, "commands");
  record(commands.overrides, "commands");
  record(commands.handlers, "commands");
  record(registrations.flags, "schema");
  record(registrations.item_fields, "schema");
  record(registrations.item_types, "schema");
  record(registrations.migrations, "schema");
  record(registrations.profiles, "schema");
  record(registrations.importers, "importers");
  record(registrations.exporters, "importers");
  record(registrations.search_providers, "search");
  record(registrations.vector_store_adapters, "search");
  record(parsers.overrides, "parser");
  record(preflight.overrides, "preflight");
  record(services.overrides, "services");
  record(renderers.overrides, "renderers");
  record(hooks.beforeCommand, "hooks");
  record(hooks.afterCommand, "hooks");
  record(hooks.onWrite, "hooks");
  record(hooks.onRead, "hooks");
  record(hooks.onIndex, "hooks");
  return usage;
}

/**
 * Collect the known capabilities exercised across an activation result.
 *
 * Without {@link CollectUsedExtensionCapabilitiesOptions.extensionName} the
 * result unions every extension in the activation; with it, only the matching
 * extension's registrations contribute (across both layers).
 */
export function collectUsedExtensionCapabilities(
  activation: ExtensionActivationResult,
  options: CollectUsedExtensionCapabilitiesOptions = {},
): ExtensionCapability[] {
  const usage = attributeCapabilityUsage(activation);
  const filters = new Set<string>();
  if (options.extensionName !== undefined) {
    filters.add(normalizeExtensionName(options.extensionName));
  }
  for (const name of options.extensionNames ?? []) {
    filters.add(normalizeExtensionName(name));
  }
  const used = new Set<ExtensionCapability>();
  for (const [key, capabilities] of usage) {
    if (filters.size > 0 && !filters.has(usageKeyName(key))) {
      continue;
    }
    for (const capability of capabilities) {
      used.add(capability);
    }
  }
  return [...used].sort((left, right) => left.localeCompare(right));
}

/**
 * Reconcile each loaded extension's declared capabilities against what it
 * exercised during activation.
 *
 * Extensions with no known declared capabilities are skipped — there is nothing
 * to reconcile. The returned entries preserve every reconcilable extension even
 * when `unused` is empty so callers can report fully-minimal manifests too.
 */
export function reconcileExtensionCapabilityUsage(
  loaded: ReadonlyArray<{
    layer: ExtensionLayer;
    name: string;
    capabilities?: readonly string[];
  }>,
  activation: ExtensionActivationResult,
): ExtensionCapabilityUsageReconciliation[] {
  const usage = attributeCapabilityUsage(activation);
  const reconciliations: ExtensionCapabilityUsageReconciliation[] = [];
  for (const extension of loaded) {
    const declared = normalizeDeclaredCapabilities(extension.capabilities);
    if (declared.length === 0) {
      continue;
    }
    const exercised =
      usage.get(usageKey(extension.layer, extension.name)) ??
      new Set<ExtensionCapability>();
    const used = [...exercised].sort((left, right) =>
      left.localeCompare(right),
    );
    const unused = declared.filter((capability) => !exercised.has(capability));
    reconciliations.push({
      layer: extension.layer,
      name: extension.name,
      declared,
      used,
      unused,
    });
  }
  return reconciliations;
}
