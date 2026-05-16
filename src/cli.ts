#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  if (args.length !== 1 || (args[0] !== "--version" && args[0] !== "-V")) {
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
  await import("./cli/main.js");
}
