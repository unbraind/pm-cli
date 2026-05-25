#!/usr/bin/env node
import fs from "node:fs";
import * as nodeModule from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function enableNodeCompileCache(): void {
  const enableCompileCache = nodeModule.enableCompileCache as
    | ((cacheDir?: string) => { status?: number; message?: string })
    | undefined;
  if (typeof enableCompileCache !== "function" || process.env.PM_CLI_DISABLE_COMPILE_CACHE === "1") {
    return;
  }
  const userCacheKey =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : os.userInfo().username.replace(/[^a-zA-Z0-9._-]/g, "_");
  const cacheDir =
    process.env.PM_CLI_COMPILE_CACHE_DIR ?? path.join(os.tmpdir(), `pm-cli-node-compile-cache-${userCacheKey}`);
  try {
    enableCompileCache(cacheDir);
  } catch {
    // Compile caching is a startup optimization only; never block CLI execution.
  }
}

function findPackageJson(startPath: string): string | undefined {
  let current = path.dirname(path.resolve(startPath));
  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function printFastVersionIfRequested(): boolean {
  const args = process.argv.slice(2);
  const versionArgs = args.filter((arg) => arg !== "--no-extensions");
  if (versionArgs.length !== 1 || (versionArgs[0] !== "--version" && versionArgs[0] !== "-V")) {
    return false;
  }
  const packageJsonPath = findPackageJson(fileURLToPath(import.meta.url));
  if (!packageJsonPath) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string") {
      return false;
    }
    console.log(parsed.version);
    return true;
  } catch {
    return false;
  }
}

if (!printFastVersionIfRequested()) {
  enableNodeCompileCache();
  const { runPmCli } = await import("./cli/main.js");
  await runPmCli(process.argv.slice(2));
}
