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
      `builtin-linked-test-adapters requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const sdkLoaded = await import(pathToFileURL(modulePath).href);
    if (
      typeof sdkLoaded.runTestRunsList === "function" &&
      typeof sdkLoaded.runTestRunsStatus === "function" &&
      typeof sdkLoaded.runTestRunsLogs === "function" &&
      typeof sdkLoaded.runTestRunsStop === "function" &&
      typeof sdkLoaded.runTestRunsResume === "function" &&
      typeof sdkLoaded.PmCliError === "function" &&
      typeof sdkLoaded.readStringOption === "function" &&
      typeof sdkLoaded.readBooleanOption === "function" &&
      typeof sdkLoaded.EXIT_CODE === "object" &&
      sdkLoaded.EXIT_CODE !== null
    ) {
      return {
        sdk: sdkLoaded,
      };
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-linked-test-adapters failed to load test-runs SDK runtime exports from ${modulePath}.`,
  );
}

function requireRunId(bundle, commandName, args) {
  const runId = args[0];
  if (typeof runId === "string" && runId.trim().length > 0) {
    return runId.trim();
  }
  throw new bundle.sdk.PmCliError(`${commandName} requires a runId argument.`, bundle.sdk.EXIT_CODE.USAGE);
}

export async function runTestRunsListPackage(options, global) {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsList(
    {
      status: bundle.sdk.readStringOption(options, "status"),
      limit: bundle.sdk.readStringOption(options, "limit"),
    },
    global,
  );
}

export async function runTestRunsStatusPackage(args, global) {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsStatus(requireRunId(bundle, "test-runs status", args), global);
}

export async function runTestRunsLogsPackage(args, options, global) {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsLogs(
    requireRunId(bundle, "test-runs logs", args),
    {
      stream: bundle.sdk.readStringOption(options, "stream"),
      tail: bundle.sdk.readStringOption(options, "tail"),
    },
    global,
  );
}

export async function runTestRunsStopPackage(args, options, global) {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsStop(
    requireRunId(bundle, "test-runs stop", args),
    {
      force: bundle.sdk.readBooleanOption(options, "force") === true,
    },
    global,
  );
}

export async function runTestRunsResumePackage(args, options, global) {
  const bundle = await ensureRuntimeBundle();
  return bundle.sdk.runTestRunsResume(
    requireRunId(bundle, "test-runs resume", args),
    {
      author: bundle.sdk.readStringOption(options, "author"),
      noExtensions: global.noExtensions === true,
    },
    global,
  );
}
