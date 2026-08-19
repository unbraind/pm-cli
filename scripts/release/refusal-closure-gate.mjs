#!/usr/bin/env node

/** Execute closed-domain refusal retries and score their recovery closure. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { scorePmRefusalClosure } from "../../dist/sdk/agent/refusal-closure.js";

const PROBES = Object.freeze([
  {
    probe_id: "context-invalid-intent",
    args: ["context", "--for", "not-a-declared-intent"],
  },
  {
    probe_id: "list-invalid-intent",
    args: ["list", "--for", "not-a-declared-intent"],
  },
  {
    probe_id: "next-invalid-intent",
    args: ["next", "--for", "not-a-declared-intent"],
  },
  {
    probe_id: "list-invalid-field",
    args: ["list", "--fields", "not-a-declared-field"],
  },
  {
    probe_id: "get-invalid-intent",
    args: ["get", "pm-domain", "--for", "not-a-declared-intent"],
  },
  {
    probe_id: "search-invalid-intent",
    args: ["search", "Domain query", "--for", "not-a-declared-intent"],
  },
  {
    probe_id: "get-invalid-field",
    args: ["get", "pm-domain", "--fields", "not-a-declared-field"],
  },
  {
    probe_id: "search-invalid-field",
    args: ["search", "Domain query", "--fields", "not-a-declared-field"],
  },
]);

/** Execute the real core CLI refusal corpus in an isolated tracker. */
export function verifyExecutableRefusalClosure({
  injectMismatch = false,
  probes = PROBES,
  spawn = spawnSync,
  makeTemporaryDirectory = mkdtempSync,
  removeDirectory = rmSync,
} = {}) {
  const root = makeTemporaryDirectory(
    path.join(tmpdir(), "pm-refusal-closure-"),
  );
  try {
    const environment = {
      ...process.env,
      PM_PATH: path.join(root, "project"),
      PM_GLOBAL_PATH: path.join(root, "global"),
      PM_TELEMETRY_DISABLED: "1",
    };
    const initialized = spawn(
      process.execPath,
      ["dist/cli.js", "init", "--defaults", "--json"],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    if (initialized.status !== 0) {
      throw new Error(`Refusal closure tracker setup failed: ${initialized.stderr}`);
    }
    const seeded = spawn(
      process.execPath,
      [
        "dist/cli.js",
        "create",
        "--id",
        "pm-domain",
        "--title",
        "Domain query target",
        "--json",
      ],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    if (seeded.status !== 0) {
      throw new Error(`Refusal closure item setup failed: ${seeded.stderr}`);
    }
    const observations = probes.map(({ probe_id: probeId, args }) => {
      const rejectedValue = args.at(-1);
      const refusal = spawn(
        process.execPath,
        ["dist/cli.js", ...args, "--json"],
        { cwd: process.cwd(), env: environment, encoding: "utf8" },
      );
      const envelope = JSON.parse(refusal.stderr);
      const recovery = envelope.recovery ?? {};
      const suggestedRetry =
        typeof recovery.suggested_retry === "string"
          ? recovery.suggested_retry
          : "";
      const retryArguments =
        Array.isArray(recovery.suggested_retry_args) &&
        recovery.suggested_retry_args.every(
          (argument) => typeof argument === "string",
        )
          ? recovery.suggested_retry_args
        : [];
      const retry = retryArguments.length > 0
        ? spawn(
            process.execPath,
            ["dist/cli.js", ...retryArguments, "--json"],
            { cwd: process.cwd(), env: environment, encoding: "utf8" },
          )
        : { status: 1 };
      return {
        probe_id: probeId,
        entrypoint: `pm ${args.join(" ")}`,
        exit_code: refusal.status ?? 1,
        rejected_value: rejectedValue ?? "",
        allowed_values: Array.isArray(recovery.allowed_values)
          ? recovery.allowed_values.filter(
              (value) => typeof value === "string",
            )
          : [],
        suggested_retry: suggestedRetry,
        retry_succeeded: retry.status === 0,
      };
    });
    if (injectMismatch) observations[0].allowed_values = [];
    return scorePmRefusalClosure(observations);
  } finally {
    removeDirectory(root, { recursive: true, force: true });
  }
}

/** Run the standalone repository gate. */
export function main(argv = process.argv.slice(2)) {
  const report = verifyExecutableRefusalClosure({
    injectMismatch: argv.includes("--inject-mismatch"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

/** Run the gate only when this module is the invoked Node entrypoint. */
export function runIfMain(candidate = process.argv[1]) {
  if (candidate && pathToFileURL(candidate).href === import.meta.url) main();
}

runIfMain();
