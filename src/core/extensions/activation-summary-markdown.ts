/**
 * @module core/extensions/activation-summary-markdown
 *
 * Renders an {@link ExtensionActivationSummary} to a deterministic Markdown
 * reference document — the *render* leg that completes the `describe`
 * (enumerate-all) verb.
 *
 * {@link ./activation-summary.js#describeExtensionActivation | `describeExtensionActivation`}
 * (and its author-time twin
 * {@link ../../sdk/compose.js#describeExtensionBlueprint | `describeExtensionBlueprint`})
 * already answer "what does this package register?" as a structured summary, and
 * the `assert*`/`run*` testing helpers verify and invoke each surface. What was
 * missing is a way to turn that summary into human-readable docs: package
 * authors hand-wrote the README "commands & capabilities" reference, which
 * silently drifted from the surface the loader actually registers.
 *
 * {@link renderExtensionSurfaceMarkdown} closes that gap. It is a pure,
 * dependency-free projection of the summary, so an author can pipe
 * `describeExtensionBlueprint(blueprint)` straight into it during their build or
 * test step and embed the result in their README — a reference that can never
 * drift from the registered surface ("project management = context management").
 * The CLI's `pm extension|package describe --markdown` composes the same
 * primitive across every loaded extension.
 */
import type { ExtensionActivationSummary } from "./activation-summary.js";

/**
 * The lowest and highest ATX heading levels Markdown supports, used to validate
 * {@link ExtensionSurfaceMarkdownOptions.headingLevel} and to clamp nested
 * section headings so a deep title never emits an invalid `#######` run.
 */
const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;

/**
 * Options for {@link renderExtensionSurfaceMarkdown}.
 */
export interface ExtensionSurfaceMarkdownOptions {
  /**
   * Heading text for the document title. Defaults to `"Extension surfaces"`.
   * The title always renders as an ATX heading at
   * {@link ExtensionSurfaceMarkdownOptions.headingLevel}; per-surface sections
   * render one level deeper.
   */
  title?: string;
  /**
   * ATX heading level for the title, an integer in `[1, 6]` (default `2`, i.e.
   * `##`, so the document embeds cleanly under a `# Package` README heading).
   * Section headings render at `headingLevel + 1`, clamped to `6`. Values
   * outside `[1, 6]` throw a {@link RangeError}.
   */
  headingLevel?: number;
  /**
   * When `true`, render every surface section even when it has no entries
   * (emitting `_None._` under the heading) and always emit the capabilities
   * line. Defaults to `false`, which omits empty sections so the reference lists
   * only what the package actually contributes.
   */
  includeEmpty?: boolean;
}

/**
 * A surface section paired with the {@link ExtensionActivationSummary} field
 * whose identifiers populate it. Ordered for an author-facing reference:
 * commands first, then schema, then importers/exporters, retrieval, lifecycle
 * hooks, and finally the override surfaces. {@link ExtensionActivationSummary.command_handlers}
 * is intentionally omitted — it is a documented superset of `commands` plus the
 * synthesized `<name> import`/`<name> export` paths already covered by the
 * Importers and Exporters sections, so rendering it would duplicate information.
 */
const SURFACE_SECTIONS = [
  ["commands", "Commands"],
  ["command_overrides", "Command overrides"],
  ["flag_commands", "Flag commands"],
  ["item_types", "Item types"],
  ["item_fields", "Item fields"],
  ["migrations", "Migrations"],
  ["profiles", "Profiles"],
  ["importers", "Importers"],
  ["exporters", "Exporters"],
  ["search_providers", "Search providers"],
  ["vector_store_adapters", "Vector store adapters"],
  ["hooks", "Lifecycle hooks"],
  ["parser_overrides", "Parser overrides"],
  ["service_overrides", "Service overrides"],
  ["renderer_overrides", "Renderer overrides"],
] as const satisfies ReadonlyArray<
  readonly [
    {
      [K in keyof ExtensionActivationSummary]: ExtensionActivationSummary[K] extends readonly string[] ? K : never;
    }[keyof ExtensionActivationSummary],
    string,
  ]
>;

/**
 * Repeat `#` `level` times to form an ATX heading prefix.
 */
function headingPrefix(level: number): string {
  return "#".repeat(level);
}

/**
 * Render `value` as an inline Markdown code span. Backslash escapes do not work
 * inside CommonMark code spans, so when `value` contains backticks the span is
 * delimited by a run of backticks one longer than the longest internal run, and
 * padded with a space when the value borders a backtick — the CommonMark rule
 * for embedding literal backticks in a code span.
 */
function code(value: string): string {
  if (!value.includes("`")) {
    return `\`${value}\``;
  }
  let longestRun = 0;
  let currentRun = 0;
  for (const char of value) {
    currentRun = char === "`" ? currentRun + 1 : 0;
    longestRun = Math.max(longestRun, currentRun);
  }
  const fence = "`".repeat(longestRun + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * Render the comma-separated capabilities summary line (or `_none registered_`
 * when the activation exercised no known capability).
 */
function renderCapabilitiesLine(capabilities: readonly string[]): string {
  if (capabilities.length === 0) {
    return "Capabilities: _none registered_";
  }
  return `Capabilities: ${capabilities.map(code).join(", ")}`;
}

/**
 * Render one surface section as `heading` + a bullet per identifier, or, when
 * `entries` is empty, `heading` + `_None._`. Callers decide whether an empty
 * section is rendered at all via {@link ExtensionSurfaceMarkdownOptions.includeEmpty}.
 */
function renderSection(heading: string, level: number, entries: readonly string[]): string[] {
  const lines = [`${headingPrefix(level)} ${heading}`, ""];
  if (entries.length === 0) {
    lines.push("_None._", "");
    return lines;
  }
  lines.push(...entries.map((entry) => `- ${code(entry)}`), "");
  return lines;
}

/**
 * Render an {@link ExtensionActivationSummary} as a deterministic Markdown
 * reference document.
 *
 * The output is a title heading, a one-line capabilities summary, and a section
 * per registered surface (commands, overrides, flags, item types/fields,
 * migrations, importers/exporters, search providers, vector adapters, lifecycle
 * hooks, and the parser/service/renderer override surfaces), followed by a
 * preflight-override count line when any are registered. Section order and
 * within-section identifier order both come straight from the summary, so the
 * same summary always renders byte-for-byte the same document.
 *
 * By default empty sections are omitted so the reference lists only what the
 * package contributes; set {@link ExtensionSurfaceMarkdownOptions.includeEmpty}
 * to render every section. A summary with no surfaces at all renders the title,
 * the capabilities line, and a `_This extension registers no surfaces._` note.
 *
 * @throws {RangeError} when `options.headingLevel` is not an integer in `[1, 6]`.
 */
export function renderExtensionSurfaceMarkdown(
  summary: ExtensionActivationSummary,
  options: ExtensionSurfaceMarkdownOptions = {},
): string {
  const titleLevel = options.headingLevel ?? 2;
  if (!Number.isInteger(titleLevel) || titleLevel < MIN_HEADING_LEVEL || titleLevel > MAX_HEADING_LEVEL) {
    throw new RangeError(
      `headingLevel must be an integer in [${MIN_HEADING_LEVEL}, ${MAX_HEADING_LEVEL}], received ${String(options.headingLevel)}`,
    );
  }
  const sectionLevel = Math.min(titleLevel + 1, MAX_HEADING_LEVEL);
  const includeEmpty = options.includeEmpty === true;
  const title = options.title ?? "Extension surfaces";

  const lines = [`${headingPrefix(titleLevel)} ${title}`, ""];
  if (includeEmpty || summary.capabilities.length > 0) {
    lines.push(renderCapabilitiesLine(summary.capabilities), "");
  }

  let renderedSurface = false;
  for (const [field, heading] of SURFACE_SECTIONS) {
    const entries = summary[field];
    if (entries.length === 0 && !includeEmpty) {
      continue;
    }
    renderedSurface = renderedSurface || entries.length > 0;
    lines.push(...renderSection(heading, sectionLevel, entries));
  }

  if (summary.preflight_overrides > 0 || includeEmpty) {
    renderedSurface = renderedSurface || summary.preflight_overrides > 0;
    lines.push(`${headingPrefix(sectionLevel)} Preflight overrides`, "");
    lines.push(
      summary.preflight_overrides > 0
        ? `- ${summary.preflight_overrides} registered (this surface carries no per-entry identifier)`
        : "_None._",
      "",
    );
  }

  if (!renderedSurface && !includeEmpty) {
    lines.push("_This extension registers no surfaces._", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
