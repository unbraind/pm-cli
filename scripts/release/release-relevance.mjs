export function isReleaseRelevantPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized !== "CHANGELOG.md" && !normalized.startsWith(".agents/pm/");
}
