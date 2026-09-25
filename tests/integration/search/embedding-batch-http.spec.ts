import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { executeEmbeddingBatchesWithRetry } from "../../../src/sdk/query.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

/** Start a real provider endpoint that records payloads and can refuse dispatches. */
async function providerServer(maxInputs = 32, failure?: { status: number; body: string }) {
  const requests: Array<{ bytes: number; inputs: string[] }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const payload = JSON.parse(body.toString()) as { input: string[] };
    requests.push({ bytes: body.length, inputs: payload.input });
    if (failure) {
      response.writeHead(failure.status).end(failure.body);
      return;
    }
    if (payload.input.length > maxInputs) {
      response.writeHead(413).end("payload too large");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ embeddings: payload.input.map((input) => [input.length, input.codePointAt(0)]) }));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server");
  return {
    provider: { name: "ollama" as const, model: "test-embedding", base_url: `http://127.0.0.1:${address.port}` },
    requests,
  };
}

const settings = {
  ...SETTINGS_DEFAULTS,
  search: { ...SETTINGS_DEFAULTS.search, embedding_batch_size: 32, scanner_max_batch_retries: 0 },
};

describe("embedding scheduling over real HTTP", () => {
  it("does not split an HTTP failure merely because its body mentions timeout", async () => {
    const { provider, requests } = await providerServer(32, { status: 500, body: "upstream timeout" });
    await expect(executeEmbeddingBatchesWithRetry(provider, settings, ["alpha", "beta"])).rejects.toThrow("500");
    expect(requests.map((request) => request.inputs)).toEqual([["alpha", "beta"]]);
  });

  it("does not split a successful HTTP response with an invalid embedding payload", async () => {
    const { provider, requests } = await providerServer(32, { status: 200, body: '{"embeddings":[]}' });
    await expect(executeEmbeddingBatchesWithRetry(provider, settings, ["alpha", "beta"])).rejects.toThrow("Ollama embedding response must include embedding or embeddings vectors");
    expect(requests).toHaveLength(1);
  });

  it("sends 32 rich inputs in one request and reports effective work", async () => {
    const { provider, requests } = await providerServer();
    const inputs = Array.from({ length: 32 }, (_, index) => String.fromCodePoint(65 + index).repeat(3200));
    const result = await executeEmbeddingBatchesWithRetry(provider, settings, inputs);
    expect(requests).toHaveLength(1);
    expect(result.vectors).toEqual(inputs.map((input) => [3200, input.codePointAt(0)]));
    expect(result.receipt).toMatchObject({ planned_batches: 1, requests: 1, successful_batches: 1, split_batches: 0, retries: 0, batch_size_histogram: { 32: 1 }, limit_source: "default" });
    expect(result.receipt?.inputs_per_second).toBeGreaterThan(0);
  });

  it("bounds encoded JSON bytes including Unicode and escaping", async () => {
    const { provider, requests } = await providerServer();
    const inputs = ["界".repeat(100), '"'.repeat(100), "\\".repeat(100), "z".repeat(100)];
    const result = await executeEmbeddingBatchesWithRetry(provider, settings, inputs, { maxRequestBytes: 450 });
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.bytes <= 450)).toBe(true);
    expect(result.vectors).toEqual(inputs.map((input) => [100, input.codePointAt(0)]));
    expect(result.receipt).toMatchObject({ limit_source: "caller", max_request_bytes: 450 });
  });

  it("splits HTTP 413 failures and preserves input positions including duplicates", async () => {
    const { provider, requests } = await providerServer(1);
    const result = await executeEmbeddingBatchesWithRetry(provider, settings, ["alpha", "beta", "alpha"]);
    expect(result.vectors).toEqual([[5, 97], [4, 98], [5, 97]]);
    expect(requests.map((request) => request.inputs.length)).toEqual([2, 2, 1, 1, 1]);
    expect(result.receipt).toMatchObject({ requests: 5, successful_batches: 3, split_batches: 2, retries: 0 });
    expect(result.warnings[0]).toContain("split_after_payload_too_large");
  });

  it("refuses impossible or invalid request budgets before dispatch", async () => {
    const { provider, requests } = await providerServer();
    for (const maxRequestBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(executeEmbeddingBatchesWithRetry(provider, settings, ["test"], { maxRequestBytes })).rejects.toThrow("positive safe integer");
    }
    await expect(executeEmbeddingBatchesWithRetry(provider, settings, ["界".repeat(100)], { maxRequestBytes: 100 })).rejects.toThrow("exceeds request byte ceiling");
    await expect(executeEmbeddingBatchesWithRetry(provider, settings, ["alpha", " "])).rejects.toThrow("non-empty strings");
    await expect(executeEmbeddingBatchesWithRetry(provider, settings, [" ".repeat(5000)])).rejects.toThrow("non-empty strings");
    expect(requests).toEqual([]);
  });
});
