/** @module tests/integration/history-attestation-cli.integration */
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { buildPmActionToolInputSchema } from "../../src/sdk/cli-contracts/tool-schema.js";
import { parseHistoryAttestation } from "../../src/sdk/history/attestation.js";
import { PmClient, runAction } from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("detached history proof transports", () => {
  it("exchanges MCP proof data and refuses server-local proof paths in flat and nested arguments", async () => {
    expect(buildPmActionToolInputSchema("history-attest")).toMatchObject({ properties: {
      verify: { type: "object" }, output: { not: {} },
    } });
    await withTempPmPath(async (context) => {
      const itemsBefore = await runAction({ action: "list", path: context.pmPath });
      const proof = parseHistoryAttestation(await new PmClient({ pmRoot: context.pmPath }).historyAttest());
      const retained = path.join(context.tempRoot, "retained.json");
      await writeFile(retained, JSON.stringify(proof));
      for (const nested of [false, true]) {
        for (const options of [{ verify: retained }, { output: path.join(context.tempRoot, `forbidden-${nested}.json`) }]) {
          await expect(handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "pm_run", arguments: { action: "history-attest", path: context.pmPath, ...(nested ? { options } : options) },
          } })).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("MCP history attest") });
        }
        expect(await readdir(context.tempRoot)).not.toContain(`forbidden-${nested}.json`);
        const verified = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "pm_run", arguments: { action: "history-attest", path: context.pmPath, ...(nested ? { options: { verify: proof } } : { verify: proof }) },
        } });
        expect(verified).toMatchObject({ structuredContent: { result: { ok: true } } });
      }
      const exported = await handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "pm_run", arguments: { action: "history-attest", path: context.pmPath },
      } });
      expect(exported).toMatchObject({ structuredContent: { result: { format: "pm-history-attestation", streams: [] } } });
      expect(await new PmClient({ pmRoot: context.pmPath }).historyAttest({ verify: retained })).toMatchObject({ ok: true });
      expect(await readFile(retained, "utf8")).toBe(JSON.stringify(proof));
      expect(await runAction({ action: "list", path: context.pmPath })).toEqual(itemsBefore);
    });
  });

  it("exports complete evidence, verifies with CLI and SDK, and refuses overwritten output", async () => {
    await withTempPmPath(async (context) => {
      context.runCli(["create", "--title", "portable proof", "--json"], { expectJson: true });
      const output = path.join(context.tempRoot, "proof.json");
      const before = await readdir(context.pmPath);
      const sdkOutput = path.join(context.tempRoot, "sdk-proof.json");
      const sdkClient = new PmClient({ pmRoot: context.pmPath });
      expect(await sdkClient.historyAttest({ output: sdkOutput })).toMatchObject({ output: sdkOutput, streams: 1 });
      expect(parseHistoryAttestation(await sdkClient.historyAttest())).toMatchObject({ hash_algorithm: "sha256" });
      expect(await sdkClient.historyAttest({ verify: sdkOutput })).toMatchObject({ ok: true });
      await expect(sdkClient.historyAttest({ verify: sdkOutput, output: sdkOutput })).rejects.toThrow("cannot be combined");
      await expect(sdkClient.historyAttest({ verify: sdkOutput, hashAlgorithm: "sha512" })).rejects.toThrow("cannot be combined");
      const receipt = context.runCli(["history", "attest", "--output", output, "--hash-algorithm", "sha512", "--json"], { expectJson: true });
      expect(receipt.json).toMatchObject({ output });
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ hash_algorithm: "sha512" });
      const verified = context.runCli(["history", "attest", "--verify", output, "--json"], { expectJson: true });
      expect(verified, JSON.stringify(verified)).toMatchObject({ status: 0, json: { ok: true } });
      expect(await new PmClient({ pmRoot: context.pmPath }).historyAttest({ verify: output })).toMatchObject({ ok: true });
      expect(await runAction({ action: "history-attest", path: context.pmPath, options: { verify: output } })).toMatchObject({ ok: true });
      expect(await runAction({ action: "history-attest", path: context.pmPath, verify: output })).toMatchObject({ ok: true });
      for (const verify of [true, "", 42, null]) {
        await expect(runAction({ action: "history-attest", path: context.pmPath, options: { verify } })).rejects.toThrow("nonempty string");
      }
      const copiedTracker = path.join(context.tempRoot, "bare-tracker");
      await mkdir(copiedTracker);
      await cp(path.join(context.pmPath, "history"), path.join(copiedTracker, "history"), { recursive: true });
      const copyBefore = await readdir(copiedTracker, { recursive: true });
      expect(context.runCli(["--pm-path", copiedTracker, "history", "attest", "--verify", output, "--json"], { expectJson: true, cwd: context.tempRoot })).toMatchObject({ status: 0, json: { ok: true } });
      expect(await readdir(copiedTracker, { recursive: true })).toEqual(copyBefore);
      await Promise.all(Array.from({ length: 64 }, (_, index) => writeFile(path.join(copiedTracker, "history", `pm-empty-${index}.jsonl`), "")));
      const fullProof = context.runCli(["--pm-path", copiedTracker, "history", "attest"], { expectJson: true });
      expect(fullProof, JSON.stringify(fullProof)).toMatchObject({ status: 0 });
      expect(context.runCli(["history", "attest", "--output-limit", "1"]).status).not.toBe(0);
      expect(parseHistoryAttestation(fullProof.json).streams).toHaveLength(65);
      const original = await readFile(output, "utf8");
      expect(context.runCli(["history", "attest", "--output", output])).toMatchObject({ status: 2, stderr: expect.stringContaining("Cannot create history attestation proof") });
      expect(await readFile(output, "utf8")).toBe(original);
      const missing = path.join(context.tempRoot, "missing-proof.json");
      expect(context.runCli(["history", "attest", "--verify", missing])).toMatchObject({ status: 2, stderr: expect.stringContaining("Cannot read history attestation proof") });
      await writeFile(missing, "{");
      expect(context.runCli(["history", "attest", "--verify", missing])).toMatchObject({ status: 2, stderr: expect.stringContaining("Cannot read history attestation proof") });
      expect(context.runCli(["history", "attest", "--verify", output, "--hash-algorithm", "sha512"]).status).not.toBe(0);
      expect(await readdir(context.pmPath)).toEqual(before);
    });
  });
});
