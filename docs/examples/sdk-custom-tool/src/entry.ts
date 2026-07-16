#!/usr/bin/env node
/**
 * @module docs/examples/sdk-custom-tool/entry
 *
 * Connects the process-independent SDK exemplar adapter to Node.js process
 * arguments, author identity, output streams, and exit status.
 */
import { runUniversalToolCli } from "./cli.ts";

process.exitCode = await runUniversalToolCli(
  process.argv.slice(2),
  process.env.PM_AUTHOR,
  (value) => process.stdout.write(value),
  (value) => process.stderr.write(value),
);
