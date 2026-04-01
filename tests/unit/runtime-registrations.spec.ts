import { describe, expect, it } from "vitest";
import { createEmptyExtensionRegistrationRegistry } from "../../src/core/extensions/loader.js";
import {
  collectRegisteredItemFields,
  getMigrationRuntimeDefinition,
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../src/core/extensions/runtime-registrations.js";

describe("extensions runtime registration resolution", () => {
  it("collects registered item fields across registrations", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.item_fields.push(
      {
        layer: "global",
        name: "global-fields",
        fields: [{ name: "team" }],
      },
      {
        layer: "project",
        name: "project-fields",
        fields: [{ name: "severity" }],
      },
    );

    expect(collectRegisteredItemFields(registrations)).toEqual([{ name: "team" }, { name: "severity" }]);
    expect(collectRegisteredItemFields(null)).toEqual([]);
  });

  it("resolves search providers by configured name with reverse-precedence matching", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.search_providers.push(
      {
        layer: "global",
        name: "global-provider",
        definition: { name: "elastic", query: () => [{ id: "pm-1", score: 0.5 }] },
        runtime_definition: { name: "elastic", query: () => [{ id: "pm-1", score: 0.5 }] },
      },
      {
        layer: "project",
        name: "project-provider",
        definition: { name: "Elastic", query: () => [{ id: "pm-2", score: 0.8 }] },
        runtime_definition: { query: () => [{ id: "pm-2", score: 0.8 }] },
      },
    );

    const resolved = resolveRegisteredSearchProvider(registrations, "  ELASTIC ");
    expect(resolved?.name).toBe("project-provider");
    expect(resolveRegisteredSearchProvider(registrations, "missing")).toBeNull();
    expect(resolveRegisteredSearchProvider(registrations, undefined)).toBeNull();
  });

  it("resolves vector store adapters by configured name with reverse precedence", () => {
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.vector_store_adapters.push(
      {
        layer: "global",
        name: "global-vector",
        definition: { name: "pinecone", query: () => [] },
        runtime_definition: { name: "pinecone", query: () => [] },
      },
      {
        layer: "project",
        name: "project-vector",
        definition: { name: "PINECONE", query: () => [] },
        runtime_definition: { query: () => [] },
      },
    );

    const resolved = resolveRegisteredVectorStoreAdapter(registrations, "pinecone");
    expect(resolved?.name).toBe("project-vector");
    expect(resolveRegisteredVectorStoreAdapter(registrations, "")).toBeNull();
    expect(resolveRegisteredVectorStoreAdapter(null, "pinecone")).toBeNull();
  });

  it("returns migration runtime definitions when available", () => {
    const runtime = getMigrationRuntimeDefinition({
      layer: "project",
      name: "runtime-migration",
      definition: { id: "m1", status: "pending" },
      runtime_definition: { id: "m1", status: "applied", run: () => true },
    });
    expect(runtime).toEqual({ id: "m1", status: "applied", run: expect.any(Function) });

    const fallback = getMigrationRuntimeDefinition({
      layer: "project",
      name: "fallback-migration",
      definition: { id: "m2", status: "pending" },
      runtime_definition: undefined as unknown as Record<string, unknown>,
    });
    expect(fallback).toEqual({ id: "m2", status: "pending" });
  });
});
