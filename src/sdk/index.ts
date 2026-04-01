import type { ExtensionApi, ExtensionManifest } from "../core/extensions/loader.js";

export const EXTENSION_CAPABILITIES = ["commands", "renderers", "hooks", "schema", "importers", "search"] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

export interface ExtensionModule {
  manifest?: ExtensionManifest;
  activate(api: ExtensionApi): void | Promise<void>;
}

export function defineExtension<TModule extends ExtensionModule>(module: TModule): TModule {
  return module;
}

export type {
  AfterCommandHook,
  AfterCommandHookContext,
  BeforeCommandHook,
  BeforeCommandHookContext,
  CommandDefinition,
  CommandHandler,
  CommandHandlerContext,
  CommandOverride,
  CommandOverrideContext,
  Exporter,
  ExtensionActivationResult,
  ExtensionApi,
  ExtensionCommandRegistry,
  ExtensionDiagnostic,
  ExtensionDiscoveryResult,
  ExtensionLoadResult,
  ExtensionManifest,
  ExtensionRegistrationRegistry,
  ExtensionRendererRegistry,
  FlagDefinition,
  Importer,
  OnIndexHook,
  OnIndexHookContext,
  OnReadHook,
  OnReadHookContext,
  OnWriteHook,
  OnWriteHookContext,
  OutputRendererFormat,
  RendererOverride,
  RendererOverrideContext,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
  SchemaMigrationDefinition,
  SearchProviderDefinition,
  VectorStoreAdapterDefinition,
} from "../core/extensions/loader.js";

export type { GlobalOptions } from "../core/shared/command-types.js";
export type { PmSettings } from "../types/index.js";
