import { describe, expect, it } from "vitest";
import {
  normalizeItemAddressInvocation,
  supportsItemIdAlias,
} from "../../../src/sdk/agent/item-addressing.js";
import {
  rankCommandPaths,
  scoreCommandPathMatch,
} from "../../../src/sdk/agent/command-suggestions.js";
import {
  renderMissingOptionRetry,
  resolveMissingOptionPlaceholder,
} from "../../../src/sdk/agent/command-recovery.js";
import { normalizeBootstrapInvocation } from "../../../src/sdk/cli-bootstrap.js";
import { resolveItemTypeRegistry } from "../../../src/sdk/runtime-primitives.js";
import { _testOnly as helpJsonTestOnly } from "../../../src/cli/help-json-payload.js";

describe("agent command SDK primitives", () => {
  it("normalizes --id into the canonical positional address without losing argv", () => {
    expect(supportsItemIdAlias("get")).toBe(true);
    expect(normalizeItemAddressInvocation(["--"])).toEqual({
      argv: ["--"],
      changed: false,
      conflict: false,
    });
    expect(
      normalizeItemAddressInvocation(["get", "--json", "--id", "pm-a1"]),
    ).toEqual({
      argv: ["get", "pm-a1", "--json"],
      changed: true,
      conflict: false,
      itemId: "pm-a1",
    });
    expect(
      normalizeItemAddressInvocation(["get", "pm-a1", "--id", "pm-a2"])
        .conflict,
    ).toBe(true);
    expect(
      normalizeItemAddressInvocation([
        "get",
        "--full",
        "pm-a1",
        "--id",
        "pm-a2",
      ]).conflict,
    ).toBe(true);
    expect(
      normalizeItemAddressInvocation([
        "get",
        "--id",
        "pm-a1",
        "--format",
        "toon",
      ]),
    ).toEqual({
      argv: ["get", "pm-a1", "--format", "toon"],
      changed: true,
      conflict: false,
      itemId: "pm-a1",
    });
    expect(
      normalizeItemAddressInvocation([
        "get",
        "--id",
        "pm-a2",
        "--full",
        "pm-a1",
      ]).conflict,
    ).toBe(true);
    expect(
      normalizeItemAddressInvocation([
        "copy",
        "--title",
        "Copy title",
        "--id",
        "pm-a1",
      ]),
    ).toEqual({
      argv: ["copy", "pm-a1", "--title", "Copy title"],
      changed: true,
      conflict: false,
      itemId: "pm-a1",
    });
    expect(
      normalizeItemAddressInvocation(["get", "--id", "pm-a1", "--id=pm-a2"])
        .conflict,
    ).toBe(true);
    expect(normalizeItemAddressInvocation(["get", "--id=pm-a1"]).argv).toEqual([
      "get",
      "pm-a1",
    ]);
    expect(
      normalizeItemAddressInvocation([
        "get",
        "--output-format",
        "toon",
        "--id",
        "pm-a1",
      ]).argv,
    ).toEqual(["get", "pm-a1", "--output-format", "toon"]);
    expect(
      normalizeItemAddressInvocation([
        "get",
        "--output-format=toon",
        "--id",
        "pm-a1",
      ]).argv,
    ).toEqual(["get", "pm-a1", "--output-format=toon"]);
    expect(normalizeItemAddressInvocation(["get", "--id", ""])).toEqual({
      argv: ["get", "--id", ""],
      changed: false,
      conflict: false,
    });
    expect(
      normalizeItemAddressInvocation(["get", "--", "--id", "pm-a1"]),
    ).toEqual({
      argv: ["get", "--", "--id", "pm-a1"],
      changed: false,
      conflict: false,
    });
    expect(
      normalizeItemAddressInvocation(["get", "--id", "pm-a1", "--", "operand"]),
    ).toEqual({
      argv: ["get", "pm-a1", "--", "operand"],
      changed: true,
      conflict: false,
      itemId: "pm-a1",
    });
    expect(
      normalizeItemAddressInvocation(["--pm-path", "/tmp/example"]),
    ).toEqual({
      argv: ["--pm-path", "/tmp/example"],
      changed: false,
      conflict: false,
    });
    expect(
      normalizeItemAddressInvocation([
        "close",
        "--id",
        "pm-a1",
        "done",
        "--validate-close",
        "off",
      ]).argv,
    ).toEqual(["close", "pm-a1", "done", "--validate-close", "off"]);
    expect(
      normalizeItemAddressInvocation([
        "item",
        "complete",
        "--id=pm-a1",
        "--transaction-id",
        "tx-1",
      ]).argv,
    ).toEqual(["item", "complete", "pm-a1", "--transaction-id", "tx-1"]);
    expect(normalizeItemAddressInvocation(["item", "--id", "pm-a1"])).toEqual({
      argv: ["item", "--id", "pm-a1"],
      changed: false,
      conflict: false,
    });
    expect(
      normalizeItemAddressInvocation(["item", "show", "--id", "pm-a1"]),
    ).toEqual({
      argv: ["item", "show", "--id", "pm-a1"],
      changed: false,
      conflict: false,
    });
    expect(normalizeItemAddressInvocation(["files", "--id", "pm-a1"])).toEqual({
      argv: ["files", "pm-a1"],
      changed: true,
      conflict: false,
      itemId: "pm-a1",
    });
    expect(
      normalizeItemAddressInvocation(["files", "discover", "--id", "pm-a1"])
        .argv,
    ).toEqual(["files", "discover", "pm-a1"]);
    const bootstrap = normalizeBootstrapInvocation(["get", "--id", "pm-a1"]);
    expect(bootstrap.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "item_id_alias" }),
      ]),
    );
    expect(() =>
      normalizeBootstrapInvocation(["get", "pm-a1", "--id", "pm-a2"]),
    ).toThrow("either positionally or with --id");
    expect(() =>
      normalizeBootstrapInvocation(["get", "--full", "pm-a1", "--id", "pm-a2"]),
    ).toThrow("either positionally or with --id");
    expect(() =>
      normalizeBootstrapInvocation(["get", "--id", "pm-a1", "--id=pm-a2"]),
    ).toThrow("either positionally or with --id");
  });

  it("ignores create-mode operands after the argument terminator", () => {
    const registry = resolveItemTypeRegistry({
      item_types: {
        definitions: [
          {
            name: "ContextualIssue",
            folder: "contextual-issues",
            required_create_fields: [],
            required_create_repeatables: ["dep"],
            options: [],
          },
        ],
      },
    } as never);
    const strictSpaced = helpJsonTestOnly.buildCreateUpdatePolicyHelpText(
      "create",
      registry,
      ["create", "--type", "ContextualIssue", "--create-mode", "strict"],
    );
    const strictInline = helpJsonTestOnly.buildCreateUpdatePolicyHelpText(
      "create",
      registry,
      ["create", "--type", "ContextualIssue", "--create-mode=strict"],
    );
    const operand = helpJsonTestOnly.buildCreateUpdatePolicyHelpText(
      "create",
      registry,
      ["create", "--type", "ContextualIssue", "--", "--create-mode", "strict"],
    );
    expect(strictSpaced).toContain("required: --title, --type, --dep");
    expect(strictInline).toContain("required: --title, --type, --dep");
    expect(operand).toContain("required: --title, --type");
    expect(operand).not.toContain("required: --title, --type, --dep");
  });

  it("renders missing values from the declared flag domain", () => {
    expect(resolveMissingOptionPlaceholder("close", "--validate-close")).toBe(
      "<off|warn|strict>",
    );
    expect(resolveMissingOptionPlaceholder("close", "--force")).toBeNull();
    expect(resolveMissingOptionPlaceholder("close", "--reason")).toBe(
      "<value>",
    );
    expect(resolveMissingOptionPlaceholder("close", "reason")).toBeUndefined();
    expect(resolveMissingOptionPlaceholder("close", "--not-declared")).toBe(
      "<value>",
    );
    expect(
      renderMissingOptionRetry(["close", "pm-a1"], "close", [
        "not-a-flag",
        "--force",
      ]),
    ).toBe("pm close pm-a1 --force");
    expect(
      renderMissingOptionRetry(
        ["close", "pm-a1", "--reason", "done", "--author", "codex"],
        "close",
        ["--validate-close (--validate-close)"],
      ),
    ).toBe(
      'pm close pm-a1 --reason done --author codex --validate-close "<off|warn|strict>"',
    );
    expect(
      renderMissingOptionRetry(
        ["close", "pm-a1", "--", "--force", "operand"],
        "close",
        ["--force", "--validate-close"],
      ),
    ).toBe(
      'pm close pm-a1 --force --validate-close "<off|warn|strict>" -- --force operand',
    );
  });

  it("ranks synonyms, then edit distance, then substring matches", () => {
    const paths = [
      "extension catalog",
      "package catalog",
      "history",
      "comments",
      "notes",
      "list",
    ];
    expect(rankCommandPaths(paths, "log").slice(0, 3)).toEqual([
      "history",
      "comments",
      "notes",
    ]);
    expect(scoreCommandPathMatch("list", "lst")).toBeLessThan(
      scoreCommandPathMatch("extension catalog", "log"),
    );
    expect(scoreCommandPathMatch("list", "")).toBe(Number.POSITIVE_INFINITY);
    expect(scoreCommandPathMatch("package list", "list")).toBe(11);
    const synonymExpectations: Array<[string, string]> = [
      ["add", "create"],
      ["fetch", "get"],
      ["inspect", "get"],
      ["ls", "list"],
      ["pause", "release"],
      ["read", "get"],
      ["remove", "delete"],
      ["rm", "delete"],
      ["show", "get"],
    ];
    for (const [query, expected] of synonymExpectations) {
      expect(
        rankCommandPaths(
          ["extension catalog", "package catalog", expected],
          query,
        )[0],
      ).toBe(expected);
    }
    expect(rankCommandPaths(["å-command", "z-command"], "command")).toEqual([
      "z-command",
      "å-command",
    ]);
    expect(rankCommandPaths(["list", "list"], "list")).toEqual([
      "list",
      "list",
    ]);
  });
});
