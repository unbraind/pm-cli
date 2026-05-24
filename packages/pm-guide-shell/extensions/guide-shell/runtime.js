import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
let runtimeBundle = null;
let runtimeBundlePromise = null;

async function ensureRuntimeBundle() {
  if (runtimeBundle) {
    return runtimeBundle;
  }
  if (!runtimeBundlePromise) {
    runtimeBundlePromise = loadRuntimeBundle();
  }
  runtimeBundle = await runtimeBundlePromise;
  return runtimeBundle;
}

async function loadRuntimeBundle() {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-guide-shell requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const sdkLoaded = await import(pathToFileURL(modulePath).href);
    if (
      typeof sdkLoaded.runGuide === "function" &&
      typeof sdkLoaded.resolveGuideOutputFormat === "function" &&
      typeof sdkLoaded.renderGuideMarkdown === "function" &&
      typeof sdkLoaded.runCompletion === "function" &&
      typeof sdkLoaded.pathExists === "function" &&
      typeof sdkLoaded.getSettingsPath === "function" &&
      typeof sdkLoaded.resolvePmRoot === "function" &&
      typeof sdkLoaded.readSettings === "function" &&
      typeof sdkLoaded.resolveItemTypeRegistry === "function" &&
      typeof sdkLoaded.resolveRuntimeStatusRegistry === "function" &&
      typeof sdkLoaded.resolveRuntimeFieldRegistry === "function" &&
      typeof sdkLoaded.listAllFrontMatter === "function" &&
      typeof sdkLoaded.getActiveExtensionRegistrations === "function" &&
      typeof sdkLoaded.readStringOption === "function" &&
      typeof sdkLoaded.readBooleanOption === "function" &&
      typeof sdkLoaded.readCsvListOption === "function"
    ) {
      return {
        sdk: sdkLoaded,
      };
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-guide-shell failed to load guide/completion SDK runtime exports from ${modulePath}.`,
  );
}

function normalizeGuideOptions(bundle, args, options) {
  const { readStringOption, readBooleanOption } = bundle.sdk;
  const topicFromArgs = args[0];
  return {
    topic: readStringOption(options, "topic") ?? (typeof topicFromArgs === "string" && topicFromArgs.trim().length > 0 ? topicFromArgs : undefined),
    list: readBooleanOption(options, "list") === true ? true : undefined,
    format: readStringOption(options, "format"),
    depth: readStringOption(options, "depth"),
  };
}

function normalizeCompletionOptions(bundle, args, options) {
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

async function buildCompletionRuntimeConfig(bundle, global) {
  const pmRoot = bundle.sdk.resolvePmRoot(process.cwd(), global.path);
  if (!(await bundle.sdk.pathExists(bundle.sdk.getSettingsPath(pmRoot)))) {
    return {};
  }
  const settings = await bundle.sdk.readSettings(pmRoot);
  const schema = settings.schema;
  const statuses = bundle.sdk.resolveRuntimeStatusRegistry(schema).definitions
    .map((definition) => definition.id)
    .filter((status) => typeof status === "string" && status.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
  const fieldRegistry = bundle.sdk.resolveRuntimeFieldRegistry(schema);
  const runtimeCommands = ["list", "create", "update", "update-many", "search", "calendar", "context"];
  const commandFlags = {};
  for (const command of runtimeCommands) {
    const definitions = fieldRegistry.command_to_fields.get(command) ?? [];
    const flags = [
      ...new Set(
        definitions
          .map((definition) => definition.cli_flag)
          .filter((value) => typeof value === "string" && value.trim().length > 0)
          .map((value) => `--${value.trim().replaceAll("_", "-")}`),
      ),
    ].sort((left, right) => left.localeCompare(right));
    if (flags.length > 0) {
      commandFlags[command] = flags;
    }
  }
  return {
    statuses: statuses.length > 0 ? statuses : undefined,
    command_flags: Object.keys(commandFlags).length > 0 ? commandFlags : undefined,
  };
}

function readPayloadFormat(payload) {
  if (typeof payload === "object" && payload !== null) {
    const format = payload.format;
    if (format === "json") {
      return "json";
    }
  }
  return "toon";
}

function readPayloadResult(payload) {
  if (typeof payload === "object" && payload !== null && "result" in payload) {
    return payload.result;
  }
  return payload;
}

function collectTagsFromItems(items) {
  const tagSet = new Set();
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

export async function runGuidePackage(args, options, global) {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runGuide(normalizeGuideOptions(bundle, args, options), global);
}

export async function runCompletionPackage(args, options, global) {
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

export async function runCompletionTagsPackage(global) {
  const bundle = await ensureRuntimeBundle();
  const pmRoot = bundle.sdk.resolvePmRoot(process.cwd(), global.path);
  if (!(await bundle.sdk.pathExists(bundle.sdk.getSettingsPath(pmRoot)))) {
    return { tags: [], count: 0 };
  }
  const settings = await bundle.sdk.readSettings(pmRoot);
  const registrations = bundle.sdk.getActiveExtensionRegistrations();
  const typeRegistry = bundle.sdk.resolveItemTypeRegistry(settings, registrations);
  const typeToFolder = Object.fromEntries(
    typeRegistry.definitions.map((definition) => [definition.name, definition.folder]),
  );
  const schema = settings.schema;
  const itemFormat = settings.item_format === "json_markdown" ? "json_markdown" : "toon";
  const items = await bundle.sdk.listAllFrontMatter(pmRoot, itemFormat, typeToFolder, undefined, schema);
  const tags = collectTagsFromItems(items);
  return {
    tags,
    count: tags.length,
  };
}

export function renderGuideShellPackageOutput(context) {
  if (!runtimeBundle) {
    return null;
  }
  const result = readPayloadResult(context.payload);
  if (context.command === "guide") {
    const options = context.options ?? {};
    const global = context.global ?? {};
    const outputFormat = runtimeBundle.sdk.resolveGuideOutputFormat(options, global);
    if (outputFormat === "markdown") {
      return `${runtimeBundle.sdk.renderGuideMarkdown(result)}\n`;
    }
    if (outputFormat === "json" || readPayloadFormat(context.payload) === "json") {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    return null;
  }
  if (context.command === "completion") {
    if (readPayloadFormat(context.payload) === "json") {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    if (typeof result === "object" && result !== null && typeof result.script === "string") {
      const script = result.script;
      return script.endsWith("\n") ? script : `${script}\n`;
    }
    return null;
  }
  if (context.command === "completion-tags") {
    if (readPayloadFormat(context.payload) === "json") {
      return `${JSON.stringify(result, null, 2)}\n`;
    }
    const tags = typeof result === "object" && result !== null && Array.isArray(result.tags)
      ? result.tags.filter((entry) => typeof entry === "string")
      : [];
    return `${tags.join(" ")}\n`;
  }
  return null;
}
