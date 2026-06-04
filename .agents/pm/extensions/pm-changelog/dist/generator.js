import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const DEFAULT_TITLE = "Changelog";
const DEFAULT_STATUSES = ["closed"];
const DEFAULT_PM_JSON_MAX_BUFFER = 64 * 1024 * 1024;
const CATEGORY_ORDER = [
    "Added",
    "Changed",
    "Fixed",
    "Removed",
    "Security",
    "Deprecated",
    "Other",
];
export function generateChangelog(options) {
    return createChangelog(options).markdown;
}
export function createChangelog(options) {
    const title = options.title ?? DEFAULT_TITLE;
    const items = filterItems(options);
    const sections = buildSections(items, options);
    const lines = [`# ${title}`, ""];
    if (sections.length === 0) {
        if (options.includeEmpty) {
            const heading = buildVersionHeading(options.version, options.date);
            lines.push(`## ${heading}`, "", "No changes.", "");
        }
        return {
            markdown: lines.join("\n").trimEnd() + "\n",
            sections,
            itemCount: items.length,
        };
    }
    // Apply visibility before limiting so `--limit N` counts N releases that
    // actually render (empty windows like a fresh "Unreleased" don't consume a
    // slot). With no limit/since-version flags this is a pure identity pass.
    const candidateSections = options.includeEmpty
        ? sections
        : sections.filter((section) => section.items.length > 0);
    const visibleSections = limitSections(candidateSections, options);
    if (visibleSections.length === 0) {
        return {
            markdown: lines.join("\n").trimEnd() + "\n",
            sections,
            itemCount: 0,
        };
    }
    const sectionBy = options.sectionBy ?? "category";
    for (const section of visibleSections) {
        lines.push(`## ${section.heading}`, "");
        if (section.items.length === 0) {
            lines.push("No changes.", "");
            continue;
        }
        // OPT-IN (`--breaking-changes`): a dedicated heading listing breaking items
        // up front. Items still appear in their normal category/field group below,
        // so this is purely additive and absent by default.
        if (options.breakingChanges) {
            const breaking = section.items.filter(isBreakingItem);
            if (breaking.length > 0) {
                lines.push(`### ${maybeEmoji("Breaking Changes", options)}`, "");
                for (const item of breaking) {
                    lines.push(`- ${formatItem(item, options)}`);
                }
                lines.push("");
            }
        }
        if (sectionBy === "category") {
            const grouped = groupByCategory(section.items);
            for (const category of CATEGORY_ORDER) {
                const categoryItems = grouped.get(category);
                if (!categoryItems || categoryItems.length === 0)
                    continue;
                // OPT-IN: --conventional remaps the heading text only; item order,
                // bucketing, and bullet rendering are untouched, so dropping the flag
                // restores byte-identical output.
                const heading = options.conventional ? CONVENTIONAL_HEADINGS[category] : category;
                lines.push(`### ${maybeEmoji(heading, options)}`, "");
                for (const item of categoryItems) {
                    lines.push(`- ${formatItem(item, options)}`);
                }
                lines.push("");
            }
        }
        else {
            for (const group of groupByField(section.items, sectionBy)) {
                lines.push(`### ${maybeEmoji(group.heading, options)}`, "");
                for (const item of group.items) {
                    lines.push(`- ${formatItem(item, options)}`);
                }
                lines.push("");
            }
        }
        if (options.contributors) {
            const names = collectContributors(section.items);
            if (names.length > 0) {
                lines.push("### Contributors", "");
                lines.push(names.map((name) => `@${name}`).join(", "));
                lines.push("");
            }
        }
    }
    return {
        markdown: lines.join("\n").trimEnd() + "\n",
        sections,
        itemCount: visibleSections.reduce((sum, section) => sum + section.items.length, 0),
    };
}
/**
 * OPT-IN (`--limit` / `--since-version`): restrict release sections to the
 * most recent N or to those at or newer than a version. Only release-window
 * sections (the `## version - date` history rebuilt by `--all-release-tags`)
 * are eligible; the leading `Unreleased` section is always kept. When neither
 * option is set this is an identity pass, preserving default output exactly.
 */
function limitSections(sections, options) {
    const limit = options.limit && options.limit > 0 ? options.limit : undefined;
    const sinceVersion = options.sinceVersion?.trim()
        ? normalizeReleaseKey(options.sinceVersion)
        : undefined;
    if (limit === undefined && sinceVersion === undefined)
        return sections;
    if (!options.releaseWindows || options.releaseWindows.length === 0)
        return sections;
    let result = sections;
    if (sinceVersion !== undefined) {
        result = result.filter((section) => {
            const key = sectionVersionKey(section.heading);
            if (key === undefined)
                return true; // keep Unreleased and unparsable headings
            return compareVersionStrings(key, sinceVersion) >= 0;
        });
    }
    if (limit !== undefined && result.length > limit) {
        result = result.slice(0, limit);
    }
    return result;
}
function sectionVersionKey(heading) {
    const version = heading.split(/\s+-\s+/, 1)[0]?.trim() ?? heading.trim();
    if (!version || version.toLowerCase() === "unreleased")
        return undefined;
    return normalizeReleaseKey(version);
}
/**
 * OPT-IN (`--changelog-json`): build a structured representation of the
 * changelog (releases -> sections -> items) for downstream tooling. This is
 * deliberately distinct from the `--json` CLI summary (action/bytes/changed)
 * and from the `changelog export --format json` payload (which wraps markdown).
 * It applies the same filtering, limiting and grouping as the markdown path so
 * the two stay in sync, but emits structured data instead of rendered text.
 */
export function buildChangelogDocument(options) {
    const filtered = filterItems(options);
    const sections = buildSections(filtered, options);
    const candidateSections = options.includeEmpty
        ? sections
        : sections.filter((section) => section.items.length > 0);
    const visibleSections = limitSections(candidateSections, options);
    const sectionBy = options.sectionBy ?? "category";
    const releases = visibleSections.map((section) => {
        const sectionGroups = [];
        if (sectionBy === "category") {
            const grouped = groupByCategory(section.items);
            for (const category of CATEGORY_ORDER) {
                const categoryItems = grouped.get(category);
                if (!categoryItems || categoryItems.length === 0)
                    continue;
                const heading = options.conventional ? CONVENTIONAL_HEADINGS[category] : category;
                sectionGroups.push({ heading, items: categoryItems.map(toDocumentItem) });
            }
        }
        else {
            for (const group of groupByField(section.items, sectionBy)) {
                sectionGroups.push({ heading: group.heading, items: group.items.map(toDocumentItem) });
            }
        }
        return {
            heading: section.heading,
            version: sectionVersionKey(section.heading),
            item_count: section.items.length,
            sections: sectionGroups,
            contributors: options.contributors ? collectContributors(section.items) : undefined,
            breaking_changes: options.breakingChanges
                ? section.items.filter(isBreakingItem).map(toDocumentItem)
                : undefined,
        };
    });
    return {
        title: options.title ?? DEFAULT_TITLE,
        group_by: options.groupBy ?? "version",
        section_by: sectionBy,
        item_count: visibleSections.reduce((sum, section) => sum + section.items.length, 0),
        releases,
        suggested_semver: options.suggestSemver ? suggestSemver(options) : undefined,
    };
}
function toDocumentItem(item) {
    return {
        id: item.id,
        title: toSingleLine(item.title),
        type: item.type,
        status: item.status,
        tags: item.tags,
        url: item.url,
    };
}
export function mergeChangelog(existingMarkdown, generatedMarkdown, options = {}) {
    const existing = existingMarkdown?.trimEnd();
    const generated = generatedMarkdown.trimEnd();
    if (!existing) {
        return {
            markdown: generated + "\n",
            action: "created",
            changed: true,
        };
    }
    const releaseSections = extractReleaseSections(generated);
    if (releaseSections.length === 0) {
        const unchanged = existing + "\n";
        return {
            markdown: unchanged,
            action: "unchanged",
            changed: false,
        };
    }
    let next = ensureTitle(existing, options.title);
    let action = "unchanged";
    for (const releaseSection of releaseSections) {
        const replacement = releaseSection.markdown.trimEnd();
        const replaced = replaceReleaseSection(next, releaseSection.heading, replacement);
        if (replaced.replaced) {
            next = replaced.markdown;
            action = "replaced";
            continue;
        }
        next = insertAfterTitle(next, replacement);
        if (action !== "replaced")
            action = "inserted";
    }
    next = next.trimEnd() + "\n";
    return {
        markdown: next,
        action,
        changed: next !== existing + "\n",
    };
}
export function readPmItems(options = {}) {
    const pmBin = options.pmBin ?? "pm";
    const args = [...(options.pmArgs ?? []), "list-all", "--json"];
    if (options.pmRoot) {
        args.unshift("--path", options.pmRoot);
    }
    const result = spawnSync(pmBin, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf-8",
        maxBuffer: options.maxBuffer ?? DEFAULT_PM_JSON_MAX_BUFFER,
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || `${pmBin} list-all --json failed`);
    }
    return parsePmItemsJson(result.stdout);
}
export function writeChangelog(options) {
    const output = resolve(options.output ?? "CHANGELOG.md");
    const generated = createChangelog(options);
    const mode = options.mode ?? "replace";
    const existing = existsSync(output) ? readFileSync(output, "utf-8") : undefined;
    const merged = mode === "prepend"
        ? mergeChangelog(existing, generated.markdown, { title: options.title })
        : replaceChangelog(existing, generated.markdown);
    if (!options.check) {
        writeFileSync(output, merged.markdown, "utf-8");
    }
    return {
        output,
        markdown: merged.markdown,
        action: merged.action,
        changed: merged.changed,
        itemCount: generated.itemCount,
        bytes: Buffer.byteLength(merged.markdown, "utf-8"),
    };
}
export function parsePmItemsJson(raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
        return parsed;
    if (isRecord(parsed) && Array.isArray(parsed.items))
        return parsed.items;
    throw new Error("Expected pm JSON to be an array or an object with an items array");
}
function replaceChangelog(existingMarkdown, generatedMarkdown) {
    const generated = generatedMarkdown.trimEnd() + "\n";
    const existing = existingMarkdown?.trimEnd();
    if (!existing) {
        return {
            markdown: generated,
            action: "created",
            changed: true,
        };
    }
    const changed = generated !== existing + "\n";
    return {
        markdown: generated,
        action: changed ? "replaced" : "unchanged",
        changed,
    };
}
function filterItems(options) {
    const items = filterItemsByStatus(options);
    if (options.releaseWindows && options.releaseWindows.length > 0)
        return items;
    return filterItemsByTime(items, {
        since: options.since,
        until: options.until,
    });
}
function filterItemsByStatus(options) {
    const statuses = new Set((options.includeStatuses ?? DEFAULT_STATUSES).map((status) => status.toLowerCase()));
    return options.items
        .filter((item) => item.title)
        .filter((item) => {
        if (statuses.size === 0)
            return true;
        return statuses.has(String(item.status ?? "").toLowerCase());
    })
        .sort(compareItems);
}
function buildSections(items, options) {
    if (options.releaseWindows && options.releaseWindows.length > 0) {
        return assignItemsToReleaseWindows(items, options.releaseWindows);
    }
    if (options.groupBy === "release" && !options.version) {
        return groupSectionsByMetadata(items, "release", "Unreleased");
    }
    if (options.groupBy === "milestone" && !options.version) {
        return groupSectionsByMetadata(items, "milestone", "Unreleased");
    }
    return [
        {
            heading: buildVersionHeading(options.version, options.date),
            items,
        },
    ];
}
function assignItemsToReleaseWindows(items, windows) {
    const buckets = new Map();
    for (const window of windows)
        buckets.set(window.heading, []);
    const releaseIndex = new Map();
    for (const window of windows) {
        if (!window.releaseTag)
            continue;
        const key = normalizeReleaseKey(window.releaseTag);
        if (!key || releaseIndex.has(key))
            continue;
        releaseIndex.set(key, window.heading);
    }
    const remaining = [];
    for (const item of items) {
        const releaseField = getStringField(item, "release");
        const key = releaseField ? normalizeReleaseKey(releaseField) : "";
        const heading = key ? releaseIndex.get(key) : undefined;
        if (heading) {
            buckets.get(heading).push(item);
            continue;
        }
        remaining.push(item);
    }
    for (const window of windows) {
        const filtered = filterItemsByTime(remaining, window);
        buckets.get(window.heading).push(...filtered);
    }
    return windows.map((window) => ({
        heading: window.heading,
        items: buckets.get(window.heading) ?? [],
    }));
}
function normalizeReleaseKey(value) {
    return value.trim().replace(/^v/i, "").toLowerCase();
}
function filterItemsByTime(items, window) {
    const since = window.since ? Date.parse(window.since) : undefined;
    const until = window.until ? Date.parse(window.until) : undefined;
    return items.filter((item) => {
        const timestamp = itemTimestamp(item);
        if (!timestamp)
            return since === undefined && until === undefined;
        const value = Date.parse(timestamp);
        if (Number.isNaN(value))
            return false;
        if (since !== undefined && (window.sinceExclusive ? value <= since : value < since))
            return false;
        if (until !== undefined && value > until)
            return false;
        return true;
    });
}
function groupSectionsByMetadata(items, field, fallback) {
    const grouped = new Map();
    for (const item of items) {
        const key = getStringField(item, field) || fallback;
        const group = grouped.get(key) ?? [];
        group.push(item);
        grouped.set(key, group);
    }
    return Array.from(grouped.entries())
        .map(([heading, groupedItems]) => ({ heading, items: groupedItems }))
        .sort((a, b) => compareVersionHeadings(a.heading, b.heading, fallback));
}
function compareVersionHeadings(a, b, fallback) {
    if (a === fallback)
        return -1;
    if (b === fallback)
        return 1;
    return compareVersionStrings(b, a);
}
function compareVersionStrings(a, b) {
    const normalize = (v) => v.replace(/^v/, "");
    const segmentsA = normalize(a).split(/[.\-]/);
    const segmentsB = normalize(b).split(/[.\-]/);
    const len = Math.max(segmentsA.length, segmentsB.length);
    for (let i = 0; i < len; i++) {
        const sa = segmentsA[i] ?? "";
        const sb = segmentsB[i] ?? "";
        const na = parseInt(sa, 10);
        const nb = parseInt(sb, 10);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) {
            if (na !== nb)
                return na - nb;
        }
        else {
            const cmp = sa.localeCompare(sb);
            if (cmp !== 0)
                return cmp;
        }
    }
    return 0;
}
function buildVersionHeading(version, date) {
    const heading = version?.trim() || "Unreleased";
    const stamp = date?.trim() || formatLocalDate(new Date());
    return `${heading} - ${stamp}`;
}
function extractReleaseSections(markdown) {
    const releaseHeading = /^##\s+(.+)$/gm;
    const matches = Array.from(markdown.matchAll(releaseHeading));
    return matches.map((match, index) => {
        const start = match.index ?? 0;
        const next = matches[index + 1];
        const end = next?.index ?? markdown.length;
        return {
            heading: match[1].trim(),
            markdown: markdown.slice(start, end).trimEnd(),
        };
    });
}
function replaceReleaseSection(markdown, heading, replacement) {
    const releaseHeading = /^##\s+(.+)$/gm;
    const matches = Array.from(markdown.matchAll(releaseHeading));
    const targetHeadingKey = normalizeReleaseHeadingKey(heading);
    const matchIndex = matches.findIndex((match) => normalizeReleaseHeadingKey(match[1].trim()) === targetHeadingKey);
    if (matchIndex === -1)
        return { markdown, replaced: false };
    const match = matches[matchIndex];
    const start = match.index ?? 0;
    const nextMatch = matches[matchIndex + 1];
    const end = nextMatch?.index ?? markdown.length;
    const before = markdown.slice(0, start).trimEnd();
    const after = markdown.slice(end).trimStart();
    const merged = after ? `${before}\n\n${replacement}\n\n${after}` : `${before}\n\n${replacement}`;
    return { markdown: merged, replaced: true };
}
function normalizeReleaseHeadingKey(heading) {
    const trimmed = heading.trim();
    const bracketed = trimmed.match(/^\[([^\]]+)\](?:\([^)]+\))?(?:\s+-\s+.+)?$/);
    const version = bracketed?.[1] ?? trimmed.split(/\s+-\s+/, 1)[0] ?? trimmed;
    return version.trim().replace(/^v/i, "").toLowerCase();
}
function ensureTitle(markdown, title) {
    if (/^#\s+.+$/m.test(markdown))
        return markdown;
    return `# ${title ?? DEFAULT_TITLE}\n\n${markdown.trimStart()}`;
}
function insertAfterTitle(markdown, releaseSection) {
    const titleMatch = markdown.match(/^#\s+.+$/m);
    if (!titleMatch || titleMatch.index === undefined) {
        return `${releaseSection}\n\n${markdown.trimStart()}`;
    }
    const titleEnd = titleMatch.index + titleMatch[0].length;
    const before = markdown.slice(0, titleEnd).trimEnd();
    const after = markdown.slice(titleEnd).trim();
    if (!after)
        return `${before}\n\n${releaseSection}`;
    return `${before}\n\n${releaseSection}\n\n${after}`;
}
// OPT-IN (`--conventional`): keep-a-changelog category -> Conventional-Commits
// style heading. Every key maps so the mapping is total; values mirror common
// conventional-changelog section titles.
const CONVENTIONAL_HEADINGS = {
    Added: "Features",
    Changed: "Changes",
    Fixed: "Bug Fixes",
    Removed: "Reverts",
    Security: "Security",
    Deprecated: "Deprecations",
    Other: "Other",
};
/**
 * OPT-IN (`--section-by type|status|label`): group a release's items by a
 * single item field instead of the keep-a-changelog category. Groups are
 * ordered by first appearance (items arrive pre-sorted by `compareItems`), so
 * output is deterministic. Items missing the field fall into an "Other" /
 * "Unlabeled" bucket. For `label`, an item may appear under several headings
 * (one per tag) — this is by design and clearly opt-in.
 */
function groupByField(items, sectionBy) {
    const groups = new Map();
    const push = (heading, item) => {
        const bucket = groups.get(heading) ?? [];
        bucket.push(item);
        groups.set(heading, bucket);
    };
    for (const item of items) {
        if (sectionBy === "type") {
            push(titleCase(typeof item.type === "string" && item.type.trim() ? item.type.trim() : "Other"), item);
        }
        else if (sectionBy === "status") {
            push(titleCase(typeof item.status === "string" && item.status.trim() ? item.status.trim() : "Unknown"), item);
        }
        else {
            const tags = [
                ...new Set((Array.isArray(item.tags) ? item.tags : [])
                    .filter((tag) => typeof tag === "string")
                    .map((tag) => tag.trim())
                    .filter(Boolean)),
            ];
            if (tags.length === 0) {
                push("Unlabeled", item);
            }
            else {
                for (const tag of tags)
                    push(tag, item);
            }
        }
    }
    return Array.from(groups.entries()).map(([heading, groupedItems]) => ({ heading, items: groupedItems }));
}
function titleCase(value) {
    return value
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
/**
 * OPT-IN (`--contributors`): unique contributor handles for a release, ordered
 * by first appearance. Prefers `assignee`, falls back to `author`; ignores the
 * `unknown` placeholder pm writes when no author is recorded.
 */
function collectContributors(items) {
    const seen = new Set();
    const ordered = [];
    for (const item of items) {
        const candidate = pickContributor(item.assignee) ?? pickContributor(item.author);
        if (!candidate)
            continue;
        const key = candidate.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        ordered.push(candidate);
    }
    return ordered;
}
function pickContributor(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "unknown")
        return undefined;
    return trimmed;
}
function groupByCategory(items) {
    const grouped = new Map();
    for (const item of items) {
        const category = classifyItem(item);
        const categoryItems = grouped.get(category) ?? [];
        categoryItems.push(item);
        grouped.set(category, categoryItems);
    }
    return grouped;
}
const BUG_LIKE_ITEM_TYPES = new Set(["issue", "bug", "bugfix", "defect"]);
function classifyItem(item) {
    // Strip CLI-flag-like tokens from titles before scanning. Without this, an
    // item titled "pm <cmd> --add fails..." gets classified as "Added" because
    // the word "add" matches inside "--add". The pattern:
    //   - Negative lookbehind on `[\w-]` so in-word hyphens like "non-add" or
    //     "in-test" stay intact, while flags wrapped in punctuation/quotes
    //     (`\`--add\``, `(--add)`, `[--add]`) still match.
    //   - Accepts 1 or 2 leading dashes (covers `-x` POSIX shorts too).
    //   - First char after the dashes is alnum (lets `--2fa` work).
    //   - Body is the alnum/underscore/hyphen flag name, optionally followed by
    //     `=<value>` where value runs to the next whitespace. This wholesale
    //     strips `--url=https://example.com/add` so URL/path values don't leak
    //     spurious keyword matches downstream.
    //
    // Tags and type still contribute their full token, so an explicit
    // `feature`/`added` tag still wins regardless of title content.
    const sanitizedTitle = (item.title ?? "").replace(/(?<![\w-])-{1,2}[a-z0-9][\w-]*(?:=\S*)?/gi, " ");
    // Two signal tiers:
    //  - STRONG: item type + tags. These are author-controlled, deliberate
    //    classification metadata, so an explicit `refactor` tag (or a bug-like
    //    type) is trusted fully.
    //  - WEAK: the (flag-stripped) title. Descriptive prose collides with CLI
    //    command names — "pm update doesn't accept …" is a defect in the `pm
    //    update` command, not a "Changed" entry — so the title is only consulted
    //    as a fallback, after the bug-like type default.
    const strongValues = [item.type, ...(item.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
    const titleValue = sanitizedTitle.toLowerCase();
    const allValues = `${strongValues} ${titleValue}`.trim();
    const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
    const CHANGED_NEEDLES = ["change", "changed", "refactor", "update", "updated", "improve"];
    if (hasAny(allValues, ["security", "cve", "vulnerability"]))
        return "Security";
    if (hasAny(allValues, ["deprecated", "deprecation"]))
        return "Deprecated";
    if (hasAny(allValues, ["removed", "remove", "deleted", "delete"]))
        return "Removed";
    if (hasAny(allValues, ["fix", "fixed", "bug", "bugfix", "hotfix", "regression"]))
        return "Fixed";
    if (hasAny(allValues, ["feature", "feat", "added", "add", "new"]))
        return "Added";
    // An explicit Changed signal in the STRONG tier (type/tags) wins over the
    // bug-like-type default, mirroring how an explicit `feature` tag routes to
    // Added — so `Issue` + `tags: ["refactor"]` is still Changed.
    if (hasAny(strongValues, CHANGED_NEEDLES))
        return "Changed";
    // Default by item type: Issue / Bug / Bugfix / Defect → Fixed (most items of
    // these types are bug reports). This runs BEFORE the weak title-only Changed
    // check so command-name keywords ("update"/"change") in a defect title don't
    // misroute it. Non-bug types (task / chore) fall through to the title check
    // for genuine "update dependency …" / "improve …" work.
    if (BUG_LIKE_ITEM_TYPES.has(itemType)) {
        return "Fixed";
    }
    if (hasAny(titleValue, CHANGED_NEEDLES)) {
        return "Changed";
    }
    return "Other";
}
function hasAny(value, needles) {
    return needles.some((needle) => new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(value));
}
function formatItem(item, options) {
    const title = escapeMarkdown(toSingleLine(item.title));
    const id = formatItemId(item, options);
    const link = options.includeLinks ? formatLink(item.url) : "";
    const preview = formatBodyPreview(item, options);
    return `${title}${id}${link}${preview}`;
}
/**
 * OPT-IN (`--body-preview <n>`): append a truncated, single-lined, escaped
 * preview of the item body. Returns "" when the flag is unset/0 or the item has
 * no body, so default output is byte-identical. Truncation appends an ellipsis
 * only when the body actually exceeds N characters.
 */
function formatBodyPreview(item, options) {
    const limit = options.bodyPreview && options.bodyPreview > 0 ? options.bodyPreview : 0;
    if (limit === 0)
        return "";
    const body = typeof item.body === "string" ? toSingleLine(item.body) : "";
    if (!body)
        return "";
    const truncated = body.length > limit ? `${body.slice(0, limit)}…` : body;
    return ` — ${escapeMarkdown(truncated)}`;
}
/**
 * OPT-IN (`--emoji-prefix`): prefix a known heading with a conventional emoji.
 * Unknown headings (custom labels/types) pass through unchanged. Off by
 * default, so headings render exactly as before.
 */
function maybeEmoji(heading, options) {
    if (!options.emojiPrefix)
        return heading;
    const emoji = HEADING_EMOJI[heading];
    return emoji ? `${emoji} ${heading}` : heading;
}
const HEADING_EMOJI = {
    // keep-a-changelog categories
    Added: "🎉",
    Changed: "♻️",
    Fixed: "🐛",
    Removed: "🗑️",
    Security: "🔒",
    Deprecated: "⚠️",
    Other: "📦",
    // conventional-commits headings (when --conventional is also set)
    Features: "🎉",
    Changes: "♻️",
    "Bug Fixes": "🐛",
    Reverts: "⏪",
    Deprecations: "⚠️",
    // breaking changes section
    "Breaking Changes": "💥",
};
/**
 * Detect whether an item is a breaking change. Signals (any one suffices):
 *  - a truthy `breaking` flag on the item or in its metadata, OR
 *  - the substring "breaking" appearing in the type, any tag, or the title.
 * Used only by the opt-in `--breaking-changes` / `--suggest-semver` features.
 */
function isBreakingItem(item) {
    if (isTruthyFlag(item.breaking))
        return true;
    if (isTruthyFlag(item.metadata?.["breaking"]))
        return true;
    const haystack = [
        typeof item.type === "string" ? item.type : "",
        ...(Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string") : []),
        typeof item.title === "string" ? item.title : "",
    ]
        .join(" ")
        .toLowerCase();
    return haystack.includes("breaking");
}
function isTruthyFlag(value) {
    if (value === true)
        return true;
    if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        return v === "true" || v === "yes" || v === "1";
    }
    if (typeof value === "number")
        return value === 1;
    return false;
}
/**
 * OPT-IN (`--suggest-semver`): classify the in-scope items into breaking /
 * feature / fix / other and recommend a semver bump. Emitted as JSON or a
 * footer note; never alters default markdown.
 */
export function suggestSemver(options) {
    const items = filterItems(options);
    let breaking = 0;
    let feature = 0;
    let fix = 0;
    let other = 0;
    for (const item of items) {
        if (isBreakingItem(item)) {
            breaking++;
            continue;
        }
        const category = classifyItem(item);
        if (category === "Added")
            feature++;
        else if (category === "Fixed")
            fix++;
        else
            other++;
    }
    let bump;
    let reason;
    if (breaking > 0) {
        bump = "major";
        reason = `${breaking} breaking change${breaking === 1 ? "" : "s"}`;
    }
    else if (feature > 0) {
        bump = "minor";
        reason = `${feature} feature${feature === 1 ? "" : "s"}`;
    }
    else if (fix > 0) {
        bump = "patch";
        reason = `${fix} fix${fix === 1 ? "" : "es"}`;
    }
    else if (other > 0) {
        bump = "patch";
        reason = `${other} other change${other === 1 ? "" : "s"}`;
    }
    else {
        bump = "none";
        reason = "no changes";
    }
    return { bump, reason, counts: { breaking, feature, fix, other } };
}
function formatItemId(item, options) {
    if (!item.id)
        return "";
    const escapedId = escapeMarkdown(item.id);
    if (options.itemUrlBase) {
        const base = options.itemUrlBase.replace(/\/$/, "");
        const typeDir = itemTypeToDir(item.type);
        const url = `${base}/${typeDir}/${item.id}.toon`;
        return ` ([${escapedId}](${url}))`;
    }
    return ` (${escapedId})`;
}
function itemTypeToDir(type) {
    const t = (type ?? "issue").toLowerCase();
    const irregular = { story: "stories" };
    return irregular[t] ?? `${t}s`;
}
function formatLink(url) {
    if (!url)
        return "";
    try {
        const parsed = new URL(toSingleLine(url));
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
            return "";
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return ` [link](${parsed.href.replace(/\)/g, "%29")})`;
    }
    catch {
        return "";
    }
}
function getStringField(item, field) {
    const direct = item[field];
    if (typeof direct === "string" && direct.trim())
        return direct.trim();
    const fromMetadata = item.metadata?.[field];
    if (typeof fromMetadata === "string" && fromMetadata.trim())
        return fromMetadata.trim();
    return undefined;
}
function compareItems(a, b) {
    const aTime = Date.parse(itemTimestamp(a) ?? "");
    const bTime = Date.parse(itemTimestamp(b) ?? "");
    if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
        return bTime - aTime;
    }
    return a.title.localeCompare(b.title);
}
function itemTimestamp(item) {
    return item.closed_at ?? item.updated_at ?? item.created_at;
}
function escapeMarkdown(value) {
    return value.replace(/([\\`*_[\]()#|>])/g, "\\$1");
}
function toSingleLine(value) {
    return value.trim().replace(/\s+/g, " ");
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
//# sourceMappingURL=generator.js.map