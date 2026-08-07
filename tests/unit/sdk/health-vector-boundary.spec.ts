/**
 * @module health vector boundary tests
 *
 * Exercises health against an abort-aware provider that never produces a
 * response, proving both the default no-I/O path and explicit timeout bound.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import {
  readSettings,
  writeSettings,
} from "../../../src/core/store/settings.js";
import { runHealth } from "../../../src/sdk/governance/health.js";

const initialDisableAutoDefaults = process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;

describe("health vector provider boundary", () => {
  beforeEach(() => {
    process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = "1";
  });

  afterEach(() => {
    if (initialDisableAutoDefaults === undefined) {
      delete process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
    } else {
      process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = initialDisableAutoDefaults;
    }
  });

  it("never contacts a configured embedding provider by default", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "default health provider boundary",
      });
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://hanging.example.test/v1";
      settings.providers.openai.model = "fixture-embedding";
      settings.vector_store.qdrant.url = "https://vectors.example.test";
      await writeSettings(context.pmPath, settings);
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (() => {
        requests += 1;
        return new Promise(() => undefined);
      }) as typeof globalThis.fetch;
      try {
        const result = await runHealth(
          { path: context.pmPath },
          { skipIntegrity: true, skipDrift: true },
        );
        expect(requests).toBe(0);
        expect(
          result.checks.find((check) => check.name === "vectorization")
            ?.details,
        ).toMatchObject({
          stale_items_before: [id],
          refresh_attempted: false,
          refresh_skipped_reason: "refresh_disabled",
          refresh_policy: { enabled: false, no_refresh: true },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("bounds an explicitly requested vector refresh", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, {
        title: "explicit health provider boundary",
      });
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://hanging.example.test/v1";
      settings.providers.openai.model = "fixture-embedding";
      settings.vector_store.qdrant.url = "https://vectors.example.test";
      settings.search.embedding_timeout_ms = 25;
      settings.search.scanner_max_batch_retries = 0;
      await writeSettings(context.pmPath, settings);
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
        requests += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }) as typeof globalThis.fetch;
      try {
        const startedAt = performance.now();
        const result = await runHealth(
          { path: context.pmPath },
          {
            refreshVectors: true,
            skipIntegrity: true,
            skipDrift: true,
          },
        );
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(requests).toBe(1);
        expect(
          result.checks.find((check) => check.name === "vectorization")
            ?.details,
        ).toMatchObject({
          refresh_attempted: true,
          refresh_policy: { enabled: true, refresh_vectors: true },
        });
        expect(result.warnings).toContain(
          "vectorization_stale_items_remaining:1",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("reports an empty explicit refresh without contacting the provider", async () => {
    await withTempPmPath(async (context) => {
      const unavailable = await runHealth(
        { path: context.pmPath },
        {
          refreshVectors: true,
          skipIntegrity: true,
          skipDrift: true,
        },
      );
      expect(
        unavailable.checks.find((check) => check.name === "vectorization")
          ?.details,
      ).toMatchObject({
        stale_items_before: [],
        refresh_attempted: false,
        refresh_skipped_reason: "semantic_runtime_unavailable",
      });

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://unused.example.test/v1";
      settings.providers.openai.model = "fixture-embedding";
      settings.vector_store.qdrant.url = "https://unused-vectors.example.test";
      await writeSettings(context.pmPath, settings);
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (() => {
        requests += 1;
        return new Promise(() => undefined);
      }) as typeof globalThis.fetch;
      try {
        const result = await runHealth(
          { path: context.pmPath },
          {
            refreshVectors: true,
            skipIntegrity: true,
            skipDrift: true,
          },
        );
        expect(requests).toBe(0);
        expect(
          result.checks.find((check) => check.name === "vectorization")
            ?.details,
        ).toMatchObject({
          stale_items_before: [],
          refresh_attempted: false,
          refresh_skipped_reason: "no_stale_items",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
