import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExtension } from "../../../src/sdk/extension.js";
import { runAction } from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

afterEach(() => vi.unstubAllEnvs());

/** Install a fixture extension and record it as managed from a fake npm package; returns the state path and its bytes. */
async function installManagedNpmFixture(context: { tempRoot: string; pmPath: string }): Promise<{ managedPath: string; before: string }> {
  const fixture = path.join(context.tempRoot, "freshness-extension");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "manifest.json"), JSON.stringify({ name: "freshness-extension", version: "1.0.0", entry: "index.mjs", capabilities: ["commands"] }));
  await writeFile(path.join(fixture, "index.mjs"), "export function activate(api) { api.registerCommand({ name: 'freshness-probe', description: 'Freshness fixture', run: () => ({ ok: true }) }); }\n");
  await runExtension(fixture, { install: true, project: true }, { path: context.pmPath });
  const managedPath = path.join(context.pmPath, "extensions", ".managed-extensions.json");
  const state = JSON.parse(await readFile(managedPath, "utf8"));
  state.entries[0].source = { kind: "npm", input: "npm:freshness-registry-package", location: "freshness-registry-package", package: "freshness-registry-package", version: "1.0.0" };
  state.entries[0].contributions.commands.push("z-before-a", "a-after-z");
  const before = JSON.stringify(state);
  await writeFile(managedPath, before);
  return { managedPath, before };
}

type RegistryMode = "update-available" | "up-to-date" | "unavailable";

/**
 * Serve one fake npm registry for `run`, pointing npm at it with the largest
 * lookup budget: a cold npm start on a Windows runner can exceed the 10 s
 * default (pm-5kfzjh). Each scenario performs one registry-backed lookup, so
 * it fits CI's 30-second per-test limit.
 */
async function withRegistry(mode: RegistryMode, run: (requests: () => number) => Promise<void>): Promise<void> {
  let requests = 0;
  const registry = createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    if (mode === "unavailable") { response.writeHead(404); response.end('{"error":"fixture_unavailable"}'); return; }
    response.end(JSON.stringify({ name: "freshness-registry-package", "dist-tags": { latest: mode === "update-available" ? "2.0.0" : "1.0.0" }, versions: { "1.0.0": { name: "freshness-registry-package", version: "1.0.0" }, "2.0.0": { name: "freshness-registry-package", version: "2.0.0" } } }));
  });
  // A denied loopback bind rejects instead of leaving the test waiting.
  await new Promise<void>((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(0, "127.0.0.1", () => {
      registry.off("error", reject);
      resolve();
    });
  });
  const address = registry.address();
  if (address === null || typeof address === "string") throw new Error("Registry did not bind a TCP port");
  vi.stubEnv("npm_config_registry", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS", "25000");
  try {
    await run(() => requests);
  } finally {
    registry.closeAllConnections();
    await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
  }
}

describe("managed extension diagnostic purity", () => {
  it("honors offline mode everywhere, then checks npm provenance transiently and preserves managed bytes and mtime", async () => {
    await withTempPmPath(async (context) => {
      const { managedPath, before } = await installManagedNpmFixture(context);
      const beforeStat = await stat(managedPath);
      await withRegistry("update-available", async (requests) => {
        for (const options of [{ explore: true }, { doctor: true }, { manage: true, offline: true }]) {
          await runExtension(undefined, { ...options, project: true }, { path: context.pmPath });
        }
        for (const action of ["extension", "package", "extension-manage", "package-manage"]) {
          expect(await runAction({ action, offline: true, path: context.pmPath, noExtensions: true, options: { manage: true, project: true } })).toMatchObject({
            details: { extensions: [{ update_check_status: "not_checked", update_check_reason: "offline_requested", update_available: null }] },
          });
        }
        expect(requests()).toBe(0);
        const managed = await runAction({ action: "package-manage", offline: true, path: context.pmPath, noExtensions: true, options: { project: true, offline: false } });
        expect(managed).toMatchObject({ details: { extensions: [{ source: { package: "freshness-registry-package", version: "1.0.0" }, update_check_status: "checked", update_available: true, last_update_remote_version: "2.0.0" }] } });
        expect(requests()).toBeGreaterThan(0);
      });
      expect(await readFile(managedPath, "utf8")).toBe(before);
      expect((await stat(managedPath)).mtimeMs).toBe(beforeStat.mtimeMs);
    });
  });

  it("reports an up-to-date package and then honors an offline override", async () => {
    await withTempPmPath(async (context) => {
      const { managedPath, before } = await installManagedNpmFixture(context);
      await withRegistry("up-to-date", async (requests) => {
        expect((await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath })).details).toMatchObject({ extensions: [{ update_check_status: "checked", update_available: false }] });
        const requestsBeforeOffline = requests();
        const offline = await runExtension(undefined, { manage: true, project: true, offline: true }, { path: context.pmPath });
        // The offline override never contacts the registry.
        expect(requests()).toBe(requestsBeforeOffline);
        expect(offline.details).toMatchObject({ extensions: [{ update_check_status: "not_checked", update_check_reason: "offline_requested", update_available: null }] });
      });
      expect(await readFile(managedPath, "utf8")).toBe(before);
    });
  });

  it("reports an unavailable registry as a failed lookup without a timeout budget", async () => {
    await withTempPmPath(async (context) => {
      const { managedPath, before } = await installManagedNpmFixture(context);
      await withRegistry("unavailable", async (requests) => {
        const failedLookup = (await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath })).details as { extensions: Record<string, unknown>[] };
        expect(failedLookup).toMatchObject({ extensions: [{ update_check_status: "failed", update_available: null, update_error: "npm_registry_lookup_failed" }] });
        expect(failedLookup.extensions[0]).not.toHaveProperty("update_check_timeout_ms");
        expect(requests()).toBeGreaterThan(0);
      });
      expect(await readFile(managedPath, "utf8")).toBe(before);
    });
  });

  it("reports a provider still running at its budget as a timeout, keeping the default budget under the state lock", async () => {
    await withTempPmPath(async (context) => {
      const { managedPath, before } = await installManagedNpmFixture(context);
      // A stalled npm on PATH makes this deterministic: no npm start-up time
      // decides the outcome, and no registry is contacted.
      const stalledBin = path.join(context.tempRoot, "stalled-npm-bin");
      const started = path.join(context.tempRoot, "stalled-npm-started");
      await mkdir(stalledBin);
      // Each invocation records that the fixture itself ran, then stalls.
      await writeFile(path.join(stalledBin, "npm"), '#!/bin/sh\necho started >> "$PM_STALLED_NPM_MARKER"\nsleep 30\n', { mode: 0o755 });
      await writeFile(path.join(stalledBin, "npm.cmd"), '@echo started>> "%PM_STALLED_NPM_MARKER%"\r\n@ping -n 31 127.0.0.1 >nul\r\n');
      vi.stubEnv("PM_STALLED_NPM_MARKER", started);
      vi.stubEnv("PATH", `${stalledBin}${path.delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS", "2000");
      const stalledStarted = Date.now();
      expect((await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath })).details).toMatchObject({ extensions: [{ update_check_status: "failed", update_check_reason: "npm_registry_lookup_timed_out", update_available: null, update_error: "npm_registry_lookup_timed_out", update_check_timeout_ms: 2000 }] });
      expect(Date.now() - stalledStarted).toBeLessThan(10_000);
      expect(await readFile(managedPath, "utf8")).toBe(before);
      // --fix-managed-state runs its lookups under the extension state lock,
      // so it keeps the default budget and ignores the raised override.
      const lockedStarted = Date.now();
      expect((await runExtension(undefined, { manage: true, project: true, fixManagedState: true }, { path: context.pmPath })).details).toMatchObject({ extensions: [{ update_check_status: "failed", update_error: "npm_registry_lookup_timed_out", update_check_timeout_ms: 10_000 }] });
      expect(Date.now() - lockedStarted).toBeGreaterThanOrEqual(9_000);
      expect((await readFile(started, "utf8")).trim().split(/\r?\n/u)).toHaveLength(2);
    });
  });
});
