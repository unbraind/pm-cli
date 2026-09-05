import { describe, expect, it } from "vitest";
import {
  inspectMarkdown,
  inspectDocumentationGraph,
  resolveDocumentationTarget,
} from "../../../../scripts/release/docs-topology.mjs";

describe("documentation navigation contracts", () => {
  it("decodes local URLs, checks invalid escapes and validates exception reasons", () => {
    expect(
      resolveDocumentationTarget(
        "docs/a.md",
        "/docs/Caf%C3%A9.md?raw=1#caf%C3%A9",
      ),
    ).toEqual({ path: "docs/Café.md", fragment: "café" });
    expect(resolveDocumentationTarget("docs/a.md", "#part")).toEqual({
      path: "docs/a.md",
      fragment: "part",
    });
    const documents = new Map([
      [
        "docs/README.md",
        "[bad](%zz.md)\n[asset](image.svg)\n[external](https://example.org)\n![image](image.svg)",
      ],
      ["README.md", "# Root"],
      ["docs/standalone.md", "# Standalone"],
    ]);
    expect(
      inspectDocumentationGraph(
        documents,
        new Map([["docs/standalone.md", " "]]),
      ),
    ).toEqual([
      'Malformed documentation URL "%zz.md" in docs/README.md',
      "Documentation reachability exception requires a reason: docs/standalone.md",
    ]);
    expect(
      inspectDocumentationGraph(
        documents,
        new Map([["docs/standalone.md", 0]]),
      ),
    ).toContain(
      "Documentation reachability exception requires a reason: docs/standalone.md",
    );
  });
  it("extracts real links and GitHub heading anchors without interpreting fenced examples", () => {
    const document = inspectMarkdown(
      '# A **bold** [heading](target.md)\n## A bold heading\n## Café & tea\n## Cats &amp; Dogs\n## Fish &#38; Chips\n## **A _nested_ heading**\n## `<Type>` &amp; `&amp;`\n## ![Visible](icon.svg)\nSetext\n------\n<a id="manual"></a>\n[local](#manual)\n[ref][r]\n\n[r]: other.md#part\n```md\n# Fake\n[bad](missing.md)\n```',
    );
    expect([...document.anchors]).toEqual([
      "a-bold-heading",
      "a-bold-heading-1",
      "café--tea",
      "cats--dogs",
      "fish--chips",
      "a-nested-heading",
      "type--amp",
      "visible",
      "setext",
      "manual",
    ]);
    expect(document.links).toEqual([
      "target.md",
      "icon.svg",
      "#manual",
      "other.md#part",
    ]);
  });

  it("finds unreachable cycles, bad fragments and stale opt-outs while following transitive links", () => {
    const docs = new Map([
      ["docs/README.md", "# Index\n[A](a.md#part)\n[bad](a.md#gone)"],
      ["docs/a.md", "# Part\n[B](nested/b.md)"],
      ["docs/nested/b.md", "# B\n[back](../a.md#part)"],
      ["docs/orphan.md", "[self](orphan.md)"],
      ["docs/standalone.md", "# Independent"],
    ]);
    expect(
      inspectDocumentationGraph(
        docs,
        new Map([["docs/standalone.md", "External entrypoint"]]),
      ),
    ).toEqual([
      'Broken documentation anchor "a.md#gone" in docs/README.md',
      "Unreachable documentation: docs/orphan.md; link it from docs/README.md or a reachable document",
    ]);
    docs.set(
      "docs/README.md",
      "[A](a.md#part)\n[orphan](orphan.md)\n[standalone](standalone.md)",
    );
    expect(inspectDocumentationGraph(docs)).toEqual([]);
    expect(
      inspectDocumentationGraph(
        docs,
        new Map([["docs/absent.md", "intentional"]]),
      ),
    ).toContain("Stale documentation reachability exception: docs/absent.md");
  });
});
