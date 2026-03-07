import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json?: unknown;
}

export interface TempPmContext {
  tempRoot: string;
  pmPath: string;
  env: NodeJS.ProcessEnv;
  runCli: (args: string[], options?: { expectJson?: boolean; cwd?: string }) => CliRunResult;
}

function distCliPath(): string {
  return path.resolve(process.cwd(), "dist/cli.js");
}

function runNodeCli(
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: { expectJson?: boolean; cwd?: string },
): CliRunResult {
  const completed = spawnSync(process.execPath, [distCliPath(), ...args], {
    cwd: options?.cwd ?? process.cwd(),
    env,
    encoding: "utf8",
  });

  const result: CliRunResult = {
    code: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
  };

  if (options?.expectJson && result.stdout.trim()) {
    result.json = JSON.parse(result.stdout);
  }

  return result;
}

export async function withTempPmPath<T>(callback: (context: TempPmContext) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cli-test-"));
  const pmPath = path.join(tempRoot, ".agents", "pm");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PM_PATH: pmPath,
    PM_GLOBAL_PATH: path.join(tempRoot, ".pm-cli-global"),
    PM_AUTHOR: "test-author",
    FORCE_COLOR: "0",
  };

  const runCli = (args: string[], options?: { expectJson?: boolean; cwd?: string }): CliRunResult =>
    runNodeCli(env, args, options);

  const previousEnv = {
    PM_PATH: process.env.PM_PATH,
    PM_GLOBAL_PATH: process.env.PM_GLOBAL_PATH,
    PM_AUTHOR: process.env.PM_AUTHOR,
  };
  process.env.PM_PATH = env.PM_PATH;
  process.env.PM_GLOBAL_PATH = env.PM_GLOBAL_PATH;
  process.env.PM_AUTHOR = env.PM_AUTHOR;

  try {
    const initResult = runCli(["init", "--json"], { expectJson: true });
    if (initResult.code !== 0) {
      throw new Error(`Failed to initialize test PM_PATH: ${initResult.stderr || initResult.stdout}`);
    }

    return await callback({
      tempRoot,
      pmPath,
      env,
      runCli,
    });
  } finally {
    if (previousEnv.PM_PATH === undefined) {
      delete process.env.PM_PATH;
    } else {
      process.env.PM_PATH = previousEnv.PM_PATH;
    }
    if (previousEnv.PM_GLOBAL_PATH === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = previousEnv.PM_GLOBAL_PATH;
    }
    if (previousEnv.PM_AUTHOR === undefined) {
      delete process.env.PM_AUTHOR;
    } else {
      process.env.PM_AUTHOR = previousEnv.PM_AUTHOR;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}
