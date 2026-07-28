/**
 * Runtime contracts and behavior for packages/pm guide shell/extensions/guide shell/runtime.
 *
 * @module packages/pm-guide-shell/extensions/guide-shell/runtime
 */
import {
  getActiveExtensionRegistrations,
  getSettingsPath,
  listAllItemMetadata,
  pathExists,
  readBooleanOption,
  readCsvListOption,
  readSettings,
  readStringOption,
  renderGuideMarkdown,
  resolveGuideOutputFormat,
  resolveItemTypeRegistry,
  resolvePmRoot,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  runCompletion,
  runGuide,
  type GlobalOptions,
  type GuideResult,
  type ItemMetadata,
  type ServiceOverrideContext,
} from "@unbrained/pm-cli/sdk";

function normalizeGuideOptions(
  args: string[],
  options: Record<string, unknown>,
): Record<string, unknown> {
  const topicFromArgs = args[0];
  return {
    topic:
      readStringOption(options, "topic") ??
      (typeof topicFromArgs === "string" && topicFromArgs.trim().length > 0
        ? topicFromArgs
        : undefined),
    list: readBooleanOption(options, "list") === true ? true : undefined,
    format: readStringOption(options, "format"),
    depth: readStringOption(options, "depth"),
  };
}

function normalizeCompletionOptions(
  args: string[],
  options: Record<string, unknown>,
): {
  shell: string;
  itemTypes: string[];
  tags: string[];
  eagerTags: boolean;
} {
  const shellFromOptions = readStringOption(options, "shell");
  const shellFromArgs =
    typeof args[0] === "string" && args[0].trim().length > 0
      ? args[0].trim()
      : undefined;
  return {
    shell: shellFromOptions ?? shellFromArgs ?? "bash",
    itemTypes: readCsvListOption(options, "itemTypes", ["item_types"]),
    tags: readCsvListOption(options, "tags"),
    eagerTags: readBooleanOption(options, "eagerTags", ["eager_tags"]) === true,
  };
}

function collectTypeNames(
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
): string[] {
  return [
    ...new Set(
      typeRegistry.types.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function collectTypeToFolder(
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
): Record<string, string> {
  return typeRegistry.type_to_folder;
}

function collectStatusNames(
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>,
): string[] {
  return statusRegistry.definitions
    .map((definition) => definition.id)
    .filter((status) => typeof status === "string" && status.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function buildCompletionRuntimeConfig(global: GlobalOptions): Promise<{
  item_types?: string[];
  statuses?: string[];
  command_flags?: Partial<
    Record<
      | "list"
      | "create"
      | "update"
      | "update-many"
      | "close-many"
      | "search"
      | "calendar"
      | "context",
      string[]
    >
  >;
}> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return {};
  }
  const settings = await readSettings(pmRoot);
  const registrations = getActiveExtensionRegistrations();
  const typeRegistry = resolveItemTypeRegistry(settings, registrations);
  const itemTypes = collectTypeNames(typeRegistry);
  const statuses = collectStatusNames(
    resolveRuntimeStatusRegistry(settings.schema),
  );
  const fieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const runtimeCommands = [
    "list",
    "create",
    "update",
    "update-many",
    "close-many",
    "search",
    "calendar",
    "context",
  ] as const;
  const commandFlags: Partial<
    Record<(typeof runtimeCommands)[number], string[]>
  > = {};
  const commandDefinitionsByName = new Map(
    [...fieldRegistry.command_to_fields].map(
      ([command, definitions]) => [String(command), definitions] as const,
    ),
  );
  for (const command of runtimeCommands) {
    const definitions =
      commandDefinitionsByName.get(
        command.trim().replace(/[-\s]+/gu, "_"),
      ) ?? [];
    const flags = [
      ...new Set(
        definitions
          .map((definition) => definition.cli_flag)
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .map((value) => `--${value.trim().replaceAll("_", "-")}`),
      ),
    ].sort((left, right) => left.localeCompare(right));
    if (flags.length > 0) {
      commandFlags[command] = flags;
    }
  }
  return {
    item_types: itemTypes.length > 0 ? itemTypes : undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    command_flags:
      Object.keys(commandFlags).length > 0 ? commandFlags : undefined,
  };
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function readPayloadFormat(payload: unknown): "toon" | "json" {
  return payloadRecord(payload)?.format === "json" ? "json" : "toon";
}

function readPayloadResult(payload: unknown): unknown {
  const record = payloadRecord(payload);
  return record && Object.hasOwn(record, "result") ? record.result : payload;
}

function collectTagsFromItems(items: ItemMetadata[]): string[] {
  const tagSet = new Set<string>();
  for (const item of items) {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    for (const tag of tags) {
      if (typeof tag === "string" && tag.trim().length > 0) {
        tagSet.add(tag.trim());
      }
    }
  }
  return [...tagSet].sort((left, right) => left.localeCompare(right));
}

function readStringArrayResult(
  result: unknown,
  key: "tags" | "statuses" | "types",
): string[] {
  if (typeof result !== "object" || result === null) {
    return [];
  }
  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function renderJsonOrWords(
  payload: unknown,
  result: unknown,
  key: "tags" | "statuses" | "types",
): string {
  if (readPayloadFormat(payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return `${readStringArrayResult(result, key).join(" ")}\n`;
}

function renderCompletionPackageOutput(
  payload: unknown,
  result: unknown,
): string | null {
  if (readPayloadFormat(payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { script?: unknown }).script === "string"
  ) {
    const script = (result as { script: string }).script;
    return script.endsWith("\n") ? script : `${script}\n`;
  }
  return null;
}

function renderGuidePackageOutput(
  context: ServiceOverrideContext,
  result: unknown,
): string | null {
  const options = (context.options ?? {}) as Record<string, unknown>;
  const global = (context.global ?? {}) as GlobalOptions;
  const outputFormat = resolveGuideOutputFormat(options, global);
  if (outputFormat === "markdown") {
    return `${renderGuideMarkdown(result as GuideResult)}\n`;
  }
  if (
    outputFormat === "json" ||
    readPayloadFormat(context.payload) === "json"
  ) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return null;
}

/** Executes the guide package operation through the package runtime. */
export async function runGuidePackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  return runGuide(normalizeGuideOptions(args, options), global);
}

/** Executes the completion package operation through the package runtime. */
export async function runCompletionPackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const normalized = normalizeCompletionOptions(args, options);
  const runtimeConfig = await buildCompletionRuntimeConfig(global);
  return runCompletion(
    normalized.shell,
    normalized.itemTypes,
    normalized.tags,
    normalized.eagerTags,
    runtimeConfig,
  );
}

/** Executes the completion tags package operation through the package runtime. */
export async function runCompletionTagsPackage(
  global: GlobalOptions,
): Promise<{ tags: string[]; count: number }> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return { tags: [], count: 0 };
  }
  const settings = await readSettings(pmRoot);
  const registrations = getActiveExtensionRegistrations();
  const typeRegistry = resolveItemTypeRegistry(settings, registrations);
  const typeToFolder = collectTypeToFolder(typeRegistry);
  const itemFormat = (
    settings.item_format === "json_markdown" ? "json_markdown" : "toon"
  ) as "toon" | "json_markdown";
  const items = await listAllItemMetadata(
    pmRoot,
    itemFormat,
    typeToFolder,
    undefined,
    settings.schema,
  );
  const tags = collectTagsFromItems(items);
  return {
    tags,
    count: tags.length,
  };
}

/** Executes the completion statuses package operation through the package runtime. */
export async function runCompletionStatusesPackage(
  global: GlobalOptions,
): Promise<{ statuses: string[]; count: number }> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return { statuses: [], count: 0 };
  }
  const settings = await readSettings(pmRoot);
  const statuses = collectStatusNames(
    resolveRuntimeStatusRegistry(settings.schema),
  );
  return {
    statuses,
    count: statuses.length,
  };
}

/** Executes the completion types package operation through the package runtime. */
export async function runCompletionTypesPackage(
  global: GlobalOptions,
): Promise<{ types: string[]; count: number }> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return { types: [], count: 0 };
  }
  const settings = await readSettings(pmRoot);
  const registrations = getActiveExtensionRegistrations();
  const typeRegistry = resolveItemTypeRegistry(settings, registrations);
  const types = collectTypeNames(typeRegistry);
  return {
    types,
    count: types.length,
  };
}

/** Formats guide shell package output data for the selected output mode. */
export function renderGuideShellPackageOutput(
  context: ServiceOverrideContext,
): string | null {
  const result = readPayloadResult(context.payload);
  if (context.command === "guide") {
    return renderGuidePackageOutput(context, result);
  }
  if (context.command === "completion") {
    return renderCompletionPackageOutput(context.payload, result);
  }
  if (context.command === "completion-tags") {
    return renderJsonOrWords(context.payload, result, "tags");
  }
  if (context.command === "completion-statuses") {
    return renderJsonOrWords(context.payload, result, "statuses");
  }
  if (context.command === "completion-types") {
    return renderJsonOrWords(context.payload, result, "types");
  }
  return null;
}
