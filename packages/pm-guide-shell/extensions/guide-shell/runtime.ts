import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GlobalOptions, ServiceOverrideContext } from "@unbrained/pm-cli/sdk";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

interface RuntimeSdkModule {
  runGuide: (options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
  resolveGuideOutputFormat: (options: Record<string, unknown>, global: GlobalOptions) => "markdown" | "toon" | "json";
  renderGuideMarkdown: (result: unknown) => string;
  runCompletion: (
    shell: string,
    itemTypes?: string[],
    tags?: string[],
    eagerTagExpansion?: boolean,
    runtime?: {
      item_types?: string[];
      statuses?: string[];
      command_flags?: Partial<Record<"list" | "create" | "update" | "update-many" | "search" | "calendar" | "context", string[]>>;
    },
  ) => {
    shell: string;
    script: string;
    setup_hint: string;
  };
  pathExists: (targetPath: string) => Promise<boolean>;
  getSettingsPath: (pmRoot: string) => string;
  resolvePmRoot: (cwd: string, overridePath?: string) => string;
  readSettings: (pmRoot: string) => Promise<Record<string, unknown>>;
  resolveItemTypeRegistry: (
    settings: unknown,
    registrations: unknown,
  ) => {
    types?: string[];
    definitions?: Array<{ name: string; folder: string }>;
    type_to_folder?: Record<string, string>;
  };
  resolveRuntimeStatusRegistry: (schema: unknown) => { definitions: Array<{ id: string }> };
  resolveRuntimeFieldRegistry: (schema: unknown) => {
    command_to_fields: Map<string, Array<{ cli_flag: string }>>;
  };
  listAllFrontMatter: (
    pmRoot: string,
    itemFormat: "toon" | "json_markdown",
    typeToFolder: Record<string, string>,
    status?: unknown,
    schema?: unknown,
  ) => Promise<Array<{ metadata: { tags?: string[] } }>>;
  getActiveExtensionRegistrations: () => unknown;
  readStringOption: (options: Record<string, unknown>, key: string, aliases?: string[]) => string | undefined;
  readBooleanOption: (options: Record<string, unknown>, key: string, aliases?: string[]) => boolean | undefined;
  readCsvListOption: (options: Record<string, unknown>, key: string, aliases?: string[]) => string[];
}

interface RuntimeBundle {
  sdk: RuntimeSdkModule;
}

let runtimeBundle: RuntimeBundle | null = null;
let runtimeBundlePromise: Promise<RuntimeBundle> | null = null;
const REQUIRED_RUNTIME_SDK_EXPORTS = [
  "runGuide",
  "resolveGuideOutputFormat",
  "renderGuideMarkdown",
  "runCompletion",
  "pathExists",
  "getSettingsPath",
  "resolvePmRoot",
  "readSettings",
  "resolveItemTypeRegistry",
  "resolveRuntimeStatusRegistry",
  "resolveRuntimeFieldRegistry",
  "listAllFrontMatter",
  "getActiveExtensionRegistrations",
  "readStringOption",
  "readBooleanOption",
  "readCsvListOption",
] as const satisfies ReadonlyArray<keyof RuntimeSdkModule>;

async function ensureRuntimeBundle(): Promise<RuntimeBundle> {
  if (runtimeBundle) {
    return runtimeBundle;
  }
  if (!runtimeBundlePromise) {
    runtimeBundlePromise = loadRuntimeBundle();
  }
  runtimeBundle = await runtimeBundlePromise;
  return runtimeBundle;
}

async function loadRuntimeBundle(): Promise<RuntimeBundle> {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-guide-shell requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const sdkLoaded = (await import(pathToFileURL(modulePath).href)) as Partial<RuntimeSdkModule>;
    if (REQUIRED_RUNTIME_SDK_EXPORTS.every((key) => typeof sdkLoaded[key] === "function")) {
      return {
        sdk: sdkLoaded as RuntimeSdkModule,
      };
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-guide-shell failed to load guide/completion SDK runtime exports from ${modulePath}.`,
  );
}

function normalizeGuideOptions(
  bundle: RuntimeBundle,
  args: string[],
  options: Record<string, unknown>,
): Record<string, unknown> {
  const { readStringOption, readBooleanOption } = bundle.sdk;
  const topicFromArgs = args[0];
  return {
    topic: readStringOption(options, "topic") ?? (typeof topicFromArgs === "string" && topicFromArgs.trim().length > 0 ? topicFromArgs : undefined),
    list: readBooleanOption(options, "list") === true ? true : undefined,
    format: readStringOption(options, "format"),
    depth: readStringOption(options, "depth"),
  };
}

function normalizeCompletionOptions(bundle: RuntimeBundle, args: string[], options: Record<string, unknown>): {
  shell: string;
  itemTypes: string[];
  tags: string[];
  eagerTags: boolean;
} {
  const { readStringOption, readBooleanOption, readCsvListOption } = bundle.sdk;
  const shellFromOptions = readStringOption(options, "shell");
  const shellFromArgs = typeof args[0] === "string" && args[0].trim().length > 0 ? args[0].trim() : undefined;
  return {
    shell: shellFromOptions ?? shellFromArgs ?? "bash",
    itemTypes: readCsvListOption(options, "itemTypes", ["item_types"]),
    tags: readCsvListOption(options, "tags"),
    eagerTags: readBooleanOption(options, "eagerTags", ["eager_tags"]) === true,
  };
}

function collectTypeNames(typeRegistry: ReturnType<RuntimeSdkModule["resolveItemTypeRegistry"]>): string[] {
  const candidates = Array.isArray(typeRegistry.types)
    ? typeRegistry.types
    : Array.isArray(typeRegistry.definitions)
      ? typeRegistry.definitions
          .filter((definition) => Boolean(definition))
          .map((definition) => definition.name)
      : [];
  return [...new Set(candidates.filter((value): value is string => typeof value === "string" && value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function collectTypeToFolder(typeRegistry: ReturnType<RuntimeSdkModule["resolveItemTypeRegistry"]>): Record<string, string> {
  if (typeof typeRegistry.type_to_folder === "object" && typeRegistry.type_to_folder !== null) {
    return typeRegistry.type_to_folder;
  }
  return Object.fromEntries(
    (typeRegistry.definitions ?? [])
      .filter((definition) => Boolean(definition?.name && definition?.folder))
      .map((definition) => [definition.name, definition.folder]),
  );
}

async function buildCompletionRuntimeConfig(
  bundle: RuntimeBundle,
  global: GlobalOptions,
): Promise<{
  item_types?: string[];
  statuses?: string[];
  command_flags?: Partial<Record<"list" | "create" | "update" | "update-many" | "search" | "calendar" | "context", string[]>>;
}> {
  const pmRoot = bundle.sdk.resolvePmRoot(process.cwd(), global.path);
  if (!(await bundle.sdk.pathExists(bundle.sdk.getSettingsPath(pmRoot)))) {
    return {};
  }
  const settings = await bundle.sdk.readSettings(pmRoot);
  const registrations = bundle.sdk.getActiveExtensionRegistrations();
  const typeRegistry = bundle.sdk.resolveItemTypeRegistry(settings, registrations);
  const itemTypes = collectTypeNames(typeRegistry);
  const schema = (settings as { schema?: unknown }).schema;
  const statuses = bundle.sdk.resolveRuntimeStatusRegistry(schema).definitions
    .map((definition) => definition.id)
    .filter((status) => typeof status === "string" && status.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
  const fieldRegistry = bundle.sdk.resolveRuntimeFieldRegistry(schema);
  const runtimeCommands = ["list", "create", "update", "update-many", "search", "calendar", "context"] as const;
  const commandFlags: Partial<Record<(typeof runtimeCommands)[number], string[]>> = {};
  for (const command of runtimeCommands) {
    const definitions = fieldRegistry.command_to_fields.get(command) ?? [];
    const flags = [
      ...new Set(
        definitions
          .map((definition) => definition.cli_flag)
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
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
    command_flags: Object.keys(commandFlags).length > 0 ? commandFlags : undefined,
  };
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
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

function collectTagsFromItems(items: Array<{ metadata: { tags?: string[] } }>): string[] {
  const tagSet = new Set<string>();
  for (const item of items) {
    const tags = Array.isArray(item.metadata.tags) ? item.metadata.tags : [];
    for (const tag of tags) {
      if (typeof tag === "string" && tag.trim().length > 0) {
        tagSet.add(tag.trim());
      }
    }
  }
  return [...tagSet].sort((left, right) => left.localeCompare(right));
}

function readStringArrayResult(result: unknown, key: "tags" | "statuses" | "types"): string[] {
  if (typeof result !== "object" || result === null) {
    return [];
  }
  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function renderJsonOrWords(payload: unknown, result: unknown, key: "tags" | "statuses" | "types"): string {
  if (readPayloadFormat(payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return `${readStringArrayResult(result, key).join(" ")}\n`;
}

function renderCompletionPackageOutput(payload: unknown, result: unknown): string | null {
  if (readPayloadFormat(payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (typeof result === "object" && result !== null && typeof (result as { script?: unknown }).script === "string") {
    const script = (result as { script: string }).script;
    return script.endsWith("\n") ? script : `${script}\n`;
  }
  return null;
}

function renderGuidePackageOutput(bundle: RuntimeBundle, context: ServiceOverrideContext, result: unknown): string | null {
  const options = (context.options ?? {}) as Record<string, unknown>;
  const global = (context.global ?? {}) as GlobalOptions;
  const outputFormat = bundle.sdk.resolveGuideOutputFormat(options, global);
  if (outputFormat === "markdown") {
    return `${bundle.sdk.renderGuideMarkdown(result)}\n`;
  }
  if (outputFormat === "json" || readPayloadFormat(context.payload) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return null;
}

export async function runGuidePackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runGuide(normalizeGuideOptions(bundle, args, options), global);
}

export async function runCompletionPackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const bundle = await ensureRuntimeBundle();
  const normalized = normalizeCompletionOptions(bundle, args, options);
  const runtimeConfig = await buildCompletionRuntimeConfig(bundle, global);
  return bundle.sdk.runCompletion(
    normalized.shell,
    normalized.itemTypes,
    normalized.tags,
    normalized.eagerTags,
    runtimeConfig,
  );
}

export async function runCompletionTagsPackage(global: GlobalOptions): Promise<{ tags: string[]; count: number }> {
  const bundle = await ensureRuntimeBundle();
  const pmRoot = bundle.sdk.resolvePmRoot(process.cwd(), global.path);
  if (!(await bundle.sdk.pathExists(bundle.sdk.getSettingsPath(pmRoot)))) {
    return { tags: [], count: 0 };
  }
  const settings = await bundle.sdk.readSettings(pmRoot);
  const registrations = bundle.sdk.getActiveExtensionRegistrations();
  const typeRegistry = bundle.sdk.resolveItemTypeRegistry(settings, registrations);
  const typeToFolder = collectTypeToFolder(typeRegistry);
  const schema = (settings as { schema?: unknown }).schema;
  const itemFormat = ((settings as { item_format?: unknown }).item_format === "json_markdown" ? "json_markdown" : "toon") as
    | "toon"
    | "json_markdown";
  const items = await bundle.sdk.listAllFrontMatter(pmRoot, itemFormat, typeToFolder, undefined, schema);
  const tags = collectTagsFromItems(items);
  return {
    tags,
    count: tags.length,
  };
}

export async function runCompletionStatusesPackage(global: GlobalOptions): Promise<{ statuses: string[]; count: number }> {
  const bundle = await ensureRuntimeBundle();
  const pmRoot = bundle.sdk.resolvePmRoot(process.cwd(), global.path);
  const settings = await bundle.sdk.readSettings(pmRoot);
  const schema = (settings as { schema?: unknown }).schema;
  const statuses = bundle.sdk.resolveRuntimeStatusRegistry(schema).definitions
    .map((definition) => definition.id)
    .filter((status) => typeof status === "string" && status.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
  return {
    statuses,
    count: statuses.length,
  };
}

export async function runCompletionTypesPackage(global: GlobalOptions): Promise<{ types: string[]; count: number }> {
  const bundle = await ensureRuntimeBundle();
  const pmRoot = bundle.sdk.resolvePmRoot(process.cwd(), global.path);
  const settings = await bundle.sdk.readSettings(pmRoot);
  const registrations = bundle.sdk.getActiveExtensionRegistrations();
  const typeRegistry = bundle.sdk.resolveItemTypeRegistry(settings, registrations);
  const types = collectTypeNames(typeRegistry);
  return {
    types,
    count: types.length,
  };
}

export function renderGuideShellPackageOutput(context: ServiceOverrideContext): string | null {
  const bundle = runtimeBundle;
  if (!bundle) {
    return null;
  }
  const result = readPayloadResult(context.payload);
  if (context.command === "guide") {
    return renderGuidePackageOutput(bundle, context, result);
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
