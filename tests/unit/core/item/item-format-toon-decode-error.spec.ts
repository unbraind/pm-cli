import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseItemDocument,
  serializeItemDocument,
} from "../../../../src/core/item/item-format.js";

const toonState = vi.hoisted(() => ({
  decode: (_content: string): unknown => ({}),
  encode: (value: unknown): string => JSON.stringify(value),
}));

vi.mock("@toon-format/toon", () => ({
  decode: (content: string) => toonState.decode(content),
  encode: (value: unknown) => toonState.encode(value),
}));

const document = {
  metadata: {
    id: "pm-roundtrip-refusal",
    title: "Round-trip refusal",
    description: "No unreadable bytes may reach storage.",
    type: "Task",
    status: "open",
    priority: 1,
    tags: [],
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:00.000Z",
  },
  body: "notes[]:",
};

describe("item-format TOON decode failures", () => {
  afterEach(() => {
    toonState.decode = (_content: string): unknown => ({});
    toonState.encode = (value: unknown): string => JSON.stringify(value);
  });

  it("wraps TOON decode exceptions with validation error text", () => {
    toonState.decode = () => {
      throw new Error("decode exploded");
    };

    expect(() => parseItemDocument("front_matter: {}", { format: "toon" })).toThrow(
      "TOON item document is not valid TOON",
    );
  });

  it("refuses encoded bytes that cannot be decoded before persistence", () => {
    toonState.decode = () => {
      throw new Error("decoder rejected encoded bytes");
    };
    toonState.encode = () => "unreadable";

    expect(() => serializeItemDocument(document, { format: "toon" })).toThrow(
      "Refusing to persist a TOON item document that the configured decoder cannot read back.",
    );
  });

  it("preserves a non-Error decoder rejection reason", () => {
    toonState.decode = () => {
      throw "decoder rejected as text";
    };
    toonState.encode = () => "unreadable";

    expect.assertions(1);
    try {
      serializeItemDocument(document, { format: "toon" });
    } catch (error: unknown) {
      expect(error).toMatchObject({
        context: {
          why: "decoder rejected as text",
        },
      });
    }
  });

  it("names the first lossy field when encoded bytes decode differently", () => {
    toonState.decode = () => ({
      id: "pm-roundtrip-refusal",
      title: "changed",
    });
    toonState.encode = () => "lossy";

    expect(() =>
      serializeItemDocument(
        {
          ...document,
          metadata: {
            ...document.metadata,
            title: "Original",
            description: "No lossy bytes may reach storage.",
          },
          body: "",
        },
        { format: "toon" },
      ),
    ).toThrow('round-trip mismatch at field "title"');
  });

  it("names the first canonical field when the decoded value is not an object", () => {
    toonState.decode = () => null;
    toonState.encode = () => "null";

    expect(() => serializeItemDocument(document, { format: "toon" })).toThrow(
      'round-trip mismatch at field "id"',
    );
  });

  it("uses the document fallback when the decoder adds an unexpected field", () => {
    toonState.decode = (content: string) => ({
      ...(JSON.parse(content) as Record<string, unknown>),
      unexpected: "field",
    });

    expect(() => serializeItemDocument(document, { format: "toon" })).toThrow(
      'round-trip mismatch at field "document"',
    );
  });
});
