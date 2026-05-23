import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

import { createChangelog, mergeChangelog, readPmItems, writeChangelog } from "./generator.js";
import type { ChangelogGroupBy } from "./types.js";

const defineExtension: typeof defineExtensionType = ((extension: unknown) => extension) as typeof defineExtensionType;

export default defineExtension({
  name: "pm-changelog",
  version: "0.1.0",

  activate(api) {
    api.registerCommand({
      name: "changelog generate",
      description: "Generate a CHANGELOG.md file from pm items.",
      intent: "generate changelog release notes from completed pm items",
      examples: [
        "pm changelog generate",
        "pm changelog generate --release-version 1.2.0",
        "pm changelog generate --output RELEASE_NOTES.md --since 2026-05-01",
        "pm changelog generate --stdout --group-by release",
        "pm changelog generate --stdout --group-by milestone",
        "pm changelog generate --check --mode prepend --release-version 1.2.0",
      ],
      flags: [
        { long: "--output", value_name: "file", description: "Output file path (default: CHANGELOG.md)" },
        { long: "--stdout", description: "Return markdown instead of writing a file" },
        { long: "--title", value_name: "text", description: "Changelog title (default: Changelog)" },
        { long: "--release-version", value_name: "version", description: "Release/version heading (default: Unreleased)" },
        { long: "--date", value_name: "date", description: "Release date (default: today)" },
        { long: "--since", value_name: "date", description: "Include items changed on or after this date" },
        { long: "--until", value_name: "date", description: "Include items changed on or before this date" },
        { long: "--status", value_name: "list", description: "Comma-separated statuses (default: closed)" },
        { long: "--group-by", value_name: "mode", description: "version, release, or milestone (default: version)" },
        { long: "--mode", value_name: "mode", description: "replace or prepend existing changelog (default: replace)" },
        { long: "--include-empty", description: "Emit an empty release section when no items match" },
        { long: "--include-links", description: "Include item URLs in generated entries (default: false)" },
        { long: "--check", description: "Do not write; report whether the changelog would change" },
      ],
      async run(ctx) {
        const output = (ctx.options["output"] as string | undefined) ?? "CHANGELOG.md";
        const stdout = Boolean(ctx.options["stdout"]);
        const groupByOption = stringOption(ctx.options, "group-by", "groupBy") ?? "version";
        const modeOption = (ctx.options["mode"] as string | undefined) ?? "replace";

        if (groupByOption !== "version" && groupByOption !== "release" && groupByOption !== "milestone") {
          return { error: "--group-by must be 'version', 'release', or 'milestone'" };
        }
        if (modeOption !== "replace" && modeOption !== "prepend") {
          return { error: "--mode must be 'replace' or 'prepend'" };
        }
        const groupBy: ChangelogGroupBy = groupByOption;
        const mode: "replace" | "prepend" = modeOption;

        const statuses = (ctx.options["status"] as string | undefined)
          ?.split(",")
          .map((status) => status.trim())
          .filter(Boolean);

        const items = readPmItems({ pmRoot: ctx.pm_root });
        const generationOptions = {
          items,
          title: ctx.options["title"] as string | undefined,
          version: stringOption(ctx.options, "release-version", "releaseVersion"),
          date: ctx.options["date"] as string | undefined,
          since: ctx.options["since"] as string | undefined,
          until: ctx.options["until"] as string | undefined,
          includeStatuses: statuses,
          groupBy,
          includeEmpty: booleanOption(ctx.options, "include-empty", "includeEmpty"),
          includeLinks: booleanOption(ctx.options, "include-links", "includeLinks"),
        };
        const generated = createChangelog(generationOptions);

        if (stdout) {
          const merged = mode === "prepend"
            ? mergeChangelog(undefined, generated.markdown, { title: ctx.options["title"] as string | undefined })
            : { markdown: generated.markdown, action: "replaced" as const, changed: true };
          return {
            changelog: merged.markdown,
            action: merged.action,
            changed: merged.changed,
            item_count: generated.itemCount,
          };
        }

        const result = writeChangelog({
          ...generationOptions,
          output,
          mode,
          check: Boolean(ctx.options["check"]),
        });
        if (result.changed && Boolean(ctx.options["check"])) {
          throw new Error(`Changelog is out of date: ${result.output}`);
        }
        return {
          file: result.output,
          action: result.action,
          changed: result.changed,
          item_count: result.itemCount,
          bytes: result.bytes,
          check: Boolean(ctx.options["check"]),
        };
      },
    });
  },
});

function stringOption(options: Record<string, unknown>, kebabKey: string, camelKey: string): string | undefined {
  const value = options[kebabKey] ?? options[camelKey];
  return typeof value === "string" ? value : undefined;
}

function booleanOption(options: Record<string, unknown>, kebabKey: string, camelKey: string): boolean {
  return Boolean(options[kebabKey] ?? options[camelKey]);
}
