import { afterEach, describe, expect, it } from "vitest";
import { readNestedSettingValue, writeNestedSettingValue } from "../../../../src/core/config/nested-settings.js";

afterEach(() => { Reflect.deleteProperty(Object.prototype, "marker"); });

const descriptor = { key: "custom", path: "search.provider", kind: "string" as const, summary: "Custom setting" };

describe("nested settings own-property isolation", () => {
  it("does not read inherited settings or mutate inherited containers", () => {
    const inherited = { search: { provider: "inherited" } };
    const settings: Record<string, unknown> = Object.create(inherited);
    expect(readNestedSettingValue(settings, descriptor)).toBeNull();
    expect(writeNestedSettingValue(settings, descriptor, "local")).toBe(true);
    expect(inherited.search.provider).toBe("inherited");
    expect(readNestedSettingValue(settings, descriptor)).toBe("local");
  });

  it("does not invoke inherited or own accessors while reading and writing data", () => {
    let calls = 0;
    const inherited = { set search(_value: unknown) { calls += 1; } };
    const settings: Record<string, unknown> = Object.create(inherited);
    Object.defineProperty(settings, "search", { configurable: true, get() { calls += 1; return {}; } });
    expect(readNestedSettingValue(settings, descriptor)).toBeNull();
    expect(writeNestedSettingValue(settings, descriptor, "local")).toBe(true);
    expect(readNestedSettingValue(settings, descriptor)).toBe("local");
    const leaf = Object.create({ set provider(_value: unknown) { calls += 1; } }) as Record<string, unknown>;
    expect(writeNestedSettingValue({ search: leaf }, descriptor, "local")).toBe(true);
    expect(calls).toBe(0);
  });

  it.each(["__proto__.marker", "constructor.prototype.marker", "safe.__proto__.marker", "safe.prototype.marker", "safe..marker", ""])("rejects unsafe path %s before changing the object", (path) => {
    const settings = {};
    const unsafe = {...descriptor, path};
    expect(() => writeNestedSettingValue(settings, unsafe, "changed")).toThrow(/Unsafe settings path/);
    expect(settings).toEqual({});
    expect(Object.hasOwn(Object.prototype, "marker")).toBe(false);
  });
});
