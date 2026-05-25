import type {
  ExtensionHookRegistry,
  ExtensionCommandRegistry,
  ExtensionParserRegistry,
  ExtensionPreflightRegistry,
  ExtensionServiceRegistry,
  ExtensionRendererRegistry,
  ExtensionRegistrationRegistry,
} from "./extension-types.js";

export function createEmptyExtensionHookRegistry(): ExtensionHookRegistry {
  return {
    beforeCommand: [],
    afterCommand: [],
    onWrite: [],
    onRead: [],
    onIndex: [],
  };
}

export function createEmptyExtensionCommandRegistry(): ExtensionCommandRegistry {
  return {
    overrides: [],
    handlers: [],
  };
}

export function createEmptyExtensionParserRegistry(): ExtensionParserRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionPreflightRegistry(): ExtensionPreflightRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionServiceRegistry(): ExtensionServiceRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionRendererRegistry(): ExtensionRendererRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionRegistrationRegistry(): ExtensionRegistrationRegistry {
  return {
    commands: [],
    flags: [],
    item_fields: [],
    item_types: [],
    migrations: [],
    importers: [],
    exporters: [],
    search_providers: [],
    vector_store_adapters: [],
  };
}
