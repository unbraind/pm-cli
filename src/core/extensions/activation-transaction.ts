/**
 * @module core/extensions/activation-transaction
 *
 * Captures and restores extension registries around one activation attempt.
 */
import type {
  ExtensionCommandRegistry,
  ExtensionHookRegistry,
  ExtensionParserRegistry,
  ExtensionPreflightRegistry,
  ExtensionRegistrationRegistry,
  ExtensionRendererRegistry,
  ExtensionServiceRegistry,
} from "./extension-types.js";

interface MutableExtensionActivationState {
  hooks: ExtensionHookRegistry;
  commands: ExtensionCommandRegistry;
  parsers: ExtensionParserRegistry;
  preflight: ExtensionPreflightRegistry;
  services: ExtensionServiceRegistry;
  renderers: ExtensionRendererRegistry;
  registrations: ExtensionRegistrationRegistry;
}

/**
 * Return a rollback operation that restores every mutable registry to its
 * current length, making one extension activation atomic without cloning
 * handlers or user values.
 */
export function captureExtensionActivationRollback(
  state: MutableExtensionActivationState,
): () => void {
  const lengths = {
    beforeCommand: state.hooks.beforeCommand.length,
    afterCommand: state.hooks.afterCommand.length,
    onWrite: state.hooks.onWrite.length,
    onRead: state.hooks.onRead.length,
    onIndex: state.hooks.onIndex.length,
    commandOverrides: state.commands.overrides.length,
    commandHandlers: state.commands.handlers.length,
    parserOverrides: state.parsers.overrides.length,
    preflightOverrides: state.preflight.overrides.length,
    serviceOverrides: state.services.overrides.length,
    rendererOverrides: state.renderers.overrides.length,
    registrations: Object.fromEntries(
      Object.entries(state.registrations).map(([key, value]) => [
        key,
        value.length,
      ]),
    ) as Record<keyof ExtensionRegistrationRegistry, number>,
  };
  return () => {
    state.hooks.beforeCommand.length = lengths.beforeCommand;
    state.hooks.afterCommand.length = lengths.afterCommand;
    state.hooks.onWrite.length = lengths.onWrite;
    state.hooks.onRead.length = lengths.onRead;
    state.hooks.onIndex.length = lengths.onIndex;
    state.commands.overrides.length = lengths.commandOverrides;
    state.commands.handlers.length = lengths.commandHandlers;
    state.parsers.overrides.length = lengths.parserOverrides;
    state.preflight.overrides.length = lengths.preflightOverrides;
    state.services.overrides.length = lengths.serviceOverrides;
    state.renderers.overrides.length = lengths.rendererOverrides;
    for (const [key, length] of Object.entries(lengths.registrations)) {
      state.registrations[key as keyof ExtensionRegistrationRegistry].length =
        length;
    }
  };
}
