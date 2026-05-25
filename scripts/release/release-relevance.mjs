export function isReleaseRelevantPath(filePath) {
  return !filePath.replaceAll("\\", "/").startsWith(".agents/pm/");
}
