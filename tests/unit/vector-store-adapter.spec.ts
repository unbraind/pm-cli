import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import {
  buildVectorDeletePlan,
  buildVectorQueryPlan,
  buildVectorUpsertPlan,
  executeVectorDelete,
  executeVectorQuery,
  executeVectorUpsert,
  resolveVectorStoreRequestTarget,
  resolveVectorStores,
} from "../../src/core/search/vector-stores.js";
import type { PmSettings } from "../../src/types.js";

function makeSettings(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

describe("resolveVectorStores", () => {
  it("returns no active store when qdrant and lancedb settings are empty", () => {
    const result = resolveVectorStores(makeSettings());
    expect(result.active).toBeNull();
    expect(result.available).toEqual([]);
  });

  it("resolves Qdrant and trims configured fields", () => {
    const settings = makeSettings();
    settings.vector_store.qdrant.url = " https://qdrant.example.test:6333/ ";
    settings.vector_store.qdrant.api_key = " secret-key ";

    const result = resolveVectorStores(settings);
    expect(result.active).toEqual({
      name: "qdrant",
      url: "https://qdrant.example.test:6333/",
      api_key: "secret-key",
    });
    expect(result.available).toEqual([result.active]);
  });

  it("falls back to LanceDB when Qdrant is incomplete", () => {
    const settings = makeSettings();
    settings.vector_store.qdrant.url = "";
    settings.vector_store.lancedb.path = " /tmp/lance-index ";

    const result = resolveVectorStores(settings);
    expect(result.active).toEqual({
      name: "lancedb",
      path: "/tmp/lance-index",
    });
    expect(result.available).toEqual([result.active]);
  });

  it("returns deterministic Qdrant-then-LanceDB order when both are configured", () => {
    const settings = makeSettings();
    settings.vector_store.qdrant.url = "https://qdrant.example.test";
    settings.vector_store.lancedb.path = "/tmp/lance-index";

    const malformedInput = settings as unknown as {
      vector_store: {
        qdrant: { url: unknown; api_key: unknown };
        lancedb: { path: unknown };
      };
    };
    malformedInput.vector_store.qdrant.api_key = 123;

    const result = resolveVectorStores(malformedInput);
    expect(result.available).toEqual([
      {
        name: "qdrant",
        url: "https://qdrant.example.test",
      },
      {
        name: "lancedb",
        path: "/tmp/lance-index",
      },
    ]);
    expect(result.active).toEqual(result.available[0]);
  });
});

describe("resolveVectorStoreRequestTarget", () => {
  it("builds deterministic Qdrant and LanceDB request targets", () => {
    expect(
      resolveVectorStoreRequestTarget({
        name: "qdrant",
        url: "https://qdrant.example.test:6333/",
      }),
    ).toEqual({
      store: "qdrant",
      query_target: "https://qdrant.example.test:6333/collections/pm_items/points/search",
      upsert_target: "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
    });

    expect(
      resolveVectorStoreRequestTarget({
        name: "lancedb",
        path: "/tmp/lance index",
      }),
    ).toEqual({
      store: "lancedb",
      query_target: "lancedb://%2Ftmp%2Flance%20index#pm_items",
      upsert_target: "lancedb://%2Ftmp%2Flance%20index#pm_items",
    });
  });
});

describe("buildVectorQueryPlan", () => {
  it("builds Qdrant and LanceDB query plans", () => {
    expect(
      buildVectorQueryPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
          api_key: "secret-key",
        },
        [0.1, 0.2, 0.3],
        7.9,
      ),
    ).toEqual({
      target: {
        store: "qdrant",
        query_target: "https://qdrant.example.test/collections/pm_items/points/search",
        upsert_target: "https://qdrant.example.test/collections/pm_items/points?wait=true",
      },
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": "secret-key",
      },
      body: {
        vector: [0.1, 0.2, 0.3],
        limit: 7,
        with_payload: true,
      },
    });

    expect(
      buildVectorQueryPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [9, 8],
        2,
      ).headers,
    ).toEqual({
      "content-type": "application/json",
    });

    expect(
      buildVectorQueryPlan(
        {
          name: "lancedb",
          path: "/tmp/lancedb",
        },
        [1, 2],
        4,
      ),
    ).toEqual({
      target: {
        store: "lancedb",
        query_target: "lancedb://%2Ftmp%2Flancedb#pm_items",
        upsert_target: "lancedb://%2Ftmp%2Flancedb#pm_items",
      },
      method: "LOCAL",
      headers: {},
      body: {
        table: "pm_items",
        vector: [1, 2],
        limit: 4,
      },
    });
  });

  it("rejects invalid vectors and limits", () => {
    expect(() =>
      buildVectorQueryPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [],
        5,
      ),
    ).toThrow("Vector values must be a non-empty numeric array");

    expect(() =>
      buildVectorQueryPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [1, 2],
        0,
      ),
    ).toThrow("Vector query limit must be a positive number");
  });
});

describe("buildVectorUpsertPlan", () => {
  it("builds Qdrant and LanceDB upsert plans", () => {
    expect(
      buildVectorUpsertPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [{ id: "pm-a1", vector: [0.4, 0.5], payload: { type: "Task" } }],
      ),
    ).toEqual({
      target: {
        store: "qdrant",
        query_target: "https://qdrant.example.test/collections/pm_items/points/search",
        upsert_target: "https://qdrant.example.test/collections/pm_items/points?wait=true",
      },
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: {
        points: [{ id: "pm-a1", vector: [0.4, 0.5], payload: { type: "Task" } }],
      },
    });

    expect(
      buildVectorUpsertPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
          api_key: "secret-upsert-key",
        },
        [{ id: "pm-a2", vector: [0.9] }],
      ).headers,
    ).toEqual({
      "content-type": "application/json",
      "api-key": "secret-upsert-key",
    });

    expect(
      buildVectorUpsertPlan(
        {
          name: "lancedb",
          path: "/tmp/lance",
        },
        [{ id: "pm-b2", vector: [0.6, 0.7] }],
      ),
    ).toEqual({
      target: {
        store: "lancedb",
        query_target: "lancedb://%2Ftmp%2Flance#pm_items",
        upsert_target: "lancedb://%2Ftmp%2Flance#pm_items",
      },
      method: "LOCAL",
      headers: {},
      body: {
        table: "pm_items",
        records: [{ id: "pm-b2", vector: [0.6, 0.7] }],
      },
    });
  });

  it("rejects invalid upsert record shapes", () => {
    expect(() =>
      buildVectorUpsertPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [],
      ),
    ).toThrow("Vector upsert records must include at least one entry");

    expect(() =>
      buildVectorUpsertPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [{ id: "", vector: [1] }],
      ),
    ).toThrow("Vector upsert record at index 0 is missing a non-empty id");

    expect(() =>
      buildVectorUpsertPlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [{ id: "pm-bad", vector: [1], payload: [] as unknown as Record<string, unknown> }],
      ),
    ).toThrow("Vector upsert record at index 0 must provide payload as an object when set");
  });
});

describe("buildVectorDeletePlan", () => {
  it("builds Qdrant and LanceDB delete plans with deterministic ids", () => {
    expect(
      buildVectorDeletePlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
          api_key: "delete-key",
        },
        ["pm-b2", "pm-a1", "pm-a1"],
      ),
    ).toEqual({
      target: {
        store: "qdrant",
        query_target: "https://qdrant.example.test/collections/pm_items/points/search",
        upsert_target: "https://qdrant.example.test/collections/pm_items/points?wait=true",
      },
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": "delete-key",
      },
      body: {
        points: ["pm-a1", "pm-b2"],
      },
    });

    expect(
      buildVectorDeletePlan(
        {
          name: "lancedb",
          path: "/tmp/lance-delete",
        },
        ["pm-c3", "pm-a1"],
      ),
    ).toEqual({
      target: {
        store: "lancedb",
        query_target: "lancedb://%2Ftmp%2Flance-delete#pm_items",
        upsert_target: "lancedb://%2Ftmp%2Flance-delete#pm_items",
      },
      method: "LOCAL",
      headers: {},
      body: {
        table: "pm_items",
        ids: ["pm-a1", "pm-c3"],
      },
    });
  });

  it("rejects invalid delete id shapes", () => {
    expect(() =>
      buildVectorDeletePlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [],
      ),
    ).toThrow("Vector delete ids must include at least one entry");

    expect(() =>
      buildVectorDeletePlan(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [""],
      ),
    ).toThrow("Vector delete id at index 0 is missing a non-empty value");
  });
});

describe("executeVectorQuery", () => {
  it("executes deterministic Qdrant query requests and normalizes response rows", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const result = await executeVectorQuery(
      {
        name: "qdrant",
        url: "https://qdrant.example.test:6333",
        api_key: "key-query",
      },
      [0.11, 0.22],
      3,
      {
        fetcher: async (url, init) => {
          calls.push({ url, body: init.body });
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: [
                { id: "pm-b2", score: 0.33 },
                { id: "pm-a2", score: 0.91 },
                { id: 42, score: 0.91, payload: { kind: "Task" } },
              ],
            }),
            text: async () => "",
          };
        },
      },
    );

    expect(calls).toEqual([
      {
        url: "https://qdrant.example.test:6333/collections/pm_items/points/search",
        body: JSON.stringify({
          vector: [0.11, 0.22],
          limit: 3,
          with_payload: true,
        }),
      },
    ]);
    expect(result).toEqual([
      { id: "42", score: 0.91, payload: { kind: "Task" } },
      { id: "pm-a2", score: 0.91 },
      { id: "pm-b2", score: 0.33 },
    ]);
  });

  it("uses global fetch when no explicit fetcher is provided", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      expect(init?.method).toBe("POST");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ result: [{ id: "pm-a1", score: 1 }] }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      const result = await executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [1, 2],
        1,
      );
      expect(calls).toEqual(["https://qdrant.example.test/collections/pm_items/points/search"]);
      expect(result).toEqual([{ id: "pm-a1", score: 1 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails when no fetch implementation is available", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = undefined as unknown as typeof globalThis.fetch;
    try {
      await expect(
        executeVectorQuery(
          {
            name: "qdrant",
            url: "https://qdrant.example.test",
          },
          [1],
          1,
        ),
      ).rejects.toThrow("Vector request execution requires a fetch implementation");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executes deterministic LanceDB local query helpers and validates remote timeout input", async () => {
    const localPath = `/tmp/lancedb-local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await expect(
      executeVectorUpsert(
        {
          name: "lancedb",
          path: localPath,
        },
        [
          { id: "pm-b2", vector: [0.2, 0.1], payload: { kind: "Task" } },
          { id: "pm-a1", vector: [0.8, 0.2] },
          { id: "pm-a1", vector: [0.9, 0.1], payload: { kind: "Epic" } },
        ],
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      executeVectorQuery(
        {
          name: "lancedb",
          path: `${localPath}-empty`,
        },
        [1, 0],
        3,
      ),
    ).resolves.toEqual([]);

    const localHits = await executeVectorQuery(
      {
        name: "lancedb",
        path: localPath,
      },
      [1, 0],
      3,
      {
        fetcher: async () => {
          throw new Error("should not execute");
        },
      },
    );
    expect(localHits.map((hit) => hit.id)).toEqual(["pm-a1", "pm-b2"]);
    expect(localHits[0]?.score).toBeCloseTo(0.9);
    expect(localHits[1]?.score).toBeCloseTo(0.2);
    expect(localHits[0]?.payload).toEqual({ kind: "Epic" });

    const tiePath = `${localPath}-tie`;
    await expect(
      executeVectorUpsert(
        {
          name: "lancedb",
          path: tiePath,
        },
        [
          { id: "pm-b1", vector: [0.5, 9] },
          { id: "pm-a1", vector: [0.5, 7] },
        ],
      ),
    ).resolves.toEqual({ status: "ok" });
    await expect(
      executeVectorQuery(
        {
          name: "lancedb",
          path: tiePath,
        },
        [1, 0],
        2,
      ),
    ).resolves.toMatchObject([
      { id: "pm-a1", score: 0.5 },
      { id: "pm-b1", score: 0.5 },
    ]);

    await expect(
      executeVectorQuery(
        {
          name: "lancedb",
          path: localPath,
        },
        [1, 0, 0],
        3,
      ),
    ).rejects.toThrow("dimension mismatch: expected 3, received 2");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [1, 2],
        3,
        {
          timeout_ms: 0,
          fetcher: async () => {
            throw new Error("should not execute");
          },
        },
      ),
    ).rejects.toThrow("Vector request timeout must be a positive finite number");
  });

  it("normalizes query execution, HTTP, parse, and shape failures", async () => {
    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          timeout_ms: 1,
          fetcher: async (_url, init) =>
            await new Promise((_, reject) => {
              init.signal.addEventListener("abort", () => {
                const abort = new Error(" ");
                abort.name = "AbortError";
                reject(abort);
              });
            }),
        },
      ),
    ).rejects.toThrow("Vector query request timed out after 1ms");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => {
            const abort = new Error(" ");
            abort.name = "AbortError";
            throw abort;
          },
        },
      ),
    ).rejects.toThrow("Vector query request timed out after 30000ms");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => {
                reject(404);
              }, 0);
            }),
        },
      ),
    ).rejects.toThrow("Vector query request execution failed: 404");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => {
            const named = new Error(" ");
            named.name = "FetchFailed";
            throw named;
          },
        },
      ),
    ).rejects.toThrow("Vector query request execution failed: FetchFailed");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => ({
            ok: false,
            status: 502,
            statusText: "Bad Gateway",
            json: async () => ({}),
            text: async () => " upstream down ",
          }),
        },
      ),
    ).rejects.toThrow("Vector query request failed with status 502 Bad Gateway: upstream down");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => ({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            json: async () => ({}),
            text: async () => {
              throw new Error("cannot read body");
            },
          }),
        },
      ),
    ).rejects.toThrow(
      "Vector query request failed with status 503 Service Unavailable: (failed to read response body: cannot read body)",
    );

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => {
              throw new Error("bad json");
            },
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Vector query response JSON parse failed: bad json");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: [{ id: "", score: 1 }] }),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Qdrant query response entry at index 0 is missing a non-empty id");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: [{ id: "pm-a1", score: "x" }] }),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Qdrant query response entry at index 0 is missing a finite numeric score");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: [{ id: "pm-a1", score: 1, payload: [] }] }),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Qdrant query response entry at index 0 must provide payload as an object when set");

    await expect(
      executeVectorQuery(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [0.2, 0.3],
        1,
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({}),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Qdrant query response must include a result array");
  });
});

describe("executeVectorUpsert", () => {
  it("executes deterministic Qdrant upsert requests and normalizes nested status", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const result = await executeVectorUpsert(
      {
        name: "qdrant",
        url: "https://qdrant.example.test",
        api_key: "upsert-key",
      },
      [{ id: "pm-a1", vector: [0.7], payload: { kind: "Task" } }],
      {
        fetcher: async (url, init) => {
          calls.push({ url, body: init.body });
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                status: "acknowledged",
              },
            }),
            text: async () => "",
          };
        },
      },
    );

    expect(calls).toEqual([
      {
        url: "https://qdrant.example.test/collections/pm_items/points?wait=true",
        body: JSON.stringify({
          points: [{ id: "pm-a1", vector: [0.7], payload: { kind: "Task" } }],
        }),
      },
    ]);
    expect(result).toEqual({ status: "acknowledged" });
  });

  it("supports top-level status response and normalizes failures", async () => {
    await expect(
      executeVectorUpsert(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [{ id: "pm-a1", vector: [0.7] }],
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ status: "ok" }),
            text: async () => "",
          }),
        },
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      executeVectorUpsert(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [{ id: "pm-a1", vector: [0.7] }],
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: {} }),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Qdrant upsert response must include status metadata");

    await expect(
      executeVectorUpsert(
        {
          name: "lancedb",
          path: "/tmp/lance",
        },
        [{ id: "pm-a1", vector: [0.7] }],
        {
          fetcher: async () => {
            throw new Error("should not execute");
          },
        },
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      executeVectorUpsert(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        [{ id: "pm-a1", vector: [0.7] }],
        {
          fetcher: async () => ({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            json: async () => ({}),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Vector upsert request failed with status 500 Internal Server Error");
  });
});

describe("executeVectorDelete", () => {
  it("executes deterministic Qdrant delete requests and normalizes status", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const result = await executeVectorDelete(
      {
        name: "qdrant",
        url: "https://qdrant.example.test",
        api_key: "delete-key",
      },
      ["pm-b2", "pm-a1", "pm-a1"],
      {
        fetcher: async (url, init) => {
          calls.push({ url, body: init.body });
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          };
        },
      },
    );

    expect(calls).toEqual([
      {
        url: "https://qdrant.example.test/collections/pm_items/points/delete?wait=true",
        body: JSON.stringify({
          points: ["pm-a1", "pm-b2"],
        }),
      },
    ]);
    expect(result).toEqual({ status: "acknowledged" });
  });

  it("supports LanceDB local deletion and normalizes remote failures", async () => {
    const localPath = `/tmp/lancedb-delete-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await expect(
      executeVectorDelete(
        {
          name: "lancedb",
          path: `${localPath}-missing`,
        },
        ["pm-a1"],
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      executeVectorUpsert(
        {
          name: "lancedb",
          path: localPath,
        },
        [
          { id: "pm-a1", vector: [1, 0] },
          { id: "pm-b2", vector: [0, 1] },
        ],
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      executeVectorDelete(
        {
          name: "lancedb",
          path: localPath,
        },
        ["pm-b2"],
        {
          fetcher: async () => {
            throw new Error("should not execute");
          },
        },
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      executeVectorQuery(
        {
          name: "lancedb",
          path: localPath,
        },
        [1, 0],
        5,
      ),
    ).resolves.toEqual([{ id: "pm-a1", score: 1 }]);

    await expect(
      executeVectorDelete(
        {
          name: "lancedb",
          path: localPath,
        },
        ["pm-a1"],
      ),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      executeVectorQuery(
        {
          name: "lancedb",
          path: localPath,
        },
        [1, 0],
        5,
      ),
    ).resolves.toEqual([]);

    await expect(
      executeVectorDelete(
        {
          name: "qdrant",
          url: "https://qdrant.example.test",
        },
        ["pm-a1"],
        {
          fetcher: async () => ({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            json: async () => ({}),
            text: async () => "",
          }),
        },
      ),
    ).rejects.toThrow("Vector delete request failed with status 500 Internal Server Error");
  });
});
