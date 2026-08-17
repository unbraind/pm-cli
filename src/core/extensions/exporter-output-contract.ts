/**
 * @module core/extensions/exporter-output-contract
 *
 * Validates SDK-declared exporter artifact channels independently from extension activation.
 */
import type {
  CommandHandlerContext,
  ExporterRegistrationOptions,
  ImportExportContext,
  RegisteredExporterArtifactOutputContract,
} from "./extension-types.js";
import { cloneContextSnapshot } from "./extension-runtime-helpers.js";
import {
  asRegistrationRecord,
  assertOptionalStringField,
} from "./registration-validation.js";

/** Validates and normalizes the public artifact-channel metadata for one exporter registration. */
export function normalizeExporterArtifactOutput(
  value: unknown,
): RegisteredExporterArtifactOutputContract {
  const candidate = asRegistrationRecord(
    "registerExporter options.output",
    value,
  );
  if (candidate.channel !== "stdout" && candidate.channel !== "file") {
    throw new TypeError(
      "registerExporter options.output.channel must be stdout|file",
    );
  }
  if (
    candidate.receipt !== undefined &&
    candidate.receipt !== "suppress" &&
    candidate.receipt !== "render"
  ) {
    throw new TypeError(
      "registerExporter options.output.receipt must be suppress|render",
    );
  }
  assertOptionalStringField(
    "registerExporter options.output.media_type",
    candidate.media_type,
  );
  return {
    channel: candidate.channel,
    receipt:
      candidate.receipt ??
      (candidate.channel === "stdout" ? "suppress" : "render"),
    ...(typeof candidate.media_type === "string"
      ? { media_type: candidate.media_type }
      : {}),
  };
}

/** Enforces importer/exporter channel ownership and applies the stdout-specific derived description. */
export function resolveImportExportArtifactOutput(
  method: "registerImporter" | "registerExporter",
  resolvedOptions: ExporterRegistrationOptions,
  descriptionWasDeclared: boolean,
): RegisteredExporterArtifactOutputContract | undefined {
  if (method === "registerImporter" && resolvedOptions.output !== undefined) {
    throw new TypeError("registerImporter options.output is exporter-only");
  }
  if (method !== "registerExporter" || resolvedOptions.output === undefined) {
    return undefined;
  }
  const output = normalizeExporterArtifactOutput(resolvedOptions.output);
  if (!descriptionWasDeclared && output.channel === "stdout") {
    resolvedOptions.description =
      "Export items with the registered extension adapter. Artifact bytes are written exclusively to stdout and the host receipt is suppressed by default.";
  }
  return output;
}

/** Snapshots a host command invocation into the stable importer/exporter context contract. */
export function buildImportExportContext(
  context: CommandHandlerContext,
  registration: string,
  action: "import" | "export",
): ImportExportContext {
  return {
    registration,
    action,
    command: context.command,
    args: cloneContextSnapshot(context.args),
    options: cloneContextSnapshot(context.options),
    global: cloneContextSnapshot(context.global),
    pm_root: context.pm_root,
    source_workspace_root: context.source_workspace_root,
    repo_root: context.repo_root,
    pm_root_rel: context.pm_root_rel,
    ...(context.sdk === undefined ? {} : { sdk: context.sdk }),
  };
}
