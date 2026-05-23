import { spawnSync } from "node:child_process";
import path from "node:path";

export interface DirectCliRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  expectJson?: boolean;
  input?: string;
  stdin?: string;
}

export interface DirectCliRunResult {
  code: number | null;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  json?: unknown;
}

export function distCliPath(): string {
  return path.resolve(process.cwd(), "dist/cli.js");
}

export function runDirectDistCli(args: string[], options: DirectCliRunOptions = {}): DirectCliRunResult {
  const completed = spawnSync(process.execPath, [distCliPath(), ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input ?? options.stdin,
  });
  const result: DirectCliRunResult = {
    code: completed.status,
    status: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
    error: completed.error,
  };
  if (options.expectJson && result.stdout.trim().length > 0) {
    try {
      result.json = JSON.parse(result.stdout);
    } catch (error) {
      const preview = result.stdout.slice(0, 500);
      throw new Error(`Failed to parse CLI JSON stdout for args ${JSON.stringify(args)}: ${String(error)}\nstdout: ${preview}`);
    }
  }
  return result;
}
