/**
 * @module tests/types/sdk-evidence-traceability.test-d
 *
 * Compile-time proof that reverse evidence lookup and precise telemetry flush
 * receipts remain available from the supported public SDK entrypoint.
 */
import {
  PmClient,
  filesLookup,
  runFilesLookup,
  runTelemetry,
  type FilesLookupOptions,
  type FilesLookupResult,
  type GlobalOptions,
  type PmClientOptions,
  type TelemetryFlushResult,
} from "../../src/sdk/index.js";

const directLookup: (
  options: FilesLookupOptions,
  global: GlobalOptions,
) => Promise<FilesLookupResult> = runFilesLookup;
void directLookup;

const oneShotLookup: (
  options: FilesLookupOptions,
  clientOptions?: PmClientOptions,
) => Promise<FilesLookupResult> = filesLookup;
void oneShotLookup;

const client = new PmClient();
const clientResult: Promise<FilesLookupResult> = client.filesLookup({
  paths: ["src/sdk/files.ts"],
  limit: 20,
});
void clientResult;

const flushResult: Promise<TelemetryFlushResult> = runTelemetry(
  { subcommand: "flush" },
  {},
);
void flushResult;
