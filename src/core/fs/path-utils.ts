import path from "path";

export function isPathWithinDirectory(directory: string, targetPath: string): boolean {
  const relative = path.relative(directory, targetPath);
  if (relative.length === 0) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
