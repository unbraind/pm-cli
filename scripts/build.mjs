#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withBuildLease } from "./build-lease.mjs";

/** Run each build stage under one lease, retaining a failure marker until a complete rebuild. */
export async function main(root = process.cwd()) {
  if (process.env.PM_BUILD_CONSUMER_LEASE) {
    throw new Error("Cannot rebuild dist inside a validation consumer lease. Build before starting tests.");
  }
  return withBuildLease(root, async () => {
    const incomplete = path.join(root, ".cache", "build-incomplete");
    await writeFile(incomplete, "Build has not completed. Run pnpm build before consuming dist.\n");
    for (const args of [
      ["scripts/prepare-build-cache.mjs"],
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
      ["scripts/bundle-cli.mjs"],
      ["scripts/finalize-build.mjs"],
    ]) {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
        child.once("error", reject);
        child.once("close", (status, signal) => resolve(signal ? 1 : (status ?? 1)));
      });
      if (code !== 0) return code;
    }
    await rm(incomplete);
    return 0;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
