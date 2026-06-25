import { describe, expect, it } from "vitest";
import type { ExtensionActivationSummary } from "../../../../src/core/extensions/activation-summary.js";
import { renderExtensionSurfaceMarkdown } from "../../../../src/core/extensions/activation-summary-markdown.js";
import { renderExtensionSurfaceMarkdown as renderFromSdkBarrel } from "../../../../src/sdk/index.js";

/** Build a fully-empty {@link ExtensionActivationSummary}, overriding fields per test. */
function makeSummary(overrides: Partial<ExtensionActivationSummary> = {}): ExtensionActivationSummary {
  return {
    capabilities: [],
    commands: [],
    command_overrides: [],
    command_handlers: [],
    hooks: [],
    flag_commands: [],
    item_types: [],
    item_fields: [],
    migrations: [],
    importers: [],
    exporters: [],
    search_providers: [],
    vector_store_adapters: [],
    parser_overrides: [],
    service_overrides: [],
    renderer_overrides: [],
    preflight_overrides: 0,
    ...overrides,
  };
}

describe("renderExtensionSurfaceMarkdown", () => {
  it("renders capabilities plus a section per non-empty surface, omitting empty ones", () => {
    const markdown = renderExtensionSurfaceMarkdown(
      makeSummary({
        capabilities: ["commands", "schema"],
        commands: ["tickets create"],
        item_types: ["Ticket"],
        preflight_overrides: 2,
      }),
    );
    expect(markdown).toBe(
      [
        "## Extension surfaces",
        "",
        "Capabilities: `commands`, `schema`",
        "",
        "### Commands",
        "",
        "- `tickets create`",
        "",
        "### Item types",
        "",
        "- `Ticket`",
        "",
        "### Preflight overrides",
        "",
        "- 2 registered (this surface carries no per-entry identifier)",
        "",
      ].join("\n"),
    );
    // No omitted surface leaks an empty heading.
    expect(markdown).not.toContain("Exporters");
  });

  it("honors a custom title and heading level, deepening section headings by one", () => {
    const markdown = renderExtensionSurfaceMarkdown(makeSummary({ exporters: ["report"] }), {
      title: "my-pkg",
      headingLevel: 1,
    });
    expect(markdown.startsWith("# my-pkg\n")).toBe(true);
    expect(markdown).toContain("## Exporters");
  });

  it("clamps section headings to level 6 when the title is already level 6", () => {
    const markdown = renderExtensionSurfaceMarkdown(makeSummary({ importers: ["notion"] }), { headingLevel: 6 });
    expect(markdown).toContain("###### Extension surfaces");
    expect(markdown).toContain("###### Importers");
    expect(markdown).not.toContain("#######");
  });

  it("renders every surface and the capabilities line when includeEmpty is set", () => {
    const markdown = renderExtensionSurfaceMarkdown(makeSummary(), { includeEmpty: true });
    expect(markdown).toContain("Capabilities: _none registered_");
    expect(markdown).toContain("### Commands\n\n_None._");
    expect(markdown).toContain("### Renderer overrides\n\n_None._");
    expect(markdown).toContain("### Preflight overrides\n\n_None._");
    // The "no surfaces" note is for the default projection, never the verbose one.
    expect(markdown).not.toContain("registers no surfaces");
  });

  it("renders a no-surfaces note (and omits the capabilities line) for an empty summary", () => {
    const markdown = renderExtensionSurfaceMarkdown(makeSummary());
    expect(markdown).toBe(["## Extension surfaces", "", "_This extension registers no surfaces._", ""].join("\n"));
    expect(markdown).not.toContain("Capabilities:");
  });

  it("delimits code spans with backtick fences (CommonMark) when an identifier contains backticks", () => {
    // Interior backtick, value does not border one: a longer fence, no padding.
    expect(renderExtensionSurfaceMarkdown(makeSummary({ commands: ["weird`cmd"] }))).toContain("- ``weird`cmd``");
    // Leading backtick: padded so the opening fence stays distinct.
    expect(renderExtensionSurfaceMarkdown(makeSummary({ commands: ["`lead"] }))).toContain("- `` `lead ``");
    // Trailing backtick: padded so the closing fence stays distinct.
    expect(renderExtensionSurfaceMarkdown(makeSummary({ commands: ["trail`"] }))).toContain("- `` trail` ``");
  });

  it("renders the override surfaces (service/renderer/parser) and search/vector providers", () => {
    const markdown = renderExtensionSurfaceMarkdown(
      makeSummary({
        capabilities: ["search"],
        search_providers: ["semantic"],
        vector_store_adapters: ["lancedb"],
        parser_overrides: ["list"],
        service_overrides: ["output_format"],
        renderer_overrides: ["toon"],
        hooks: ["before_command"],
      }),
    );
    expect(markdown).toContain("### Search providers\n\n- `semantic`");
    expect(markdown).toContain("### Vector store adapters\n\n- `lancedb`");
    expect(markdown).toContain("### Parser overrides\n\n- `list`");
    expect(markdown).toContain("### Service overrides\n\n- `output_format`");
    expect(markdown).toContain("### Renderer overrides\n\n- `toon`");
    expect(markdown).toContain("### Lifecycle hooks\n\n- `before_command`");
  });

  it.each([0, 7, 2.5, Number.NaN])("throws RangeError for out-of-range heading level %s", (level) => {
    expect(() => renderExtensionSurfaceMarkdown(makeSummary(), { headingLevel: level })).toThrow(RangeError);
  });

  it("is re-exported from the SDK barrel", () => {
    expect(renderFromSdkBarrel).toBe(renderExtensionSurfaceMarkdown);
  });
});
