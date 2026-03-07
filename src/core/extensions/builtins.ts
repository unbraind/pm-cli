import builtInBeadsExtension, { manifest as builtInBeadsManifest } from "../../extensions/builtins/beads/index.js";
import builtInTodosExtension, { manifest as builtInTodosManifest } from "../../extensions/builtins/todos/index.js";
import type { PmSettings } from "../../types/index.js";
import type { LoadedExtension } from "./loader.js";

function normalizeExtensionNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isExtensionEnabled(name: string, settings: PmSettings): boolean {
  const enabled = new Set(normalizeExtensionNames(settings.extensions.enabled));
  const disabled = new Set(normalizeExtensionNames(settings.extensions.disabled));
  if (disabled.has(name)) {
    return false;
  }
  if (enabled.size === 0) {
    return true;
  }
  return enabled.has(name);
}

export function getEnabledBuiltInExtensions(settings: PmSettings): LoadedExtension[] {
  const builtIns: LoadedExtension[] = [];
  if (isExtensionEnabled(builtInBeadsManifest.name, settings)) {
    builtIns.push({
      layer: "global",
      directory: "builtin/beads",
      manifest_path: "builtin:beads/manifest.json",
      name: builtInBeadsManifest.name,
      version: builtInBeadsManifest.version,
      entry: builtInBeadsManifest.entry,
      priority: builtInBeadsManifest.priority,
      entry_path: "builtin:beads/index.js",
      module: builtInBeadsExtension,
    });
  }
  if (isExtensionEnabled(builtInTodosManifest.name, settings)) {
    builtIns.push({
      layer: "global",
      directory: "builtin/todos",
      manifest_path: "builtin:todos/manifest.json",
      name: builtInTodosManifest.name,
      version: builtInTodosManifest.version,
      entry: builtInTodosManifest.entry,
      priority: builtInTodosManifest.priority,
      entry_path: "builtin:todos/index.js",
      module: builtInTodosExtension,
    });
  }
  return builtIns;
}
