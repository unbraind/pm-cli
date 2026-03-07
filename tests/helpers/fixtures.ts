import { readFileSync } from "node:fs";
import path from "node:path";

export function fixturePath(...segments: string[]): string {
  return path.resolve(process.cwd(), "tests", "fixtures", ...segments);
}

export function readJsonFixture<T>(...segments: string[]): T {
  const raw = readFileSync(fixturePath(...segments), "utf8");
  return JSON.parse(raw) as T;
}

export function readJsonlFixture<T>(...segments: string[]): T[] {
  const raw = readFileSync(fixturePath(...segments), "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
