import fs from "node:fs/promises";
import path from "node:path";
import { DEPENDENCY_KIND_VALUES, EXIT_CODE, PmCliError, canonicalDocument, commitImportedItem, generateItemId, getActiveExtensionRegistrations, getItemPath, isTimestampLiteral, locateItem, normalizeFrontMatter, normalizeItemId, normalizeRawItemId, nowIso, pathExists, readSettings, resolveItemTypeRegistry, resolvePmRoot, runActiveOnReadHooks, ensureTrackerInitialized, selectImportAuthor, toEstimatedMinutesValue, toImportPriority, toImportStatus, toImportTags, toNonEmptyImportString, } from "../../../../dist/sdk/index.js";
const PRIMARY_AUTO_DISCOVERY_FILES = [
    ".beads/issues.jsonl",
    "issues.jsonl",
];
const UNSAFE_AUTO_DISCOVERY_FILES = [
    ".beads/sync_base.jsonl",
    "sync_base.jsonl",
];
// Shared, behavior-identical value coercers are sourced from the SDK adapter
// surface; package-specific mappings (timestamps, item types, dependencies,
// linked artifacts) stay local below.
const toNonEmptyString = toNonEmptyImportString;
const toEstimatedMinutes = toEstimatedMinutesValue;
const toPriority = toImportPriority;
const toTags = toImportTags;
function toIsoString(value) {
    const raw = toNonEmptyString(value);
    if (!raw) {
        return undefined;
    }
    if (!isTimestampLiteral(raw)) {
        return undefined;
    }
    return raw;
}
function toItemType(value) {
    const raw = toNonEmptyString(value);
    const normalized = raw?.toLowerCase();
    switch (normalized) {
        case "epic":
            return { type: "Epic" };
        case "feature":
            return { type: "Feature" };
        case "task":
            return { type: "Task" };
        case "chore":
            return { type: "Chore" };
        case "issue":
            return { type: "Issue" };
        case "bug":
            return { type: "Issue", sourceType: raw };
        case "event":
            return { type: "Task", sourceType: raw };
        default:
            return { type: "Task", sourceType: raw };
    }
}
const toStatus = toImportStatus;
function toDependencyKind(value) {
    const raw = toNonEmptyString(value);
    const normalized = raw?.toLowerCase();
    if (!normalized) {
        return { kind: "related" };
    }
    const preserveIfChanged = (kind) => ({
        kind,
        sourceKind: normalized === kind ? undefined : raw,
    });
    if (DEPENDENCY_KIND_VALUES.includes(normalized)) {
        return preserveIfChanged(normalized);
    }
    switch (normalized) {
        case "parent-child":
            return preserveIfChanged("parent_child");
        case "child-of":
            return preserveIfChanged("child_of");
        case "related-to":
        case "relates-to":
            return preserveIfChanged("related_to");
        case "discovered-from":
            return preserveIfChanged("discovered_from");
        case "blocked-by":
            return preserveIfChanged("blocked_by");
        case "incident-from":
            return preserveIfChanged("incident_from");
        default:
            return {
                kind: "related",
                sourceKind: raw,
            };
    }
}
function normalizeImportedId(id, prefix, preserveSourceIds) {
    return preserveSourceIds ? normalizeRawItemId(id) : normalizeItemId(id, prefix);
}
function toDependencies(value, fallbackCreatedAt, prefix, preserveSourceIds) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const dependencies = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const id = toNonEmptyString(entry);
            if (!id) {
                continue;
            }
            dependencies.push({
                id: normalizeImportedId(id, prefix, preserveSourceIds),
                kind: "related",
                created_at: fallbackCreatedAt,
            });
            continue;
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry;
        const id = toNonEmptyString(candidate.id) ?? toNonEmptyString(candidate.item_id) ?? toNonEmptyString(candidate.depends_on_id);
        if (!id) {
            continue;
        }
        const dependencyKind = toDependencyKind(candidate.type ?? candidate.kind);
        dependencies.push({
            id: normalizeImportedId(id, prefix, preserveSourceIds),
            kind: dependencyKind.kind,
            created_at: toIsoString(candidate.created_at) ?? fallbackCreatedAt,
            author: toNonEmptyString(candidate.author) ?? toNonEmptyString(candidate.created_by),
            source_kind: dependencyKind.sourceKind,
        });
    }
    return dependencies.length > 0 ? dependencies : undefined;
}
function toLogEntries(value, fallbackCreatedAt, fallbackAuthor) {
    if (typeof value === "string") {
        const text = toNonEmptyString(value);
        if (!text) {
            return undefined;
        }
        return [
            {
                created_at: fallbackCreatedAt,
                author: fallbackAuthor,
                text,
            },
        ];
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const text = toNonEmptyString(entry);
            if (!text) {
                continue;
            }
            entries.push({
                created_at: fallbackCreatedAt,
                author: fallbackAuthor,
                text,
            });
            continue;
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry;
        const text = toNonEmptyString(candidate.text) ??
            toNonEmptyString(candidate.comment) ??
            toNonEmptyString(candidate.note) ??
            toNonEmptyString(candidate.learning);
        if (!text) {
            continue;
        }
        entries.push({
            created_at: toIsoString(candidate.created_at) ?? fallbackCreatedAt,
            author: toNonEmptyString(candidate.author) ?? fallbackAuthor,
            text,
        });
    }
    return entries.length > 0 ? entries : undefined;
}
function toLinkedFiles(value) {
    if (typeof value === "string") {
        const p = toNonEmptyString(value);
        if (!p)
            return undefined;
        return [{ path: p, scope: "project" }];
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    const files = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const p = toNonEmptyString(entry);
            if (p)
                files.push({ path: p, scope: "project" });
            continue;
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry;
        const p = toNonEmptyString(candidate.path) ?? toNonEmptyString(candidate.file);
        if (!p)
            continue;
        files.push({
            path: p,
            scope: toNonEmptyString(candidate.scope) === "global" ? "global" : "project",
            note: toNonEmptyString(candidate.note),
        });
    }
    return files.length > 0 ? files : undefined;
}
function toLinkedTests(value) {
    if (typeof value === "string") {
        const c = toNonEmptyString(value);
        if (!c)
            return undefined;
        return [{ command: c, scope: "project" }];
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    const tests = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const c = toNonEmptyString(entry);
            if (c)
                tests.push({ command: c, scope: "project" });
            continue;
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry;
        const command = toNonEmptyString(candidate.command) ?? toNonEmptyString(candidate.test);
        const p = toNonEmptyString(candidate.path);
        if (!command && !p)
            continue;
        let timeout;
        if (typeof candidate.timeout_seconds === "number" && Number.isFinite(candidate.timeout_seconds)) {
            timeout = candidate.timeout_seconds;
        }
        else if (typeof candidate.timeout_seconds === "string") {
            const parsed = Number(candidate.timeout_seconds);
            if (Number.isFinite(parsed) && parsed >= 0) {
                timeout = parsed;
            }
        }
        tests.push({
            command,
            path: p,
            scope: toNonEmptyString(candidate.scope) === "global" ? "global" : "project",
            timeout_seconds: timeout,
            note: toNonEmptyString(candidate.note),
        });
    }
    return tests.length > 0 ? tests : undefined;
}
function toLinkedDocs(value) {
    if (typeof value === "string") {
        const p = toNonEmptyString(value);
        if (!p)
            return undefined;
        return [{ path: p, scope: "project" }];
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    const docs = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const p = toNonEmptyString(entry);
            if (p)
                docs.push({ path: p, scope: "project" });
            continue;
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }
        const candidate = entry;
        const p = toNonEmptyString(candidate.path) ?? toNonEmptyString(candidate.doc);
        if (!p)
            continue;
        docs.push({
            path: p,
            scope: toNonEmptyString(candidate.scope) === "global" ? "global" : "project",
            note: toNonEmptyString(candidate.note),
        });
    }
    return docs.length > 0 ? docs : undefined;
}
const selectAuthor = selectImportAuthor;
const ensureInitHasRun = ensureTrackerInitialized;
function resolveInputPath(rawPath) {
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}
async function readStdin() {
    if (process.stdin.isTTY === true) {
        throw new PmCliError('--file value "-" requires piped stdin input. Pipe JSONL content into the command, or end manual stdin with Ctrl+D (Unix/macOS) or Ctrl+Z then Enter (Windows).', EXIT_CODE.USAGE);
    }
    return await new Promise((resolve, reject) => {
        let raw = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            raw += chunk;
        });
        process.stdin.on("end", () => resolve(raw));
        process.stdin.on("error", reject);
    });
}
async function resolveBeadsSource(rawPath) {
    const explicitSource = toNonEmptyString(rawPath);
    if (explicitSource) {
        if (explicitSource === "-") {
            return {
                source: "-",
                raw: await readStdin(),
                warnings: [],
            };
        }
        const explicitPath = resolveInputPath(explicitSource);
        if (!(await pathExists(explicitPath))) {
            throw new PmCliError(`Beads source file not found at ${explicitPath}`, EXIT_CODE.NOT_FOUND);
        }
        return {
            source: explicitSource,
            sourcePath: explicitPath,
            raw: await fs.readFile(explicitPath, "utf8"),
            warnings: [],
        };
    }
    for (const candidate of PRIMARY_AUTO_DISCOVERY_FILES) {
        const candidatePath = resolveInputPath(candidate);
        if (await pathExists(candidatePath)) {
            return {
                source: candidate,
                sourcePath: candidatePath,
                raw: await fs.readFile(candidatePath, "utf8"),
                warnings: candidate === PRIMARY_AUTO_DISCOVERY_FILES[0] ? [] : [`beads_import_source_autodiscovered:${candidate}`],
            };
        }
    }
    for (const candidate of UNSAFE_AUTO_DISCOVERY_FILES) {
        const candidatePath = resolveInputPath(candidate);
        if (await pathExists(candidatePath)) {
            throw new PmCliError(`Beads auto-discovery found ${candidatePath}, but sync_base snapshots may be partial. Export a full Beads JSONL file and pass --file <path> (or --file - for stdin).`, EXIT_CODE.NOT_FOUND);
        }
    }
    throw new PmCliError(`Beads source file not found. Checked ${PRIMARY_AUTO_DISCOVERY_FILES.join(", ")}. Use --file <path> or --file - for stdin.`, EXIT_CODE.NOT_FOUND);
}
export async function runBeadsImport(options, global) {
    const pmRoot = resolvePmRoot(process.cwd(), global.path);
    await ensureInitHasRun(pmRoot);
    const settings = await readSettings(pmRoot);
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    const preserveSourceIds = options.preserveSourceIds === true;
    const { source, sourcePath, raw, warnings: sourceWarnings } = await resolveBeadsSource(options.file);
    const warnings = [
        ...sourceWarnings,
    ];
    if (sourcePath) {
        warnings.push(...(await runActiveOnReadHooks({
            path: sourcePath,
            scope: "project",
        })));
    }
    const lines = raw.split(/\r?\n/);
    const author = selectAuthor(toNonEmptyString(options.author), settings.author_default);
    const message = toNonEmptyString(options.message) ?? "Import from Beads JSONL";
    const ids = [];
    let imported = 0;
    let skipped = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const line = lines[index].trim();
        if (line.length === 0) {
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            warnings.push(`beads_import_invalid_jsonl_line:${lineNumber}`);
            skipped += 1;
            continue;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            warnings.push(`beads_import_invalid_record:${lineNumber}`);
            skipped += 1;
            continue;
        }
        const record = parsed;
        const title = toNonEmptyString(record.title);
        if (!title) {
            warnings.push(`beads_import_missing_title:${lineNumber}`);
            skipped += 1;
            continue;
        }
        const createdAt = toIsoString(record.created_at) ?? nowIso();
        const updatedAt = toIsoString(record.updated_at) ?? createdAt;
        const id = toNonEmptyString(record.id)
            ? normalizeImportedId(toNonEmptyString(record.id), settings.id_prefix, preserveSourceIds)
            : await generateItemId(pmRoot, settings.id_prefix);
        const typeMapping = toItemType(record.issue_type ?? record.type);
        const type = typeMapping.type;
        const closedAt = toIsoString(record.closed_at);
        const assignee = toNonEmptyString(record.assignee) ?? toNonEmptyString(record.owner);
        const frontMatter = normalizeFrontMatter({
            id,
            title,
            description: toNonEmptyString(record.description) ?? "",
            type,
            source_type: typeMapping.sourceType,
            status: toStatus(record.status),
            priority: toPriority(record.priority),
            tags: toTags(record.tags ?? record.labels),
            created_at: createdAt,
            updated_at: updatedAt,
            deadline: toIsoString(record.due_at ?? record.deadline),
            closed_at: closedAt,
            assignee,
            source_owner: toNonEmptyString(record.owner),
            author: toNonEmptyString(record.author) ?? toNonEmptyString(record.created_by) ?? author,
            estimated_minutes: toEstimatedMinutes(record.estimated_minutes),
            acceptance_criteria: toNonEmptyString(record.acceptance_criteria),
            design: toNonEmptyString(record.design),
            external_ref: toNonEmptyString(record.external_ref),
            close_reason: toNonEmptyString(record.close_reason),
            dependencies: toDependencies(record.dependencies, createdAt, settings.id_prefix, preserveSourceIds),
            comments: toLogEntries(record.comments, createdAt, author),
            notes: toLogEntries(record.notes, createdAt, author),
            learnings: toLogEntries(record.learnings, createdAt, author),
            files: toLinkedFiles(record.files),
            tests: toLinkedTests(record.tests),
            docs: toLinkedDocs(record.docs),
        });
        const rawBody = toNonEmptyString(record.body) ?? "";
        const design = toNonEmptyString(record.design);
        const externalRef = toNonEmptyString(record.external_ref);
        let finalBody = rawBody;
        if (design) {
            finalBody += (finalBody ? "\n\n" : "") + "## Design\n\n" + design;
        }
        if (externalRef) {
            finalBody += (finalBody ? "\n\n" : "") + "## External Reference\n" + externalRef;
        }
        const afterDocument = canonicalDocument({
            metadata: frontMatter,
            body: finalBody,
        });
        const existing = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
        if (existing) {
            warnings.push(`beads_import_item_exists:${id}`);
            skipped += 1;
            continue;
        }
        const itemPath = getItemPath(pmRoot, type, id, "toon", typeRegistry.type_to_folder);
        const commit = await commitImportedItem({
            pmRoot,
            id,
            itemPath,
            document: afterDocument,
            author,
            message,
            settings,
            conflictWarningPrefix: "beads_import_lock_conflict",
        });
        if (!commit.committed) {
            warnings.push(commit.conflictWarning);
            skipped += 1;
            continue;
        }
        warnings.push(...commit.writeWarnings);
        ids.push(id);
        imported += 1;
    }
    return {
        ok: true,
        source,
        imported,
        skipped,
        ids,
        warnings,
    };
}
