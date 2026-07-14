/**
 * @module cli/bundle-integrity
 *
 * Diagnoses proven torn CLI bundle generations without hiding genuine module failures.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Describes one hashed output recorded in the generated CLI bundle manifest. */
export interface CliBundleManifestFile {
  /** Path relative to the directory containing the manifest. */
  path: string;
  /** Lowercase SHA-256 digest of the emitted file contents. */
  sha256: string;
}

/** Describes one atomic CLI bundle generation emitted by the build. */
export interface CliBundleManifest {
  /** Manifest schema generation. */
  schema_version: 1;
  /** Stable digest over the sorted file path and digest pairs. */
  generation: string;
  /** Complete set of JavaScript and source-map outputs in this generation. */
  files: CliBundleManifestFile[];
}

/** Captures a validated manifest together with its absolute on-disk path. */
export interface CliBundleManifestSnapshot {
  /** Absolute manifest path used for later file verification. */
  manifest_path: string;
  /** Validated manifest payload. */
  manifest: CliBundleManifest;
}

/** Reports a proven partial-upgrade or concurrent-build bundle failure. */
export interface CliBundleIntegrityDiagnostic {
  /** Stable machine-readable error code. */
  code: "bundle_integrity_torn_install";
  /** Actionable operator-facing recovery text. */
  message: string;
  /** Specific integrity proof that classified the failure. */
  reason: "generation_changed" | "manifest_missing" | "file_missing" | "hash_mismatch";
  /** Original module-loader failure text retained for diagnosis. */
  cause: string;
}

function isCliBundleManifest(value: unknown): value is CliBundleManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    schema_version?: unknown;
    generation?: unknown;
    files?: unknown;
  };
  return (
    candidate.schema_version === 1 &&
    typeof candidate.generation === "string" &&
    candidate.generation.length > 0 &&
    Array.isArray(candidate.files) &&
    candidate.files.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { sha256?: unknown }).sha256 === "string",
    )
  );
}

/** Reads the bundle manifest next to a compiled `dist/cli.js` entrypoint. */
export function readCliBundleManifestSnapshot(
  cliEntrypointPath: string,
): CliBundleManifestSnapshot | undefined {
  const manifestPath = path.join(
    path.dirname(path.resolve(cliEntrypointPath)),
    "cli-bundle",
    "bundle-manifest.json",
  );
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return isCliBundleManifest(parsed)
      ? { manifest_path: manifestPath, manifest: parsed }
      : undefined;
  } catch {
    return undefined;
  }
}

function inspectCurrentBundleIntegrity(
  initialSnapshot: CliBundleManifestSnapshot,
  cliEntrypointPath: string,
): CliBundleIntegrityDiagnostic["reason"] | undefined {
  const currentSnapshot = readCliBundleManifestSnapshot(cliEntrypointPath);
  if (!currentSnapshot) {
    return "manifest_missing";
  }
  if (
    currentSnapshot.manifest.generation !==
    initialSnapshot.manifest.generation
  ) {
    return "generation_changed";
  }
  const bundleRoot = path.dirname(currentSnapshot.manifest_path);
  for (const entry of currentSnapshot.manifest.files) {
    const filePath = path.resolve(bundleRoot, entry.path);
    if (!filePath.startsWith(`${bundleRoot}${path.sep}`)) {
      continue;
    }
    if (!fs.existsSync(filePath)) {
      return "file_missing";
    }
    const digest = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    if (digest !== entry.sha256) {
      return "hash_mismatch";
    }
  }
  return undefined;
}

/**
 * Returns a diagnostic only when a module-loader failure coincides with a changed,
 * missing, or hash-invalid bundle generation. Unproven module failures return
 * `undefined` so the original exception remains release-blocking.
 */
export function diagnoseCliBundleIntegrityFailure(
  error: unknown,
  initialSnapshot: CliBundleManifestSnapshot | undefined,
  cliEntrypointPath: string,
): CliBundleIntegrityDiagnostic | undefined {
  if (!initialSnapshot || !(error instanceof Error)) {
    return undefined;
  }
  const errorCode =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (
    errorCode !== "ERR_MODULE_NOT_FOUND" &&
    !/(?:cannot find module|does not provide an export named)/i.test(
      error.message,
    )
  ) {
    return undefined;
  }

  const reason = inspectCurrentBundleIntegrity(
    initialSnapshot,
    cliEntrypointPath,
  );
  return reason
    ? {
        code: "bundle_integrity_torn_install",
        message:
          "A partial pm CLI upgrade or concurrent rebuild changed the executable bundle. Reinstall @unbrained/pm-cli, then retry the command.",
        reason,
        cause: error.message,
      }
    : undefined;
}

/**
 * Loads and runs the CLI while converting only manifest-proven torn-bundle
 * failures into a handled recovery diagnostic.
 */
export async function runCliWithBundleIntegrity(
  args: string[],
  cliEntrypointPath: string,
  loadMain: () => Promise<{
    runPmCli: (invocationArgs: string[]) => Promise<void>;
  }>,
  writeStderr: (message: string) => void,
): Promise<void> {
  const initialBundleManifest =
    readCliBundleManifestSnapshot(cliEntrypointPath);
  try {
    const { runPmCli } = await loadMain();
    await runPmCli(args);
  } catch (error: unknown) {
    const diagnostic = diagnoseCliBundleIntegrityFailure(
      error,
      initialBundleManifest,
      cliEntrypointPath,
    );
    if (!diagnostic) {
      throw error;
    }
    writeStderr(
      `[pm] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.reason})\n`,
    );
    process.exitCode = 1;
  }
}
