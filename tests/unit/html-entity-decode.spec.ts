import { describe, expect, it } from "vitest";

import {
  decodeHtmlEntitiesIfEscaped,
  decodeHtmlEntitiesInOptions,
} from "../../src/core/shared/html-entity-decode.js";

describe("decodeHtmlEntitiesIfEscaped", () => {
  it("decodes &lt; and &gt;", () => {
    expect(decodeHtmlEntitiesIfEscaped("create &lt;type&gt; here")).toBe("create <type> here");
  });

  it("decodes &quot; and &#39; when an angle-bracket entity is also present", () => {
    expect(decodeHtmlEntitiesIfEscaped("&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;")).toBe(
      "<a href=\"x\" data='y'>",
    );
  });

  it("decodes &amp; alongside angle brackets in a single pass", () => {
    expect(decodeHtmlEntitiesIfEscaped("Tom &amp; Jerry &lt;3")).toBe("Tom & Jerry <3");
  });

  it("does NOT double-decode: &amp;lt; resolves to literal &lt; in a single pass", () => {
    // When the signal-guard activates (because real &lt;/&gt; is present), the
    // decode pass MUST resolve `&amp;lt;` to the literal `&lt;` string and stop
    // — never collapse to `<`. We mix a real `&lt;trigger&gt;` to activate the
    // pass so the `&amp;lt;` behavior is exercised, not short-circuited.
    expect(decodeHtmlEntitiesIfEscaped("&amp;lt;keep&amp;gt; and &lt;trigger&gt;")).toBe(
      "&lt;keep&gt; and <trigger>",
    );
  });

  it("input that only contains &amp;lt; (no real &lt;/&gt;) is a no-op", () => {
    // The signal-guard is intentional: pm-cli only decodes when something
    // upstream actually HTML-encoded an angle bracket. A bare `&amp;lt;` with
    // no real `&lt;`/`&gt;` siblings is left untouched so we don't accidentally
    // alter intentional `&amp;`-encoded text.
    expect(decodeHtmlEntitiesIfEscaped("&amp;lt;keep&amp;gt;")).toBe("&amp;lt;keep&amp;gt;");
  });

  it("only activates when &lt; or &gt; is present (no-op otherwise)", () => {
    // &quot; and &amp; alone are NOT a signal that the platform HTML-encoded us.
    expect(decodeHtmlEntitiesIfEscaped("Tom &amp; Jerry")).toBe("Tom &amp; Jerry");
    expect(decodeHtmlEntitiesIfEscaped("say &quot;hi&quot;")).toBe("say &quot;hi&quot;");
  });

  it("is idempotent: decoding twice on plain text equals decoding once", () => {
    const plain = "normal text with < and > and \" and ' and &";
    expect(decodeHtmlEntitiesIfEscaped(decodeHtmlEntitiesIfEscaped(plain))).toBe(plain);
  });

  it("returns input unchanged when no entities are present", () => {
    const text = "Just regular text — no entities here.";
    expect(decodeHtmlEntitiesIfEscaped(text)).toBe(text);
  });

  it("returns the empty string unchanged", () => {
    expect(decodeHtmlEntitiesIfEscaped("")).toBe("");
  });

  it("leaves unknown entity-like tokens alone", () => {
    expect(decodeHtmlEntitiesIfEscaped("keep &nbsp; but decode &lt;")).toBe("keep &nbsp; but decode <");
  });

  it("passes through non-string inputs untouched (defensive runtime guard)", () => {
    // Function is typed `(input: string) => string` but defends at runtime.
    expect(decodeHtmlEntitiesIfEscaped(123 as unknown as string)).toBe(123 as unknown as string);
    expect(decodeHtmlEntitiesIfEscaped(null as unknown as string)).toBe(null as unknown as string);
  });
});

describe("decodeHtmlEntitiesInOptions", () => {
  it("decodes string leaves in a plain object", () => {
    const input = { title: "fix &lt;bug&gt;", description: "no entities here" };
    expect(decodeHtmlEntitiesInOptions(input)).toEqual({
      title: "fix <bug>",
      description: "no entities here",
    });
  });

  it("walks nested objects, arrays, and mixed values recursively", () => {
    const input = {
      id: "pm-abc1",
      options: {
        comment: "see &lt;file&gt; for details",
        tags: ["bug", "needs-&lt;triage&gt;"],
        nested: {
          notes: ["a", "b &lt;c&gt;", { learning: "&lt;k&gt;=&lt;v&gt;" }],
        },
      },
    };
    expect(decodeHtmlEntitiesInOptions(input)).toEqual({
      id: "pm-abc1",
      options: {
        comment: "see <file> for details",
        tags: ["bug", "needs-<triage>"],
        nested: {
          notes: ["a", "b <c>", { learning: "<k>=<v>" }],
        },
      },
    });
  });

  it("passes non-string scalars through untouched", () => {
    const input = {
      count: 42,
      flag: true,
      missing: null,
      undef: undefined,
      text: "decode &lt;me&gt;",
    };
    const decoded = decodeHtmlEntitiesInOptions(input);
    expect(decoded).toEqual({
      count: 42,
      flag: true,
      missing: null,
      undef: undefined,
      text: "decode <me>",
    });
  });

  it("returns a fresh object rather than mutating the input", () => {
    const input = { title: "fix &lt;bug&gt;", tags: ["a", "b"] };
    const decoded = decodeHtmlEntitiesInOptions(input);
    expect(decoded).not.toBe(input);
    expect(decoded.tags).not.toBe(input.tags);
    // Input is untouched.
    expect(input.title).toBe("fix &lt;bug&gt;");
  });

  it("returns top-level scalars and nullish values unchanged", () => {
    expect(decodeHtmlEntitiesInOptions("decode &lt;x&gt;")).toBe("decode <x>");
    expect(decodeHtmlEntitiesInOptions("plain text")).toBe("plain text");
    expect(decodeHtmlEntitiesInOptions(7 as unknown)).toBe(7);
    expect(decodeHtmlEntitiesInOptions(false as unknown)).toBe(false);
    expect(decodeHtmlEntitiesInOptions(null as unknown)).toBe(null);
    expect(decodeHtmlEntitiesInOptions(undefined as unknown)).toBe(undefined);
  });

  it("handles empty objects and arrays", () => {
    expect(decodeHtmlEntitiesInOptions({})).toEqual({});
    expect(decodeHtmlEntitiesInOptions([])).toEqual([]);
  });

  it("does not infinite-loop on cyclic object graphs", () => {
    const cycle: Record<string, unknown> = { text: "decode &lt;me&gt;" };
    cycle.self = cycle;
    // Defensive: visited-set guards against cycles. We only assert the call
    // returns without throwing or hanging — the cycle itself is preserved on
    // the original input (the walker copies a fresh tree but stops descending
    // when it re-encounters a seen node).
    expect(() => decodeHtmlEntitiesInOptions(cycle)).not.toThrow();
  });

  it("does not infinite-loop on cyclic arrays", () => {
    const arr: unknown[] = ["decode &lt;me&gt;"];
    arr.push(arr);
    expect(() => decodeHtmlEntitiesInOptions(arr)).not.toThrow();
  });
});
