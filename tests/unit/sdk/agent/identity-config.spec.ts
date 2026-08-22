import { describe, expect, it } from "vitest";
import {
  planAgentIdentityVocabularyMutation,
  summarizeAgentIdentityVocabulary,
} from "../../../../src/sdk/agent/identity-config.js";

describe("agent identity config contracts", () => {
  it("adds one exact legacy spelling, bumps the revision, and reports residual counts without aliases", () => {
    const planned = planAgentIdentityVocabularyMutation(
      { version: 1, aliases: {} },
      {
        operation: "add",
        legacy_author: "Codex CLI",
        canonical_harness: "codex",
        observed_authors: ["Codex CLI", "Codex CLI", "Alice", "harness:codex"],
      },
    );
    expect(planned).toEqual({
      vocabulary: { version: 2, aliases: { "Codex CLI": "codex" } },
      preview: {
        operation: "add",
        changed: true,
        version_before: 1,
        version_after: 2,
        alias_count: 1,
        residual_author_count: 1,
      },
    });
    expect(planned.preview).not.toHaveProperty("aliases");
  });

  it("is idempotent for an identical mapping and increments only on real changes", () => {
    const planned = planAgentIdentityVocabularyMutation(
      { version: 4, aliases: { "Codex CLI": "codex" } },
      {
        operation: "add",
        legacy_author: "Codex CLI",
        canonical_harness: "codex",
      },
    );
    expect(planned.preview).toMatchObject({
      changed: false,
      version_before: 4,
      version_after: 4,
      alias_count: 1,
    });
  });

  it("removes and clears mappings with one monotonic version bump", () => {
    const current = { version: 7, aliases: { Old: "codex", Legacy: "aider" } };
    expect(
      planAgentIdentityVocabularyMutation(current, {
        operation: "remove",
        legacy_author: "Old",
      }).vocabulary,
    ).toEqual({ version: 8, aliases: { Legacy: "aider" } });
    expect(
      planAgentIdentityVocabularyMutation(current, { operation: "clear" })
        .vocabulary,
    ).toEqual({ version: 8, aliases: {} });
  });

  it("forbids aliases that are already canonical or use invalid harness namespaces", () => {
    expect(() =>
      planAgentIdentityVocabularyMutation(
        { version: 1, aliases: {} },
        {
          operation: "add",
          legacy_author: "harness:codex",
          canonical_harness: "codex",
        },
      ),
    ).toThrow(/already canonical/u);
    expect(() =>
      planAgentIdentityVocabularyMutation(
        { version: 1, aliases: {} },
        {
          operation: "add",
          legacy_author: "Old",
          canonical_harness: "Not Valid!",
        },
      ),
    ).toThrow(/canonical harness/u);
  });

  it("summarizes only revision and count", () => {
    expect(
      summarizeAgentIdentityVocabulary({
        version: 3,
        aliases: { privateAuthor: "codex" },
      }),
    ).toEqual({ version: 3, alias_count: 1 });
    expect(summarizeAgentIdentityVocabulary(undefined)).toEqual({
      version: 1,
      alias_count: 0,
    });
  });

  it("covers validation, ordering, defaults, and idempotent removal boundaries", () => {
    expect(
      planAgentIdentityVocabularyMutation(undefined, {
        operation: "add",
        legacy_author: "Zulu",
        canonical_harness: "codex",
      }).vocabulary,
    ).toEqual({ version: 2, aliases: { Zulu: "codex" } });
    expect(
      planAgentIdentityVocabularyMutation(
        { version: 2, aliases: { Zulu: "codex", Alpha: "aider" } },
        { operation: "add", legacy_author: "Middle", canonical_harness: "pi" },
      ).vocabulary.aliases,
    ).toEqual({ Alpha: "aider", Middle: "pi", Zulu: "codex" });
    expect(
      planAgentIdentityVocabularyMutation(undefined, {
        operation: "remove",
        legacy_author: "missing",
      }).preview.changed,
    ).toBe(false);
    expect(
      planAgentIdentityVocabularyMutation(undefined, { operation: "clear" })
        .preview.changed,
    ).toBe(false);
    for (const legacy_author of [undefined, "", "x".repeat(129)]) {
      expect(() =>
        planAgentIdentityVocabularyMutation(undefined, {
          operation: "remove",
          legacy_author,
        }),
      ).toThrow(/legacy author/u);
    }
    for (const operation of ["add", "remove"] as const) {
      expect(() =>
        planAgentIdentityVocabularyMutation(undefined, {
          operation,
          legacy_author: "__proto__",
          ...(operation === "add" ? { canonical_harness: "codex" } : {}),
        }),
      ).toThrow(/legacy author/u);
    }
    expect(() =>
      planAgentIdentityVocabularyMutation(undefined, {
        operation: "add",
        legacy_author: "Old",
        canonical_harness: undefined,
      }),
    ).toThrow(/canonical harness/u);
    for (const legacy_author of ["codex", "harness:other"]) {
      expect(() =>
        planAgentIdentityVocabularyMutation(undefined, {
          operation: "add",
          legacy_author,
          canonical_harness: "codex",
        }),
      ).toThrow(/already canonical/u);
    }
    expect(() =>
      planAgentIdentityVocabularyMutation(undefined, {
        operation: "unsupported",
      } as never),
    ).toThrow(/Unsupported vocabulary operation/u);
  });
});
