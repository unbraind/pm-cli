import { constants as osConstants } from "node:os";
import { describe, expect, it } from "vitest";
import {
  classifyHostEnvironmentFault,
  translateHostEnvironmentFault,
  withHostEnvironmentBoundary,
} from "../../../src/sdk/environment/host-environment-errors.js";

describe("host environment errors", () => {
  it.each([
    ["ENOSPC", "host_environment_capacity_fault"],
    ["EDQUOT", "host_environment_capacity_fault"],
    ["EACCES", "host_environment_permission_fault"],
    ["EPERM", "host_environment_permission_fault"],
    ["EROFS", "host_environment_permission_fault"],
    ["EMFILE", "host_environment_resource_fault"],
    ["ENFILE", "host_environment_resource_fault"],
    ["ENOMEM", "host_environment_resource_fault"],
  ])("classifies and redacts %s", (errno, code) => {
    const error = Object.assign(
      new Error(`${errno}: /private/project/secret`),
      { code: errno },
    );
    const translated = translateHostEnvironmentFault(error, "write_history");
    expect(classifyHostEnvironmentFault(error)).toBe(errno);
    expect(translated).toMatchObject({
      code,
      context: expect.objectContaining({ reason: errno }),
    });
    expect(translated?.message).not.toContain("/private/project/secret");
  });

  it("preserves non-environment defects and successful values", async () => {
    const defect = new TypeError("implementation defect");
    expect(classifyHostEnvironmentFault(null)).toBeNull();
    expect(classifyHostEnvironmentFault(defect)).toBeNull();
    expect(classifyHostEnvironmentFault({ code: 123 })).toBeNull();
    expect(classifyHostEnvironmentFault({ code: "EUNKNOWN" })).toBeNull();
    expect(translateHostEnvironmentFault(defect, "read_item")).toBeNull();
    await expect(
      withHostEnvironmentBoundary("read_item", async () => 42),
    ).resolves.toBe(42);
    await expect(
      withHostEnvironmentBoundary("read_item", async () => {
        throw defect;
      }),
    ).rejects.toBe(defect);
  });

  it("normalizes a platform-declared numeric host errno when Node cannot name the code", () => {
    const numericCapacityErrno =
      osConstants.errno.EDQUOT ?? osConstants.errno.ENOSPC;
    const numericCapacityReason =
      osConstants.errno.EDQUOT === undefined ? "ENOSPC" : "EDQUOT";
    expect(Number.isInteger(numericCapacityErrno)).toBe(true);
    const error = Object.assign(
      new Error(`Unknown system error -${numericCapacityErrno}`),
      {
        code: `Unknown system error -${numericCapacityErrno}`,
        errno: -numericCapacityErrno,
        syscall: "copyfile",
      },
    );

    expect(classifyHostEnvironmentFault(error)).toBe(numericCapacityReason);
    expect(translateHostEnvironmentFault(error, "seed_linked_test")).toMatchObject(
      {
        code: "host_environment_capacity_fault",
        context: expect.objectContaining({ reason: numericCapacityReason }),
      },
    );
  });

  it("rejects non-integral and undeclared numeric errno values", () => {
    expect(classifyHostEnvironmentFault({ errno: 1.5 })).toBeNull();
    expect(classifyHostEnvironmentFault({ errno: -999_999 })).toBeNull();
  });

  it("refuses unsafe operation labels before exposing them", () => {
    expect(() =>
      translateHostEnvironmentFault(
        Object.assign(new Error("denied"), { code: "EACCES" }),
        "/private/path",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "host_environment_operation_invalid" }),
    );
  });

  it("wraps known faults with custom recovery context", async () => {
    await expect(
      withHostEnvironmentBoundary(
        "persist_item",
        async () => {
          throw Object.assign(new Error("full"), { code: "ENOSPC" });
        },
        {
          why: "The item and history write must commit together.",
          nextSteps: ["Run pm gc."],
        },
      ),
    ).rejects.toMatchObject({
      code: "host_environment_capacity_fault",
      context: expect.objectContaining({
        why: "The item and history write must commit together.",
        nextSteps: expect.arrayContaining(["Run pm gc."]),
      }),
    });
  });
});
