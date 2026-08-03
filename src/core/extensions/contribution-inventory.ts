/**
 * @module core/extensions/contribution-inventory
 *
 * Validates and canonicalizes the serializable extension surface inventory.
 */
import { normalizeCommandName } from "./extension-runtime-helpers.js";
import type { ExtensionContributionInventory } from "./extension-types.js";

const COMMAND_PATH_FIELDS = new Set([
  "commands",
  "command_overrides",
  "command_handlers",
  "flag_commands",
  "parser_overrides",
]);

const STRING_LIST_FIELDS = [
  "commands",
  "command_overrides",
  "command_handlers",
  "hooks",
  "flag_commands",
  "item_types",
  "item_fields",
  "relationship_kinds",
  "migrations",
  "profiles",
  "importers",
  "exporters",
  "search_providers",
  "vector_store_adapters",
  "parser_overrides",
  "service_overrides",
  "renderer_overrides",
] as const satisfies ReadonlyArray<keyof ExtensionContributionInventory>;

/** Canonicalize every optional string-list surface into an inventory. */
function applyContributionStringLists(
  record: Record<string, unknown>,
  inventory: ExtensionContributionInventory,
): boolean {
  for (const field of STRING_LIST_FIELDS) {
    const raw = record[field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      return false;
    }
    const values = raw
      .map((entry) =>
        COMMAND_PATH_FIELDS.has(field)
          ? normalizeCommandName(entry as string)
          : (entry as string).trim(),
      )
      .filter((entry) => entry.length > 0);
    inventory[field] = [...new Set(values)].sort((left, right) =>
      left.localeCompare(right),
    );
  }
  return true;
}

/** Validate renderer routing metadata without importing its implementation. */
function normalizeRendererOwnership(
  value: unknown,
): ExtensionContributionInventory["renderer_ownership"] | null {
  if (!Array.isArray(value)) return null;
  const ownership: NonNullable<
    ExtensionContributionInventory["renderer_ownership"]
  > = [];
  for (const rawEntry of value) {
    if (typeof rawEntry !== "object" || rawEntry === null) return null;
    const entry = rawEntry as Record<string, unknown>;
    if (
      (entry.format !== "json" && entry.format !== "toon") ||
      !Array.isArray(entry.commands) ||
      entry.commands.some((command) => typeof command !== "string") ||
      typeof entry.result_discriminator !== "boolean"
    ) {
      return null;
    }
    ownership.push({
      format: entry.format,
      commands: [
        ...new Set(
          entry.commands.map((command) =>
            normalizeCommandName(command as string),
          ),
        ),
      ].sort((left, right) => left.localeCompare(right)),
      result_discriminator: entry.result_discriminator,
    });
  }
  return ownership.sort((left, right) =>
    left.format.localeCompare(right.format),
  );
}

/** Normalize an optional contribution inventory, returning null for malformed data. */
export function normalizeExtensionContributionInventory(
  value: unknown,
): ExtensionContributionInventory | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) return null;
  const inventory: ExtensionContributionInventory = { schema_version: 1 };
  if (!applyContributionStringLists(record, inventory)) return null;
  const preflightCount = record.preflight_overrides;
  if (
    preflightCount !== undefined &&
    (!Number.isInteger(preflightCount) || (preflightCount as number) < 0)
  ) {
    return null;
  }
  if (typeof preflightCount === "number") {
    inventory.preflight_overrides = preflightCount;
  }
  const rawRendererOwnership = record.renderer_ownership;
  if (rawRendererOwnership !== undefined) {
    const ownership = normalizeRendererOwnership(rawRendererOwnership);
    if (ownership === null) return null;
    inventory.renderer_ownership = ownership;
  }
  return inventory;
}

/** Project an activation summary into the versioned static inventory contract. */
export function createExtensionContributionInventory(summary: {
  commands: string[];
  command_overrides: string[];
  command_handlers: string[];
  hooks: string[];
  flag_commands: string[];
  item_types: string[];
  item_fields: string[];
  relationship_kinds?: string[];
  migrations: string[];
  profiles: string[];
  importers: string[];
  exporters: string[];
  search_providers: string[];
  vector_store_adapters: string[];
  parser_overrides: string[];
  service_overrides: string[];
  renderer_overrides: string[];
  renderer_ownership?: ExtensionContributionInventory["renderer_ownership"];
  preflight_overrides: number;
}): ExtensionContributionInventory {
  return {
    schema_version: 1,
    commands: summary.commands,
    command_overrides: summary.command_overrides,
    command_handlers: summary.command_handlers,
    hooks: summary.hooks,
    flag_commands: summary.flag_commands,
    item_types: summary.item_types,
    item_fields: summary.item_fields,
    ...(summary.relationship_kinds
      ? { relationship_kinds: summary.relationship_kinds }
      : {}),
    migrations: summary.migrations,
    profiles: summary.profiles,
    importers: summary.importers,
    exporters: summary.exporters,
    search_providers: summary.search_providers,
    vector_store_adapters: summary.vector_store_adapters,
    parser_overrides: summary.parser_overrides,
    service_overrides: summary.service_overrides,
    renderer_overrides: summary.renderer_overrides,
    ...(summary.renderer_ownership
      ? { renderer_ownership: summary.renderer_ownership }
      : {}),
    preflight_overrides: summary.preflight_overrides,
  };
}
