import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";

export interface InstallCommandOptions {
  project?: boolean;
  global?: boolean;
}

export interface InstallResult {
  ok: boolean;
  target: "pi";
  scope: "project" | "global";
  source_path: string;
  destination_path: string;
  overwritten: boolean;
  warnings: string[];
}

export interface InstallRuntime {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
}

function getPackageRootFromCommandModule(): string {
  const commandModulePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(commandModulePath), "../../../");
}

function resolvePiExtensionSourcePath(packageRoot: string): string {
  return path.resolve(packageRoot, ".pi/extensions/pm-cli/index.ts");
}

function resolvePiGlobalRoot(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export async function runInstall(
  target: string,
  options: InstallCommandOptions,
  _global: GlobalOptions,
  runtime: InstallRuntime = {},
): Promise<InstallResult> {
  const normalizedTarget = target.trim().toLowerCase();
  if (normalizedTarget !== "pi") {
    throw new PmCliError(`Unsupported install target "${target}". Supported targets: pi.`, EXIT_CODE.USAGE);
  }

  const useProject = options.project === true;
  const useGlobal = options.global === true;
  if (useProject && useGlobal) {
    throw new PmCliError('Options "--project" and "--global" are mutually exclusive.', EXIT_CODE.USAGE);
  }

  const scope: "project" | "global" = useGlobal ? "global" : "project";
  const packageRoot = getPackageRootFromCommandModule();
  const sourcePath = resolvePiExtensionSourcePath(packageRoot);
  const readFileImpl = runtime.readFile ?? fs.readFile;
  const destinationPath =
    scope === "project"
      ? path.resolve(process.cwd(), ".pi/extensions/pm-cli/index.ts")
      : path.resolve(resolvePiGlobalRoot(), "extensions/pm-cli/index.ts");

  let sourceContent: string;
  try {
    sourceContent = await readFileImpl(sourcePath, "utf8");
  } catch (error: unknown) {
    const message = String(error);
    throw new PmCliError(
      `Failed to read bundled Pi extension source at "${sourcePath}": ${message}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  let existed = false;
  try {
    await fs.access(destinationPath);
    existed = true;
  } catch {
    existed = false;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, sourceContent, "utf8");

  const warnings: string[] = [];
  if (existed) {
    warnings.push(`overwritten:${destinationPath}`);
  }

  return {
    ok: true,
    target: "pi",
    scope,
    source_path: sourcePath,
    destination_path: destinationPath,
    overwritten: existed,
    warnings,
  };
}
