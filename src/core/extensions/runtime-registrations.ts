import type {
  ExtensionRegistrationRegistry,
  RegisteredExtensionSchemaMigrationDefinition,
  RegisteredExtensionSearchProvider,
  RegisteredExtensionVectorStoreAdapter,
} from "./loader.js";

function normalizeRegistrationName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function collectRegisteredItemFields(registrations: ExtensionRegistrationRegistry | null): Array<Record<string, unknown>> {
  if (!registrations) {
    return [];
  }
  const fields: Array<Record<string, unknown>> = [];
  for (const registration of registrations.item_fields) {
    for (const field of registration.fields) {
      fields.push(field);
    }
  }
  return fields;
}

export function resolveRegisteredSearchProvider(
  registrations: ExtensionRegistrationRegistry | null,
  configuredProvider: string | undefined,
): RegisteredExtensionSearchProvider | null {
  const providerName = normalizeRegistrationName(configuredProvider);
  if (!registrations || !providerName) {
    return null;
  }
  const matched = [...registrations.search_providers]
    .reverse()
    .find((registration) => {
      const definitionName =
        normalizeRegistrationName(registration.runtime_definition?.name) ??
        normalizeRegistrationName(registration.definition?.name);
      return definitionName === providerName;
    });
  return matched ?? null;
}

export function resolveRegisteredVectorStoreAdapter(
  registrations: ExtensionRegistrationRegistry | null,
  configuredAdapter: string | undefined,
): RegisteredExtensionVectorStoreAdapter | null {
  const adapterName = normalizeRegistrationName(configuredAdapter);
  if (!registrations || !adapterName) {
    return null;
  }
  const matched = [...registrations.vector_store_adapters]
    .reverse()
    .find((registration) => {
      const definitionName =
        normalizeRegistrationName(registration.runtime_definition?.name) ??
        normalizeRegistrationName(registration.definition?.name);
      return definitionName === adapterName;
    });
  return matched ?? null;
}

export function getMigrationRuntimeDefinition(
  migration: RegisteredExtensionSchemaMigrationDefinition,
): Record<string, unknown> {
  return migration.runtime_definition ?? migration.definition;
}
