import fs from "node:fs/promises";
import path from "node:path";
import { CONFIDENCE_TEXT_VALUES, DEPENDENCY_KIND_VALUES, EXIT_CODE, ISSUE_SEVERITY_VALUES, PmCliError, RISK_VALUES, canonicalDocument, commitImportedItem, generateItemId, getActiveExtensionRegistrations, getItemPath, listAllFrontMatter, locateItem, normalizeFrontMatter, normalizeItemId, nowIso, readLocatedItem, readSettings, resolveItemTypeRegistry, resolvePmRoot, runActiveOnReadHooks, runActiveOnWriteHooks, selectImportAuthor, splitFrontMatter, ensureTrackerInitialized, toEstimatedMinutesValue, toImportPriority, toImportStatus, toImportTags, toNonEmptyImportString, writeFileAtomic, } from "../../../../dist/sdk/index.js";
const DEFAULT_TODOS_FOLDER = ".pm/todos";
// Shared, behavior-identical value coercers are sourced from the SDK adapter
// surface; package-specific mappings (lenient timestamps, type-name resolution,
// confidence/enum coercion) stay local below.
const toNonEmptyString = toNonEmptyImportString;
const toEstimatedMinutes = toEstimatedMinutesValue;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toIsoString(value) {
    const raw = toNonEmptyString(value);
    if (!raw) {
        return undefined;
    }
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) {
        return undefined;
    }
    return new Date(timestamp).toISOString();
}
function toInteger(value) {
    if (typeof value === "number" && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) {
            return parsed;
        }
    }
    return undefined;
}
const toPriority = toImportPriority;
function toConfidence(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
        return value;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
        return undefined;
    }
    if (normalized === "med") {
        return "medium";
    }
    if (CONFIDENCE_TEXT_VALUES.includes(normalized)) {
        return normalized;
    }
    const parsed = Number(normalized);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100) {
        return parsed;
    }
    return undefined;
}
function toNormalizedEnum(value, allowed) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
        return undefined;
    }
    const candidate = normalized === "med" ? "medium" : normalized;
    if (allowed.includes(candidate)) {
        return candidate;
    }
    return undefined;
}
function toBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") {
            return true;
        }
        if (normalized === "false" || normalized === "0") {
            return false;
        }
    }
    if (typeof value === "number") {
        if (value === 1) {
            return true;
        }
        if (value === 0) {
            return false;
        }
    }
    return undefined;
}
const toTags = toImportTags;
function toLinkScope(value) {
    return toNonEmptyString(value)?.toLowerCase() === "global" ? "global" : "project";
}
function toStringList(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value
        .map((entry) => toNonEmptyString(entry))
        .filter((entry) => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
}
function toStringMap(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value)
        .map(([key, entryValue]) => [key.trim(), toNonEmptyString(entryValue)])
        .filter((entry) => entry[0].length > 0 && entry[1] !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
function toNumberMap(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value)
        .map(([key, entryValue]) => [key.trim(), toInteger(entryValue)])
        .filter((entry) => entry[0].length > 0 && entry[1] !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
function toDependencyEntries(value, fallbackCreatedAt) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const dependencies = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            continue;
        }
        const id = toNonEmptyString(entry.id);
        if (!id) {
            continue;
        }
        const normalizedKind = toNonEmptyString(entry.kind)?.toLowerCase();
        const kind = normalizedKind && DEPENDENCY_KIND_VALUES.includes(normalizedKind) ? normalizedKind : "related";
        dependencies.push({
            id,
            kind,
            created_at: toIsoString(entry.created_at) ?? fallbackCreatedAt,
            author: toNonEmptyString(entry.author),
            source_kind: toNonEmptyString(entry.source_kind),
        });
    }
    return dependencies.length > 0 ? dependencies : undefined;
}
function toLogEntries(value, fallbackCreatedAt, fallbackAuthor) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value
        .map((entry) => {
        if (typeof entry === "string") {
            const text = toNonEmptyString(entry);
            return text
                ? {
                    created_at: fallbackCreatedAt,
                    author: fallbackAuthor,
                    text,
                }
                : undefined;
        }
        if (!isRecord(entry)) {
            return undefined;
        }
        const text = toNonEmptyString(entry.text);
        if (!text) {
            return undefined;
        }
        return {
            created_at: toIsoString(entry.created_at) ?? fallbackCreatedAt,
            author: toNonEmptyString(entry.author) ?? fallbackAuthor,
            text,
        };
    })
        .filter((entry) => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
}
function toLinkedFiles(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value
        .map((entry) => {
        if (typeof entry === "string") {
            const filePath = toNonEmptyString(entry);
            return filePath ? { path: filePath, scope: "project" } : undefined;
        }
        if (!isRecord(entry)) {
            return undefined;
        }
        const filePath = toNonEmptyString(entry.path);
        if (!filePath) {
            return undefined;
        }
        return {
            path: filePath,
            scope: toLinkScope(entry.scope),
            note: toNonEmptyString(entry.note),
        };
    })
        .filter((entry) => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
}
function toLinkedDocs(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value
        .map((entry) => {
        if (typeof entry === "string") {
            const docPath = toNonEmptyString(entry);
            return docPath ? { path: docPath, scope: "project" } : undefined;
        }
        if (!isRecord(entry)) {
            return undefined;
        }
        const docPath = toNonEmptyString(entry.path);
        if (!docPath) {
            return undefined;
        }
        return {
            path: docPath,
            scope: toLinkScope(entry.scope),
            note: toNonEmptyString(entry.note),
        };
    })
        .filter((entry) => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
}
function toLinkedTests(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            const command = toNonEmptyString(entry);
            if (command) {
                entries.push({ command, scope: "project" });
            }
            continue;
        }
        if (!isRecord(entry)) {
            continue;
        }
        const command = toNonEmptyString(entry.command);
        const testPath = toNonEmptyString(entry.path);
        if (!command && !testPath) {
            continue;
        }
        const timeoutSeconds = toInteger(entry.timeout_seconds);
        const pmContextMode = toNormalizedEnum(entry.pm_context_mode, ["schema", "tracker", "auto"]);
        entries.push({
            command,
            path: testPath,
            scope: toLinkScope(entry.scope),
            timeout_seconds: timeoutSeconds !== undefined && timeoutSeconds > 0 ? timeoutSeconds : undefined,
            pm_context_mode: pmContextMode,
            env_set: toStringMap(entry.env_set),
            env_clear: toStringList(entry.env_clear),
            shared_host_safe: toBoolean(entry.shared_host_safe),
            assert_stdout_contains: toStringList(entry.assert_stdout_contains),
            assert_stdout_regex: toStringList(entry.assert_stdout_regex),
            assert_stderr_contains: toStringList(entry.assert_stderr_contains),
            assert_stderr_regex: toStringList(entry.assert_stderr_regex),
            assert_stdout_min_lines: toInteger(entry.assert_stdout_min_lines),
            assert_json_field_equals: toStringMap(entry.assert_json_field_equals),
            assert_json_field_gte: toNumberMap(entry.assert_json_field_gte),
            note: toNonEmptyString(entry.note),
        });
    }
    return entries.length > 0 ? entries : undefined;
}
function toItemType(value, typeNames) {
    const normalized = toNonEmptyString(value)?.toLowerCase();
    const fallbackType = typeNames.find((entry) => entry.toLowerCase() === "task") ?? typeNames[0] ?? "Task";
    if (!normalized) {
        return fallbackType;
    }
    for (const candidate of typeNames) {
        if (candidate.toLowerCase() === normalized) {
            return candidate;
        }
    }
    return fallbackType;
}
const toStatus = toImportStatus;
const selectAuthor = selectImportAuthor;
const ensureInitHasRun = ensureTrackerInitialized;
function normalizeBody(body) {
    return body.replace(/^\n+/, "").replace(/\s+$/, "");
}
function resolveFolderPath(rawPath) {
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}
function parseTodoMarkdown(content) {
    const split = splitFrontMatter(content);
    if (split.frontMatter.length === 0) {
        throw new TypeError("Missing JSON front matter");
    }
    const parsed = JSON.parse(split.frontMatter);
    if (!isRecord(parsed)) {
        throw new TypeError("Front matter must be a JSON object");
    }
    return {
        frontMatter: parsed,
        body: normalizeBody(split.body),
    };
}
async function readTodoCandidate(sourceFolder, entry) {
    const sourcePath = path.join(sourceFolder, entry.name);
    let raw;
    try {
        raw = await fs.readFile(sourcePath, "utf8");
    }
    catch {
        return { warning: `todos_import_read_failed:${entry.name}` };
    }
    const readWarnings = await runActiveOnReadHooks({
        path: sourcePath,
        scope: "project",
    });
    let parsed;
    try {
        parsed = parseTodoMarkdown(raw);
    }
    catch {
        return { warning: `todos_import_invalid_front_matter:${entry.name}` };
    }
    return {
        entryName: entry.name,
        frontMatter: parsed.frontMatter,
        body: parsed.body,
        readWarnings,
    };
}
async function importTodoCandidate(candidate, runtime) {
    const title = toNonEmptyString(candidate.frontMatter.title);
    if (!title) {
        return { warning: `todos_import_missing_title:${candidate.entryName}` };
    }
    const explicitId = toNonEmptyString(candidate.frontMatter.id);
    const derivedId = path.basename(candidate.entryName, path.extname(candidate.entryName));
    // Hidden filenames (for example `.md`) do not provide stable human ids.
    const idSource = explicitId ?? (derivedId.startsWith(".") ? undefined : derivedId);
    const id = idSource
        ? normalizeItemId(idSource, runtime.settings.id_prefix)
        : await generateItemId(runtime.pmRoot, runtime.settings.id_prefix);
    const createdAt = toIsoString(candidate.frontMatter.created_at) ?? nowIso();
    const updatedAt = toIsoString(candidate.frontMatter.updated_at) ?? createdAt;
    const type = toItemType(candidate.frontMatter.type, runtime.typeNames);
    const located = await locateItem(runtime.pmRoot, id, runtime.settings.id_prefix, runtime.settings.item_format, runtime.typeToFolder);
    if (located) {
        return { warning: `todos_import_item_exists:${id}` };
    }
    const itemPath = getItemPath(runtime.pmRoot, type, id, "toon", runtime.typeToFolder);
    const afterDocument = canonicalDocument({
        metadata: normalizeFrontMatter({
            id,
            title,
            description: toNonEmptyString(candidate.frontMatter.description) ?? "",
            type,
            status: toStatus(candidate.frontMatter.status),
            priority: toPriority(candidate.frontMatter.priority),
            confidence: toConfidence(candidate.frontMatter.confidence),
            tags: toTags(candidate.frontMatter.tags),
            created_at: createdAt,
            updated_at: updatedAt,
            deadline: toIsoString(candidate.frontMatter.deadline),
            assignee: toNonEmptyString(candidate.frontMatter.assignee),
            author: toNonEmptyString(candidate.frontMatter.author) ?? runtime.author,
            estimated_minutes: toEstimatedMinutes(candidate.frontMatter.estimated_minutes),
            acceptance_criteria: toNonEmptyString(candidate.frontMatter.acceptance_criteria),
            definition_of_ready: toNonEmptyString(candidate.frontMatter.definition_of_ready),
            order: toInteger(candidate.frontMatter.order),
            goal: toNonEmptyString(candidate.frontMatter.goal),
            objective: toNonEmptyString(candidate.frontMatter.objective),
            value: toNonEmptyString(candidate.frontMatter.value),
            impact: toNonEmptyString(candidate.frontMatter.impact),
            outcome: toNonEmptyString(candidate.frontMatter.outcome),
            why_now: toNonEmptyString(candidate.frontMatter.why_now),
            parent: toNonEmptyString(candidate.frontMatter.parent),
            reviewer: toNonEmptyString(candidate.frontMatter.reviewer),
            risk: toNormalizedEnum(candidate.frontMatter.risk, RISK_VALUES),
            sprint: toNonEmptyString(candidate.frontMatter.sprint),
            release: toNonEmptyString(candidate.frontMatter.release),
            blocked_by: toNonEmptyString(candidate.frontMatter.blocked_by),
            blocked_reason: toNonEmptyString(candidate.frontMatter.blocked_reason),
            unblock_note: toNonEmptyString(candidate.frontMatter.unblock_note),
            reporter: toNonEmptyString(candidate.frontMatter.reporter),
            severity: toNormalizedEnum(candidate.frontMatter.severity, ISSUE_SEVERITY_VALUES),
            environment: toNonEmptyString(candidate.frontMatter.environment),
            repro_steps: toNonEmptyString(candidate.frontMatter.repro_steps),
            resolution: toNonEmptyString(candidate.frontMatter.resolution),
            expected_result: toNonEmptyString(candidate.frontMatter.expected_result),
            actual_result: toNonEmptyString(candidate.frontMatter.actual_result),
            affected_version: toNonEmptyString(candidate.frontMatter.affected_version),
            fixed_version: toNonEmptyString(candidate.frontMatter.fixed_version),
            component: toNonEmptyString(candidate.frontMatter.component),
            regression: toBoolean(candidate.frontMatter.regression),
            customer_impact: toNonEmptyString(candidate.frontMatter.customer_impact),
            close_reason: toNonEmptyString(candidate.frontMatter.close_reason),
            dependencies: toDependencyEntries(candidate.frontMatter.dependencies, createdAt),
            comments: toLogEntries(candidate.frontMatter.comments, createdAt, runtime.author),
            notes: toLogEntries(candidate.frontMatter.notes, createdAt, runtime.author),
            learnings: toLogEntries(candidate.frontMatter.learnings, createdAt, runtime.author),
            files: toLinkedFiles(candidate.frontMatter.files),
            docs: toLinkedDocs(candidate.frontMatter.docs),
            tests: toLinkedTests(candidate.frontMatter.tests),
        }),
        body: candidate.body,
    });
    const commit = await commitImportedItem({
        pmRoot: runtime.pmRoot,
        id,
        itemPath,
        document: afterDocument,
        author: runtime.author,
        message: runtime.message,
        settings: runtime.settings,
        conflictWarningPrefix: "todos_import_lock_conflict",
    });
    if (!commit.committed) {
        return { warning: commit.conflictWarning };
    }
    return { id, writeWarnings: commit.writeWarnings };
}
export async function runTodosImport(options, global) {
    const pmRoot = resolvePmRoot(process.cwd(), global.path);
    await ensureInitHasRun(pmRoot);
    const settings = await readSettings(pmRoot);
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
    const sourceFolder = resolveFolderPath(folder);
    let entries;
    try {
        entries = await fs.readdir(sourceFolder, { withFileTypes: true });
    }
    catch {
        throw new PmCliError(`Todos source folder not found at ${sourceFolder}. Use --folder <path> to point at the directory of Todo markdown files.`, EXIT_CODE.NOT_FOUND);
    }
    const author = selectAuthor(toNonEmptyString(options.author), settings.author_default);
    const message = toNonEmptyString(options.message) ?? "Import from todos markdown";
    const warnings = [
        ...(await runActiveOnReadHooks({
            path: sourceFolder,
            scope: "project",
        })),
    ];
    const ids = [];
    let imported = 0;
    let skipped = 0;
    const markdownFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .sort((left, right) => left.name.localeCompare(right.name));
    const runtime = {
        pmRoot,
        sourceFolder,
        settings,
        typeNames: typeRegistry.types,
        typeToFolder: typeRegistry.type_to_folder,
        author,
        message,
    };
    for (const entry of markdownFiles) {
        const candidate = await readTodoCandidate(sourceFolder, entry);
        if ("warning" in candidate) {
            warnings.push(candidate.warning);
            skipped += 1;
            continue;
        }
        warnings.push(...candidate.readWarnings);
        const importedCandidate = await importTodoCandidate(candidate, runtime);
        if ("warning" in importedCandidate) {
            warnings.push(importedCandidate.warning);
            skipped += 1;
            continue;
        }
        warnings.push(...importedCandidate.writeWarnings);
        ids.push(importedCandidate.id);
        imported += 1;
    }
    return {
        ok: true,
        folder,
        imported,
        skipped,
        ids,
        warnings,
    };
}
export async function runTodosExport(options, global) {
    const pmRoot = resolvePmRoot(process.cwd(), global.path);
    await ensureInitHasRun(pmRoot);
    const settings = await readSettings(pmRoot);
    const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    const folder = toNonEmptyString(options.folder) ?? DEFAULT_TODOS_FOLDER;
    const destinationFolder = resolveFolderPath(folder);
    await fs.mkdir(destinationFolder, { recursive: true });
    const warnings = [];
    const ids = [];
    let exported = 0;
    const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder);
    const sorted = [...items].sort((left, right) => left.id.localeCompare(right.id));
    for (const item of sorted) {
        const located = await locateItem(pmRoot, item.id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
        if (!located) {
            warnings.push(`todos_export_missing_item:${item.id}`);
            continue;
        }
        try {
            const { document } = await readLocatedItem(located);
            const todoFrontMatter = { ...document.metadata };
            const frontMatter = JSON.stringify(todoFrontMatter, null, 2);
            const body = normalizeBody(document.body);
            const serialized = body.length > 0 ? `${frontMatter}\n\n${body}\n` : `${frontMatter}\n`;
            const exportPath = path.join(destinationFolder, `${document.metadata.id}.md`);
            await writeFileAtomic(exportPath, serialized);
            warnings.push(...(await runActiveOnWriteHooks({
                path: exportPath,
                scope: "project",
                op: "todos:export",
            })));
            ids.push(document.metadata.id);
            exported += 1;
        }
        catch {
            warnings.push(`todos_export_read_failed:${item.id}`);
        }
    }
    return {
        ok: true,
        folder,
        exported,
        ids,
        warnings,
    };
}
