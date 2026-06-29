/**
 * @module core/extensions/extension-registries
 *
 * Implements extension runtime contracts and governance for Extension Registries.
 */
import type {
  ExtensionHookRegistry,
  ExtensionCommandRegistry,
  ExtensionParserRegistry,
  ExtensionPreflightRegistry,
  ExtensionServiceRegistry,
  ExtensionRendererRegistry,
  ExtensionRegistrationRegistry,
} from "./extension-types.js";

/**
 * Implements create empty extension hook registry for the public runtime surface of this module.
 */
export function createEmptyExtensionHookRegistry(): ExtensionHookRegistry {
  return {
    beforeCommand: [],
    afterCommand: [],
    onWrite: [],
    onRead: [],
    onIndex: [],
  };
}

/**
 * Implements create empty extension command registry for the public runtime surface of this module.
 */
export function createEmptyExtensionCommandRegistry(): ExtensionCommandRegistry {
  return {
    overrides: [],
    handlers: [],
  };
}

/**
 * Implements create empty extension parser registry for the public runtime surface of this module.
 */
export function createEmptyExtensionParserRegistry(): ExtensionParserRegistry {
  return {
    overrides: [],
  };
}

/**
 * Implements create empty extension preflight registry for the public runtime surface of this module.
 */
export function createEmptyExtensionPreflightRegistry(): ExtensionPreflightRegistry {
  return {
    overrides: [],
  };
}

/**
 * Implements create empty extension service registry for the public runtime surface of this module.
 */
export function createEmptyExtensionServiceRegistry(): ExtensionServiceRegistry {
  return {
    overrides: [],
  };
}

/**
 * Implements create empty extension renderer registry for the public runtime surface of this module.
 */
export function createEmptyExtensionRendererRegistry(): ExtensionRendererRegistry {
  return {
    overrides: [],
  };
}

/**
 * Implements create empty extension registration registry for the public runtime surface of this module.
 */
export function createEmptyExtensionRegistrationRegistry(): ExtensionRegistrationRegistry {
  return {
    commands: [],
    flags: [],
    item_fields: [],
    item_types: [],
    migrations: [],
    profiles: [],
    importers: [],
    exporters: [],
    search_providers: [],
    vector_store_adapters: [],
  };
}
