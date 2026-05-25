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
    const visibleSections = options.includeEmpty
        ? sections
        : sections.filter((section) => section.items.length > 0);
    if (visibleSections.length === 0) {
        return {
            markdown: lines.join("\n").trimEnd() + "\n",
            sections,
            itemCount: 0,
        };
    }
    for (const section of visibleSections) {
        lines.push(`## ${section.heading}`, "");
        if (section.items.length === 0) {
            lines.push("No changes.", "");
            continue;
        }
        const grouped = groupByCategory(section.items);
        for (const category of CATEGORY_ORDER) {
            const categoryItems = grouped.get(category);
            if (!categoryItems || categoryItems.length === 0)
                continue;
            lines.push(`### ${category}`, "");
            for (const item of categoryItems) {
                lines.push(`- ${formatItem(item, options)}`);
            }
            lines.push("");
        }
    }
    return {
        markdown: lines.join("\n").trimEnd() + "\n",
        sections,
        itemCount: visibleSections.reduce((sum, section) => sum + section.items.length, 0),
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
function classifyItem(item) {
    const values = [
        item.type,
        ...(item.tags ?? []),
        item.title,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (hasAny(values, ["security", "cve", "vulnerability"]))
        return "Security";
    if (hasAny(values, ["deprecated", "deprecation"]))
        return "Deprecated";
    if (hasAny(values, ["removed", "remove", "deleted", "delete"]))
        return "Removed";
    if (hasAny(values, ["fix", "fixed", "bug", "bugfix", "hotfix", "regression"]))
        return "Fixed";
    if (hasAny(values, ["feature", "feat", "added", "add", "new"]))
        return "Added";
    if (hasAny(values, ["change", "changed", "refactor", "update", "updated", "improve"])) {
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
    return `${title}${id}${link}`;
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