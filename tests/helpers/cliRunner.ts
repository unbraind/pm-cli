import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(encoding ?? "utf8");
  }
  if (chunk === undefined || chunk === null) {
    return "";
  }
  return String(chunk);
}

function applyEnvOverride(env: NodeJS.ProcessEnv | undefined): () => void {
  if (!env) {
    return () => {};
  }
  const keys = new Set<string>();
  for (const key of Object.keys(env)) {
    if (env[key] !== process.env[key]) {
      keys.add(key);
    }
  }
  if (keys.size === 0) {
    return () => {};
  }
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const next = env[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  return () => {
    for (const key of keys) {
      const prior = previous.get(key);
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  };
}

let inProcessCliRunQueue: Promise<void> = Promise.resolve();

async function withInProcessCliLock<T>(operation: () => Promise<T>): Promise<T> {
  let release: (() => void) | null = null;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitTurn = inProcessCliRunQueue;
  inProcessCliRunQueue = inProcessCliRunQueue.then(() => hold);
  await waitTurn;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

export async function runInProcessDistCli(
  args: string[],
  options: DirectCliRunOptions = {},
): Promise<DirectCliRunResult> {
  if (options.input !== undefined || options.stdin !== undefined) {
    throw new Error("runInProcessDistCli does not support stdin input.");
  }
  return withInProcessCliLock(async () => {
    const mainModuleUrl = pathToFileURL(path.resolve(process.cwd(), "dist/cli/main.js"));
    const cacheBustedUrl = `${mainModuleUrl.href}?inprocess=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const loaded = (await import(cacheBustedUrl)) as {
      runPmCli?: (argv: string[]) => Promise<void>;
    };
    if (typeof loaded.runPmCli !== "function") {
      throw new Error(`dist main module does not export runPmCli: ${cacheBustedUrl}`);
    }

    let stdout = "";
    let stderr = "";
    let status = 0;
    let capturedError: Error | undefined;
    const restoreEnv = applyEnvOverride(options.env);
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const previousStdoutWrite = process.stdout.write;
    const previousStderrWrite = process.stderr.write;

    try {
      process.argv = [process.argv[0], distCliPath(), ...args];
      process.exitCode = undefined;
      if (options.cwd) {
        process.chdir(options.cwd);
      }

      (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk, encoding, callback) => {
        const normalizedEncoding = typeof encoding === "string" ? (encoding as BufferEncoding) : undefined;
        stdout += chunkToString(chunk, normalizedEncoding);
        if (typeof encoding === "function") {
          encoding();
        } else if (typeof callback === "function") {
          callback();
        }
        return true;
      }) as typeof process.stdout.write;

      (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk, encoding, callback) => {
        const normalizedEncoding = typeof encoding === "string" ? (encoding as BufferEncoding) : undefined;
        stderr += chunkToString(chunk, normalizedEncoding);
        if (typeof encoding === "function") {
          encoding();
        } else if (typeof callback === "function") {
          callback();
        }
        return true;
      }) as typeof process.stderr.write;

      await loaded.runPmCli(args);
      status = process.exitCode ?? 0;
    } catch (error: unknown) {
      capturedError = error instanceof Error ? error : new Error(String(error));
      status = process.exitCode ?? 1;
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = previousStdoutWrite;
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = previousStderrWrite;
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
      if (options.cwd) {
        process.chdir(previousCwd);
      }
      restoreEnv();
    }

    const result: DirectCliRunResult = {
      code: status,
      status,
      stdout,
      stderr,
      ...(capturedError ? { error: capturedError } : {}),
    };
    if (options.expectJson && result.stdout.trim().length > 0) {
      try {
        result.json = JSON.parse(result.stdout);
      } catch (error) {
        const preview = result.stdout.slice(0, 500);
        throw new Error(`Failed to parse in-process CLI JSON stdout for args ${JSON.stringify(args)}: ${String(error)}\nstdout: ${preview}`);
      }
    }
    return result;
  });
}
