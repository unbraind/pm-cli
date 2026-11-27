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
import { readSettingsSection, writeSettingsSection } from "../core/store/settings-sections.js";
import { validateSettings } from "../core/store/settings-validator.js";
import { isPmCliExpectedError } from "./errors.js";
import { getItemAt } from "./history-read.js";
import { fitOutputEnvelope } from "./output/fit-envelope.js";
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

/**
 * A settings writer shares the `schema add-field` admission for every inline
 * field definition it adds or changes (pm-3s4jwl): a flag the parser would
 * split, or an option that shadows a built-in option, is refused before
 * anything is written. A definition the proposal leaves exactly as stored is
 * not judged again, so an unrelated write can still preserve a legacy
 * definition, which validate keeps reporting, unless it becomes the
 * definition the registry reads for its key.
 */
async function assertChangedSchemaFieldsAvailable(current: PmSettings, next: PmSettings, rawFields: unknown, fileFields: { before: readonly unknown[]; after: readonly unknown[] }): Promise<void> {
  // A JavaScript proposal may omit schema or schema.fields, which settings validation accepts as no fields.
  const proposed = (next as { schema?: { fields?: PmSettings["schema"]["fields"] } }).schema?.fields ?? [];
  // No early return for an empty inline list: a proposal can still make a file-backed definition effective.
  const { normalizeCliToken, resolveRuntimeFieldRegistry } = await import("../core/schema/runtime-schema.js");
  // Definitions compare as the registry reads them, so a proposal that JSON round-trips the fields or
  // restates a stored definition without its defaults leaves it unchanged. One the registry drops compares
  // as it persists, so only a new or edited one is judged.
  const resolved = (definition: unknown): unknown => resolveRuntimeFieldRegistry({ fields: [definition] } as PmSettings["schema"]).definitions[0];
  const persisted = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
  // The raw stored entries count too: a proposal may restate a definition exactly as the file holds it.
  const stored = [...current.schema.fields, ...(Array.isArray(rawFields) ? rawFields : [])].map((definition) => ({ resolved: resolved(definition), persisted: persisted(definition) }));
  // A spelling that normalizes to nothing is dropped by the registry, so only an exact stored copy hides it.
  const hasEmptySpelling = (definition: PmSettings["schema"]["fields"][number]): boolean =>
    [definition.cli_flag, ...(Array.isArray(definition.cli_aliases) ? definition.cli_aliases : [])].some((token) => typeof token === "string" && normalizeCliToken(token).length === 0);
  const changed = proposed.filter((definition) => {
    const candidate = resolved(definition);
    const storedCopy = stored.some((entry) => stableValueEquals(entry.persisted, persisted(definition)));
    if (candidate === undefined || hasEmptySpelling(definition)) return !storedCopy;
    return !stored.some((entry) => stableValueEquals(entry.resolved, candidate));
  });
  // The registry reads the last definition of each key, the fields file after the inline list. A stored copy that
  // becomes that definition, such as an earlier duplicate the proposal exposes by removing the later one, takes
  // effect now and is judged (pm-2nwcgg); one a file-backed definition still masks is not.
  const effective = (fields: readonly unknown[]): Map<string, { definition: unknown; resolved: unknown }> => {
    const byKey = new Map<string, { definition: unknown; resolved: unknown }>();
    for (const definition of fields) {
      const candidate = resolved(definition) as { key: string } | undefined;
      if (candidate !== undefined) byKey.set(candidate.key, { definition, resolved: candidate });
    }
    return byKey;
  };
  const before = effective([...current.schema.fields, ...fileFields.before]);
  const rawStored: readonly unknown[] = Array.isArray(rawFields) ? rawFields : [];
  for (const [key, entry] of effective([...proposed, ...fileFields.after])) {
    const definition = entry.definition as (typeof proposed)[number];
    if (changed.includes(definition) || stableValueEquals(before.get(key)?.resolved, entry.resolved)) continue;
    // The proposal holds the normalized copy, which has lost a blank alias the stored entry keeps; judge the
    // stored spelling that stays on disk when one resolves the same way.
    const stored = rawStored.find((candidate) => stableValueEquals(resolved(candidate), entry.resolved));
    changed.push((stored ?? definition) as (typeof proposed)[number]);
  }
  if (changed.length === 0) return;
  const { assertFieldDefinitionOptionsAvailable } = await import("./schema/field-option-collisions.js");
  for (const definition of changed) assertFieldDefinitionOptionsAvailable(definition);
}

/** Bind public SDK services to one tracker and one caller-owned client. */
export function createExtensionCommandSdk(
  pmRoot: string,
  client: PmClient,
  invocationAuthor?: string,
  invocationCommand?: string,
): ExtensionCommandSdk {
  return {
    fitOutputEnvelope,
    client,
    isItemNotFoundError: (error) =>
      isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND,
    getItemAt: (id, target) => getItemAt(id, target, { pmRoot }),
    readSettingsSection: (section, options) => readSettingsSection(pmRoot, section, options),
    writeSettingsSection: (section, value, options) =>
      writeSettingsSection(pmRoot, section, value, { author: invocationAuthor, ...options }),
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
          author: resolveAuthor(invocationAuthor, settings.author_default),
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
            const { readFieldsFileDefinitions } = await import("./schema/field-definition-losses.js");
            const proposedSchema = (next as { schema?: PmSettings["schema"] }).schema;
            await assertChangedSchemaFieldsAvailable(currentSettings, next, (current as { schema?: { fields?: unknown } }).schema?.fields, {
              before: await readFieldsFileDefinitions(pmRoot, currentSettings.schema),
              after: await readFieldsFileDefinitions(pmRoot, proposedSchema),
            });
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
