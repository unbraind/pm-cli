import { describe, expect, it } from "vitest";
import { _testOnlyTestCommand as testRuntime } from "../../../../src/sdk/test/execution.js";

describe("linked-test JSON assertion isolation", () => {
  it.each([null, "text"])("stops traversal at a non-container value", (value) => {
    expect(testRuntime.readJsonPathValue({ value }, "value.child")).toEqual({ found: false, value: undefined });
  });

  it("ignores inherited array slots and getters without modifying prototypes", () => {
    const inheritedArray = ["inherited"];
    const array = Array.from({ length: 1 });
    Reflect.deleteProperty(array, "0");
    Object.setPrototypeOf(array, inheritedArray);
    expect(testRuntime.readJsonPathValue({ array }, "array[0]")).toEqual({ found: false, value: undefined });
    let reads = 0;
    const accessor = { get value() { reads += 1; return "computed"; } };
    expect(testRuntime.readJsonPathValue(accessor, "value")).toEqual({ found: false, value: undefined });
    expect(reads).toBe(0);
    expect(inheritedArray).toEqual(["inherited"]);
  });

  it("treats own prototype-named JSON fields as data and never traverses inherited objects", () => {
    const root: unknown = JSON.parse('{"__proto__":{"value":"data"},"constructor":{"prototype":{"value":"local"}}}');
    expect(testRuntime.readJsonPathValue(root, "__proto__.value")).toEqual({found: true, value: "data"});
    expect(testRuntime.readJsonPathValue(root, "constructor.prototype.value")).toEqual({found: true, value: "local"});
    expect(testRuntime.readJsonPathValue({}, "constructor.prototype")).toEqual({found: false, value: undefined});
  });
});
