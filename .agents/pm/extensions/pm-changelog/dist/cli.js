#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin } from "node:process";
import { createChangelog, mergeChangelog, parsePmItemsJson, readPmItems, writeChangelog, } from "./generator.js";
import { resolveReleaseContext } from "./release-context.js";
async function main() {
    const options = parseArgs(process.argv.slice(2));
    applyReleaseContext(options);
    const items = await loadItems(options);
    const outputPath = resolve(options.output);
    if (!options.stdout) {
        const result = writeChangelog({
            items,
            output: outputPath,
            title: options.title,
            version: options.version,
            date: options.date,
            since: options.since,
            until: options.until,
            includeStatuses: options.statuses,
            groupBy: options.groupBy,
            includeEmpty: options.includeEmpty,
            includeLinks: options.includeLinks,
            itemUrlBase: options.itemUrlBase,
            mode: options.mode,
            check: options.check,
        });
        const summary = buildSummary(options, result, outputPath);
        if (options.githubOutput)
            writeGitHubOutput(summary);
        if (options.githubStepSummary)
            writeGitHubStepSummary(result.markdown);
        if (options.json) {
            process.stdout.write(JSON.stringify(summary) + "\n");
        }
        else if (options.check) {
            console.error(result.changed ? `Changelog is out of date: ${outputPath}` : `Changelog is up to date: ${outputPath}`);
        }
        else {
            console.error(`Wrote ${outputPath}`);
        }
        if (options.check && result.changed)
            process.exit(1);
        return;
    }
    const generated = createChangelog({
        items,
        title: options.title,
        version: options.version,
        date: options.date,
        since: options.since,
        until: options.until,
        includeStatuses: options.statuses,
        groupBy: options.groupBy,
        includeEmpty: options.includeEmpty,
        includeLinks: options.includeLinks,
        itemUrlBase: options.itemUrlBase,
    });
    const existing = options.mode === "prepend" && existsSync(outputPath)
        ? readFileSync(outputPath, "utf-8")
        : undefined;
    const merged = options.mode === "prepend"
        ? mergeChangelog(existing, generated.markdown, { title: options.title })
        : { markdown: generated.markdown, action: "replaced", changed: true };
    if (options.stdout) {
        if (options.json) {
            const summary = buildSummary(options, {
                output: outputPath,
                markdown: merged.markdown,
                action: merged.action,
                changed: merged.changed,
                itemCount: generated.itemCount,
                bytes: Buffer.byteLength(merged.markdown, "utf-8"),
            });
            if (options.githubOutput)
                writeGitHubOutput(summary);
            if (options.githubStepSummary)
                writeGitHubStepSummary(merged.markdown);
            process.stdout.write(JSON.stringify(summary) + "\n");
            return;
        }
        if (options.githubStepSummary)
            writeGitHubStepSummary(merged.markdown);
        process.stdout.write(merged.markdown);
        return;
    }
}
function parseArgs(args) {
    const options = {
        output: "CHANGELOG.md",
        stdout: false,
        json: false,
        stdin: false,
        pmArgs: [],
        groupBy: "version",
        includeEmpty: false,
        includeLinks: false,
        mode: "replace",
        check: false,
        githubOutput: false,
        githubStepSummary: false,
        versionFromPackage: false,
        sincePreviousTag: false,
        untilReleaseTag: false,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case "--help":
            case "-h":
                printHelp();
                process.exit(0);
            case "--output":
            case "-o":
                options.output = requireValue(args, ++i, arg);
                break;
            case "--stdout":
                options.stdout = true;
                break;
            case "--json":
                options.json = true;
                break;
            case "--check":
                options.check = true;
                break;
            case "--github-output":
            case "--set-output":
                options.githubOutput = true;
                break;
            case "--github-step-summary":
                options.githubStepSummary = true;
                break;
            case "--input":
            case "-i":
                options.input = requireValue(args, ++i, arg);
                break;
            case "--stdin":
                options.stdin = true;
                break;
            case "--pm-root":
                options.pmRoot = requireValue(args, ++i, arg);
                break;
            case "--pm-bin":
                options.pmBin = requireValue(args, ++i, arg);
                break;
            case "--pm-arg":
                options.pmArgs.push(requireAnyValue(args, ++i, arg));
                break;
            case "--pm-cwd":
                options.pmCwd = requireValue(args, ++i, arg);
                break;
            case "--title":
                options.title = requireValue(args, ++i, arg);
                break;
            case "--version":
                options.version = requireValue(args, ++i, arg);
                break;
            case "--release-version-from-package":
                options.versionFromPackage = true;
                break;
            case "--date":
                options.date = requireValue(args, ++i, arg);
                break;
            case "--since":
                options.since = requireValue(args, ++i, arg);
                break;
            case "--since-previous-tag":
                options.sincePreviousTag = true;
                break;
            case "--until":
                options.until = requireValue(args, ++i, arg);
                break;
            case "--until-release-tag":
                options.untilReleaseTag = true;
                break;
            case "--status":
            case "--statuses":
                options.statuses = requireValue(args, ++i, arg)
                    .split(",")
                    .map((status) => status.trim())
                    .filter(Boolean);
                break;
            case "--group-by":
                options.groupBy = parseGroupBy(requireValue(args, ++i, arg));
                break;
            case "--mode":
                options.mode = parseMode(requireValue(args, ++i, arg));
                break;
            case "--include-empty":
                options.includeEmpty = true;
                break;
            case "--include-links":
                options.includeLinks = true;
                break;
            case "--no-links":
                options.includeLinks = false;
                break;
            case "--item-url-base":
                options.itemUrlBase = requireValue(args, ++i, arg);
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }
    return options;
}
function applyReleaseContext(options) {
    if (!options.versionFromPackage && !options.sincePreviousTag && !options.untilReleaseTag)
        return;
    const context = resolveReleaseContext({
        cwd: options.pmCwd ? resolve(options.pmCwd) : process.cwd(),
        version: options.version,
        versionFromPackage: options.versionFromPackage,
        since: options.since,
        sincePreviousTag: options.sincePreviousTag,
        until: options.until,
        untilReleaseTag: options.untilReleaseTag,
    });
    options.version = context.version;
    options.since = context.since;
    options.until = context.until;
}
async function loadItems(options) {
    if (options.stdin) {
        return parsePmItemsJson(await readStdin());
    }
    if (options.input) {
        return parsePmItemsJson(readFileSync(resolve(options.input), "utf-8"));
    }
    return readPmItems({
        pmRoot: options.pmRoot,
        pmBin: options.pmBin,
        pmArgs: options.pmArgs,
        cwd: options.pmCwd ? resolve(options.pmCwd) : undefined,
    });
}
function readStdin() {
    return new Promise((resolvePromise, reject) => {
        let data = "";
        stdin.setEncoding("utf-8");
        stdin.on("data", (chunk) => {
            data += chunk;
        });
        stdin.on("end", () => resolvePromise(data));
        stdin.on("error", reject);
    });
}
function parseGroupBy(value) {
    if (value === "version" || value === "release" || value === "milestone")
        return value;
    throw new Error("--group-by must be 'version', 'release', or 'milestone'");
}
function parseMode(value) {
    if (value === "replace" || value === "prepend")
        return value;
    throw new Error("--mode must be 'replace' or 'prepend'");
}
function buildSummary(options, result, output = result.output) {
    return {
        output,
        mode: options.mode,
        action: result.action,
        changed: result.changed,
        itemCount: result.itemCount,
        bytes: result.bytes,
        check: options.check,
        markdown: options.stdout ? result.markdown : undefined,
    };
}
function writeGitHubOutput(summary) {
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (!githubOutput) {
        throw new Error("--github-output requires the GITHUB_OUTPUT environment variable");
    }
    const lines = [
        `output=${String(summary.output ?? "")}`,
        `mode=${String(summary.mode ?? "")}`,
        `action=${String(summary.action ?? "")}`,
        `changed=${String(summary.changed ?? "")}`,
        `item_count=${String(summary.itemCount ?? "")}`,
        `bytes=${String(summary.bytes ?? "")}`,
    ];
    appendFileSync(githubOutput, `${lines.join("\n")}\n`, "utf-8");
}
function writeGitHubStepSummary(markdown) {
    const githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (!githubStepSummary) {
        throw new Error("--github-step-summary requires the GITHUB_STEP_SUMMARY environment variable");
    }
    appendFileSync(githubStepSummary, `${markdown.trimEnd()}\n`, "utf-8");
}
function requireValue(args, index, flag) {
    const value = args[index];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
function requireAnyValue(args, index, flag) {
    const value = args[index];
    if (!value) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
function printHelp() {
    process.stdout.write(`pm-changelog

Generate CHANGELOG.md from pm-cli items.

Usage:
  pm-changelog [options]

Options:
  -o, --output <file>       Write changelog to a file (default: CHANGELOG.md)
      --stdout              Print markdown instead of writing a file
      --json                Print a JSON summary for CI/runners
      --check               Do not write; exit 1 when output would change
      --github-output       Write summary fields to $GITHUB_OUTPUT
      --github-step-summary Append generated markdown to $GITHUB_STEP_SUMMARY
  -i, --input <file>        Read pm JSON from a file instead of running pm
      --stdin               Read pm JSON from stdin
      --pm-root <dir>       pm project root for "pm --path <dir> list-all --json"
      --pm-bin <file>       pm executable to run (default: pm)
      --pm-arg <arg>        Extra argument passed before "list-all --json" (repeatable)
      --pm-cwd <dir>        Working directory for running pm
      --title <text>        Changelog title (default: Changelog)
      --version <version>   Version heading (default: Unreleased)
      --release-version-from-package
                            Read version heading from nearest package.json
      --date <date>         Release date (default: today)
      --since <date>        Include items changed on or after this date
      --since-previous-tag  Derive --since from the previous git tag
      --until <date>        Include items changed on or before this date
      --until-release-tag   Derive --until from the current release tag when it exists
      --status <list>       Comma-separated statuses (default: closed)
      --group-by <mode>     version, release, or milestone (default: version)
      --mode <mode>         replace or prepend existing changelog (default: replace)
      --include-empty       Emit an empty release section when no items match
      --include-links       Include item URLs in generated entries (default: false)
      --item-url-base <url> Make item IDs clickable links: [pmc-abc]({url}/pmc-abc.toon)
`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map