import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GlobalOptions } from "../../../../src/sdk/index.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

interface RuntimeSdkModule {
  EXIT_CODE: { USAGE: number };
  PmCliError: new (message: string, exitCode?: number) => Error;
  runTestRunsList: (options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
  runTestRunsStatus: (runId: string, global: GlobalOptions) => Promise<unknown>;
  runTestRunsLogs: (runId: string, options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
  runTestRunsStop: (runId: string, options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
  runTestRunsResume: (runId: string, options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
}

interface RuntimeBundle {
  sdk: RuntimeSdkModule;
}

let runtimeBundle: RuntimeBundle | null = null;
let runtimeBundlePromise: Promise<RuntimeBundle> | null = null;

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
      `builtin-linked-test-adapters requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const sdkLoaded = (await import(pathToFileURL(modulePath).href)) as Partial<RuntimeSdkModule>;
    if (
      typeof sdkLoaded.runTestRunsList === "function" &&
      typeof sdkLoaded.runTestRunsStatus === "function" &&
      typeof sdkLoaded.runTestRunsLogs === "function" &&
      typeof sdkLoaded.runTestRunsStop === "function" &&
      typeof sdkLoaded.runTestRunsResume === "function" &&
      typeof sdkLoaded.PmCliError === "function" &&
      typeof sdkLoaded.EXIT_CODE === "object" &&
      sdkLoaded.EXIT_CODE !== null
    ) {
      return {
        sdk: sdkLoaded as RuntimeSdkModule,
      };
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-linked-test-adapters failed to load test-runs SDK runtime exports from ${modulePath}.`,
  );
}

function readStringOption(options: Record<string, unknown>, key: string, aliases: string[] = []): string | undefined {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readBooleanOption(options: Record<string, unknown>, key: string, aliases: string[] = []): boolean | undefined {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
        return false;
      }
    }
  }
  return undefined;
}

function requireRunId(bundle: RuntimeBundle, commandName: string, args: string[]): string {
  const runId = args[0];
  if (typeof runId === "string" && runId.trim().length > 0) {
    return runId.trim();
  }
  throw new bundle.sdk.PmCliError(`${commandName} requires a runId argument.`, bundle.sdk.EXIT_CODE.USAGE);
}

export async function runTestRunsListPackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsList(
    {
      status: readStringOption(options, "status"),
      limit: readStringOption(options, "limit"),
    },
    global,
  );
}

export async function runTestRunsStatusPackage(args: string[], global: GlobalOptions): Promise<unknown> {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsStatus(requireRunId(bundle, "test-runs status", args), global);
}

export async function runTestRunsLogsPackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsLogs(
    requireRunId(bundle, "test-runs logs", args),
    {
      stream: readStringOption(options, "stream"),
      tail: readStringOption(options, "tail"),
    },
    global,
  );
}

export async function runTestRunsStopPackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsStop(
    requireRunId(bundle, "test-runs stop", args),
    {
      force: readBooleanOption(options, "force") === true,
    },
    global,
  );
}

export async function runTestRunsResumePackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsResume(
    requireRunId(bundle, "test-runs resume", args),
    {
      author: readStringOption(options, "author"),
      noExtensions: global.noExtensions === true,
    },
    global,
  );
}
