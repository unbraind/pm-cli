import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineExtension, listAllFrontMatter, EXIT_CODE, PmCliError } from "@unbrained/pm-cli/sdk";
import { createChangelog, mergeChangelog, writeChangelog } from "./generator.js";
import { resolveReleaseContext, resolveReleaseTagWindows } from "./release-context.js";
export default defineExtension({
    name: "pm-changelog",
    version: "2026.6.2",
    activate(api) {
        api.registerCommand({
            name: "changelog generate",
            description: "Generate a CHANGELOG.md file from pm items.",
            intent: "generate changelog release notes from completed pm items",
            examples: [
                "pm changelog generate",
                "pm changelog generate --release-version 1.2.0",
                "pm changelog generate --release-version-from-package --since-previous-tag --until-release-tag",
                "pm changelog generate --all-release-tags --mode replace",
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
                { long: "--release-version-from-package", description: "Read release/version heading from nearest package.json" },
                { long: "--date", value_name: "date", description: "Release date (default: resolved tag date when available, otherwise today)" },
                { long: "--since", value_name: "date", description: "Include items changed on or after this date" },
                { long: "--since-previous-tag", description: "Derive --since from the previous git tag" },
                { long: "--until", value_name: "date", description: "Include items changed on or before this date" },
                { long: "--until-release-tag", description: "Derive --until from the current release tag when it exists" },
                { long: "--all-release-tags", description: "Rebuild full history from git release tag windows" },
                { long: "--release-tag-pattern", value_name: "glob", description: "Git tag glob for --all-release-tags (default: v*)" },
                { long: "--status", value_name: "list", description: "Comma-separated statuses (default: closed)" },
                { long: "--group-by", value_name: "mode", description: "version, release, or milestone (default: version)" },
                { long: "--mode", value_name: "mode", description: "replace or prepend existing changelog (default: replace)" },
                { long: "--include-empty", description: "Emit an empty release section when no items match" },
                { long: "--include-links", description: "Include item URLs in generated entries (default: false)" },
                { long: "--item-url-base", value_name: "url", description: "Make item IDs clickable links to .toon files under the base URL" },
                { long: "--check", description: "Do not write; report whether the changelog would change" },
            ],
            async run(ctx) {
                const output = ctx.options["output"] ?? "CHANGELOG.md";
                const stdout = Boolean(ctx.options["stdout"]);
                const groupByOption = stringOption(ctx.options, "group-by", "groupBy") ?? "version";
                const modeOption = ctx.options["mode"] ?? "replace";
                // Throw (with a numeric exitCode) rather than returning { error }: the
                // runtime treats a returned object as a successful run (exit 0), so a
                // returned error silently passed validation failures. A PmCliError
                // carries its exitCode so the handler exits non-zero and runs once.
                if (groupByOption !== "version" && groupByOption !== "release" && groupByOption !== "milestone") {
                    throw new PmCliError("--group-by must be 'version', 'release', or 'milestone'", EXIT_CODE.USAGE);
                }
                if (modeOption !== "replace" && modeOption !== "prepend") {
                    throw new PmCliError("--mode must be 'replace' or 'prepend'", EXIT_CODE.USAGE);
                }
                const groupBy = groupByOption;
                const mode = modeOption;
                const statuses = ctx.options["status"]
                    ?.split(",")
                    .map((status) => status.trim())
                    .filter(Boolean);
                const allReleaseTags = booleanOption(ctx.options, "all-release-tags", "allReleaseTags");
                const releaseVersion = stringOption(ctx.options, "release-version", "releaseVersion");
                const titleOption = stringOption(ctx.options, "title", "title");
                const dateOption = stringOption(ctx.options, "date", "date");
                const sinceOption = stringOption(ctx.options, "since", "since");
                const untilOption = stringOption(ctx.options, "until", "until");
                const releaseContext = allReleaseTags
                    ? { version: undefined, date: undefined, since: undefined, until: undefined }
                    : resolveReleaseContext({
                        cwd: ctx.pm_root,
                        version: releaseVersion,
                        versionFromPackage: booleanOption(ctx.options, "release-version-from-package", "releaseVersionFromPackage"),
                        since: sinceOption,
                        sincePreviousTag: booleanOption(ctx.options, "since-previous-tag", "sincePreviousTag"),
                        until: untilOption,
                        untilReleaseTag: booleanOption(ctx.options, "until-release-tag", "untilReleaseTag"),
                    });
                const releaseWindows = allReleaseTags
                    ? resolveReleaseTagWindows({
                        cwd: ctx.pm_root,
                        tagPattern: stringOption(ctx.options, "release-tag-pattern", "releaseTagPattern"),
                        pendingVersion: releaseVersion,
                        pendingTimestamp: untilOption ?? dateOption,
                    })
                    : undefined;
                const items = await listAllFrontMatter(ctx.pm_root);
                const generationOptions = {
                    items,
                    title: titleOption,
                    version: releaseContext.version,
                    date: dateOption ?? releaseContext.date,
                    since: releaseContext.since,
                    until: releaseContext.until,
                    releaseWindows,
                    includeStatuses: statuses,
                    groupBy,
                    includeEmpty: booleanOption(ctx.options, "include-empty", "includeEmpty"),
                    includeLinks: booleanOption(ctx.options, "include-links", "includeLinks"),
                    itemUrlBase: stringOption(ctx.options, "item-url-base", "itemUrlBase"),
                };
                const generated = createChangelog(generationOptions);
                if (stdout) {
                    const merged = mode === "prepend"
                        ? mergeChangelog(undefined, generated.markdown, { title: titleOption })
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
                    throw new PmCliError(`Changelog is out of date: ${result.output}`, EXIT_CODE.GENERIC_FAILURE);
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
        // -----------------------------------------------------------------------
        // Exporter: `pm changelog export` — native export pipeline.
        // Reuses the same generation core as `changelog generate` (whose default
        // output is intentionally left byte-identical). Adds --format md|json and a
        // --release-notes concise mode. Does NOT write CHANGELOG.md unless --output
        // is given, so it is side-effect free by default.
        // -----------------------------------------------------------------------
        api.registerExporter("changelog", async (ctx) => {
            const format = (stringOption(ctx.options, "format", "format") ?? "md").toLowerCase();
            const groupByOption = stringOption(ctx.options, "group-by", "groupBy") ?? "version";
            if (groupByOption !== "version" && groupByOption !== "release" && groupByOption !== "milestone") {
                throw new PmCliError("--group-by must be 'version', 'release', or 'milestone'", EXIT_CODE.USAGE);
            }
            const releaseNotes = booleanOption(ctx.options, "release-notes", "releaseNotes");
            const releaseVersion = stringOption(ctx.options, "release-version", "releaseVersion");
            const sinceOption = stringOption(ctx.options, "since", "since");
            const untilOption = stringOption(ctx.options, "until", "until");
            const statuses = ctx.options["status"]
                ?.split(",").map((s) => s.trim()).filter(Boolean);
            const releaseContext = resolveReleaseContext({
                cwd: ctx.pm_root,
                version: releaseVersion,
                versionFromPackage: booleanOption(ctx.options, "release-version-from-package", "releaseVersionFromPackage"),
                since: sinceOption,
                sincePreviousTag: booleanOption(ctx.options, "since-previous-tag", "sincePreviousTag"),
                until: untilOption,
                untilReleaseTag: booleanOption(ctx.options, "until-release-tag", "untilReleaseTag"),
            });
            const items = await listAllFrontMatter(ctx.pm_root);
            const generated = createChangelog({
                items,
                title: stringOption(ctx.options, "title", "title") ?? (releaseNotes ? "Release Notes" : undefined),
                version: releaseContext.version,
                date: stringOption(ctx.options, "date", "date") ?? releaseContext.date,
                since: releaseContext.since,
                until: releaseContext.until,
                includeStatuses: statuses,
                groupBy: groupByOption,
                includeEmpty: booleanOption(ctx.options, "include-empty", "includeEmpty"),
                includeLinks: booleanOption(ctx.options, "include-links", "includeLinks"),
                itemUrlBase: stringOption(ctx.options, "item-url-base", "itemUrlBase"),
            });
            const outputPath = stringOption(ctx.options, "output", "output");
            if (format === "json") {
                const payload = {
                    version: releaseContext.version ?? "Unreleased",
                    item_count: generated.itemCount,
                    group_by: groupByOption,
                    markdown: generated.markdown,
                };
                if (outputPath) {
                    writeFileSync(resolve(outputPath), JSON.stringify(payload, null, 2) + "\n", "utf-8");
                    return { file: outputPath, format: "json", item_count: generated.itemCount };
                }
                return payload;
            }
            if (outputPath) {
                writeFileSync(resolve(outputPath), generated.markdown.endsWith("\n") ? generated.markdown : generated.markdown + "\n", "utf-8");
                return { file: outputPath, format: "markdown", item_count: generated.itemCount };
            }
            return { changelog: generated.markdown, format: "markdown", item_count: generated.itemCount };
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