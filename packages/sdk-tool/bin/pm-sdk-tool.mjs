#!/usr/bin/env node
/**
 * @module packages/sdk-tool/bin
 *
 * Provides an executable shell around the SDK-only custom-tool exemplar.
 */
import {
  initializeCustomTool,
  runCustomToolDemo,
} from "../index.mjs";

const [command, pmRoot, artifactPath] = process.argv.slice(2);

if (!command || !pmRoot || !["init", "demo"].includes(command)) {
  console.error(
    "Usage: pm-sdk-tool <init|demo> <absolute-pm-root> [artifact-path]",
  );
  process.exitCode = 2;
} else {
  try {
    const result =
      command === "init"
        ? await initializeCustomTool(pmRoot)
        : await runCustomToolDemo({
            pmRoot,
            ...(artifactPath === undefined ? {} : { artifactPath }),
          });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
