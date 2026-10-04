import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runExtension } from "../../../src/sdk/extension.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("managed extension diagnostic purity", () => {
  it("checks npm provenance transiently, honors offline mode, and preserves managed bytes and mtime", async () => {
    await withTempPmPath(async (context) => {
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
      const beforeStat = await stat(managedPath);
      let requests = 0;
      let available = true;
      let registryFailure = false;
      const registry = createServer((_request, response) => {
        requests += 1;
        response.setHeader("content-type", "application/json");
        if (registryFailure) { response.writeHead(404); response.end('{"error":"fixture_unavailable"}'); return; }
        response.end(JSON.stringify({ name: "freshness-registry-package", "dist-tags": { latest: available ? "2.0.0" : "1.0.0" }, versions: { "1.0.0": { name: "freshness-registry-package", version: "1.0.0" }, "2.0.0": { name: "freshness-registry-package", version: "2.0.0" } } }));
      });
      await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
      const address = registry.address();
      if (address === null || typeof address === "string") throw new Error("Registry did not bind a TCP port");
      const previousRegistry = process.env.npm_config_registry;
      process.env.npm_config_registry = `http://127.0.0.1:${address.port}`;
      try {
        for (const options of [{ explore: true }, { doctor: true }, { manage: true, offline: true }]) {
          await runExtension(undefined, { ...options, project: true }, { path: context.pmPath });
        }
        expect(requests).toBe(0);
        const managed = await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath });
        expect(managed.details, JSON.stringify(managed.details)).toMatchObject({ extensions: [{ source: { package: "freshness-registry-package", version: "1.0.0" }, update_check_status: "checked", update_available: true, last_update_remote_version: "2.0.0" }] });
        available = false;
        expect((await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath })).details).toMatchObject({ extensions: [{ update_check_status: "checked", update_available: false }] });
        const offline = await runExtension(undefined, { manage: true, project: true, offline: true }, { path: context.pmPath });
        expect(offline.details).toMatchObject({ extensions: [{ update_check_status: "not_checked", update_check_reason: "offline_requested", update_available: null }] });
        registryFailure = true;
        expect((await runExtension(undefined, { manage: true, project: true }, { path: context.pmPath })).details).toMatchObject({ extensions: [{ update_check_status: "failed", update_available: null, update_error: "npm_registry_lookup_failed" }] });
        expect(requests).toBeGreaterThan(0);
        expect(await readFile(managedPath, "utf8")).toBe(before);
        expect((await stat(managedPath)).mtimeMs).toBe(beforeStat.mtimeMs);
      } finally {
        if (previousRegistry === undefined) delete process.env.npm_config_registry;
        else process.env.npm_config_registry = previousRegistry;
        await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
      }
    });
  });
});
