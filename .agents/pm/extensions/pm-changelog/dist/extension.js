import { defineExtension, listAllFrontMatter } from "@unbrained/pm-cli/sdk";
import { createChangelog, mergeChangelog, writeChangelog } from "./generator.js";
export default defineExtension({
    name: "pm-changelog",
    version: "2026.5.24-1",
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
                const output = ctx.options["output"] ?? "CHANGELOG.md";
                const stdout = Boolean(ctx.options["stdout"]);
                const groupByOption = stringOption(ctx.options, "group-by", "groupBy") ?? "version";
                const modeOption = ctx.options["mode"] ?? "replace";
                if (groupByOption !== "version" && groupByOption !== "release" && groupByOption !== "milestone") {
                    return { error: "--group-by must be 'version', 'release', or 'milestone'" };
                }
                if (modeOption !== "replace" && modeOption !== "prepend") {
                    return { error: "--mode must be 'replace' or 'prepend'" };
                }
                const groupBy = groupByOption;
                const mode = modeOption;
                const statuses = ctx.options["status"]
                    ?.split(",")
                    .map((status) => status.trim())
                    .filter(Boolean);
                const items = await listAllFrontMatter(ctx.pm_root);
                const generationOptions = {
                    items,
                    title: ctx.options["title"],
                    version: stringOption(ctx.options, "release-version", "releaseVersion"),
                    date: ctx.options["date"],
                    since: ctx.options["since"],
                    until: ctx.options["until"],
                    includeStatuses: statuses,
                    groupBy,
                    includeEmpty: booleanOption(ctx.options, "include-empty", "includeEmpty"),
                    includeLinks: booleanOption(ctx.options, "include-links", "includeLinks"),
                };
                const generated = createChangelog(generationOptions);
                if (stdout) {
                    const merged = mode === "prepend"
                        ? mergeChangelog(undefined, generated.markdown, { title: ctx.options["title"] })
                        : { markdown: generated.markdown, action: "replaced", changed: true };
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
function stringOption(options, kebabKey, camelKey) {
    const value = options[kebabKey] ?? options[camelKey];
    return typeof value === "string" ? value : undefined;
}
function booleanOption(options, kebabKey, camelKey) {
    return Boolean(options[kebabKey] ?? options[camelKey]);
}
//# sourceMappingURL=extension.js.map