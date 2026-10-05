/**
 * @module sdk/extension-command-context
 *
 * Builds the host-owned SDK services injected into extension commands so
 * package runtimes never need private imports or runtime package resolution.
 */
import { createHash } from "node:crypto";
import type { PmSettings } from "../types.js";
import type { ExtensionCommandSdk } from "../core/extensions/extension-types.js";
import { runActiveOnWriteHooks } from "../core/extensions/index.js";
import { mutateWorkspaceJsonWithHistory } from "../core/history/workspace-history.js";
import { resolveAuthor } from "../core/shared/author.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { asRecordOrNull } from "../core/shared/primitives.js";
import { stableValueEquals } from "../core/shared/serialization.js";
import { getSettingsPath } from "../core/store/paths.js";
import { mergeSettings, readSettings, runWithConfigurationOnlySettings, serializeSettings } from "../core/store/settings.js";
import { clearSettingsReadCache } from "../core/store/settings-read-cache.js";
import { validateSettings } from "../core/store/settings-validator.js";
import { isPmCliExpectedError } from "./errors.js";
import { getItemAt } from "./history-read.js";
import {
  RelationshipEventLog,
  RelationshipEventStore,
} from "./relationship-history.js";
import { analyzeGraphImpact } from "./relationship-analytics.js";
import {
  RelationshipGraph,
  createRelationshipKindRegistry,
} from "./relationships.js";
import type {
  RelationshipKindDefinition,
  RelationshipKindRegistry,
} from "./relationships.js";
import type { PmClient } from "./runtime.js";
import { commitWorkspaceTransaction } from "./workspace-transaction.js";

/** Build a relationship-kind registry from extension-owned definitions. */
function buildRelationshipKindRegistry(
  definitions: readonly RelationshipKindDefinition[],
): RelationshipKindRegistry {
  const registry = createRelationshipKindRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}

/** Replace explicitly owned normalized objects without dropping unrelated sparse or future settings. */
function replaceOwnedSettingsSubtrees(raw: string, next: PmSettings, paths: readonly string[] = []): string {
  if (paths.length === 0) return raw;
  const persisted = JSON.parse(raw) as Record<string, unknown>;
  const canonical = JSON.parse(serializeSettings(next)) as Record<string, unknown>;
  for (const ownedPath of paths) {
    const segments = ownedPath.split(".");
    let source: unknown = canonical;
    for (const segment of segments) {
      const sourceObject = asRecordOrNull(source);
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(segment) || ["constructor", "prototype", "__proto__"].includes(segment) ||
        sourceObject === null || !Object.hasOwn(sourceObject, segment)) {
        throw new PmCliError(`Invalid owned settings subtree: ${ownedPath}. Select a declared inline object path.`, EXIT_CODE.USAGE);
      }
      source = sourceObject[segment];
    }
    if (asRecordOrNull(source) === null) {
      throw new PmCliError(`Invalid owned settings subtree: ${ownedPath}. Select a declared inline object path.`, EXIT_CODE.USAGE);
    }
    let destination = persisted;
    let canonicalParent = canonical;
    for (const segment of segments.slice(0, -1)) {
      const value = destination[segment];
      canonicalParent = canonicalParent[segment] as Record<string, unknown>;
      if (value === undefined) Object.defineProperty(destination, segment, {
        value: structuredClone(canonicalParent), enumerable: true, writable: true, configurable: true,
      });
      destination = destination[segment] as Record<string, unknown>;
    }
    Object.defineProperty(destination, segments.at(-1)!, {
      value: source, enumerable: true, writable: true, configurable: true,
    });
  }
  return stableValueEquals(persisted, JSON.parse(raw)) ? raw : `${JSON.stringify(persisted, null, 2)}\n`;
}

/** Bind public SDK services to one tracker and one caller-owned client. */
export function createExtensionCommandSdk(
  pmRoot: string,
  client: PmClient,
  invocationAuthor?: string,
  invocationCommand?: string,
): ExtensionCommandSdk {
  return {
    client,
    isItemNotFoundError: (error) =>
      isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND,
    getItemAt: (id, target) => getItemAt(id, target, { pmRoot }),
    openRelationshipEventStore: (options) => {
      return RelationshipEventStore.open({
        pmRoot,
        nodes: options.nodes,
        registry: buildRelationshipKindRegistry(options.definitions),
        ...(options.relativePath === undefined
          ? {}
          : { relativePath: options.relativePath }),
      });
    },
    createRelationshipGraph: (options) =>
      new RelationshipGraph(
        options.nodes,
        options.edges,
        buildRelationshipKindRegistry(options.definitions),
      ),
    analyzeRelationshipImpact: (graph, root, options) =>
      analyzeGraphImpact(graph, root, options),
    validateRelationshipEvents: (options) => {
      const log = new RelationshipEventLog(options.nodes, {
        registry: buildRelationshipKindRegistry(options.definitions),
      });
      return options.events.map((event) =>
        log.append({ ...event, expectedVersion: log.version }),
      );
    },
    commitWorkspaceTransaction: (options) =>
      commitWorkspaceTransaction({ ...options, pmRoot }),
    /** Normalize one locked proposal, preserve sparse source fields, and return an opt-in inline preview. */
    mutateWorkspaceSettings: async (options) => {
      if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(options.operationId)) {
        throw new PmCliError(
          "Workspace settings operationId must be 1-128 letters, digits, dots, underscores, or hyphens.",
          EXIT_CODE.USAGE,
        );
      }
      const settings = options.dryRun === true
        ? await runWithConfigurationOnlySettings(pmRoot,
          /** Read inline configuration under the dry-run policy without schema hydration or read hooks. */
          () => readSettings(pmRoot))
        : await readSettings(pmRoot);
      try {
        const mutation = await mutateWorkspaceJsonWithHistory({
          pmRoot,
          filePath: getSettingsPath(pmRoot),
          op: "extension:pm:settings",
          idempotencyKey: invocationCommand === undefined
            ? options.operationId
            : `${createHash("sha256").update(invocationCommand).digest("hex").slice(0, 16)}:${options.operationId}`,
          author: invocationAuthor ?? resolveAuthor(undefined, settings.author_default),
          lockTtlSeconds: settings.locks.ttl_seconds,
          lockWaitMs: settings.locks.wait_ms,
          recordCreation: false,
          dryRun: options.dryRun === true,
          /** Derive both audited bytes and canonical preview from the same validated locked source. */
          mutate: async (beforeRaw) => {
            const current: unknown = beforeRaw === null ? null : JSON.parse(beforeRaw);
            const validatedCurrent = validateSettings(current);
            if (!validatedCurrent.success) {
              throw new PmCliError(
                "Workspace settings mutation requires a valid initialized settings.json.",
                EXIT_CODE.USAGE,
              );
            }
            const currentSettings = mergeSettings(validatedCurrent.data);
            const next = await options.mutate(structuredClone(currentSettings));
            if (!validateSettings(next).success) {
              throw new PmCliError(
                "Workspace settings mutation returned invalid settings.json.",
                EXIT_CODE.USAGE,
              );
            }
            let raw = stableValueEquals(currentSettings, next)
              ? beforeRaw!
              : serializeSettings(next, { source: { raw: current, validated: validatedCurrent.data } });
            raw = replaceOwnedSettingsSubtrees(raw, next, options.replaceSubtrees);
            const validatedResult = validateSettings(JSON.parse(raw));
            if (!validatedResult.success) {
              throw new PmCliError(
                "Workspace settings mutation serialized invalid settings.json.",
                EXIT_CODE.USAGE,
              );
            }
            return {
              raw,
              result: options.includePreview === true
                ? mergeSettings(validatedResult.data)
                : undefined,
            };
          },
        });
        if (mutation.changed && options.dryRun !== true) {
          await runActiveOnWriteHooks({
            path: getSettingsPath(pmRoot),
            scope: "project",
            op: "extension:pm:settings",
          });
        }
        return {
          changed: mutation.changed,
          dry_run: options.dryRun === true,
          replayed: mutation.replayed === true,
          ...(mutation.result === undefined ? {} : { preview: mutation.result }),
        };
      } finally {
        clearSettingsReadCache(pmRoot);
      }
    },
  };
}
