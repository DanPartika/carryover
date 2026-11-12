// Who may hand out which clinic role. A regression here lets a PT make
// themselves a clinic admin — and an admin reaches every patient in the clinic
// with no assignment at all.

import { describe, expect, it } from "vitest";
import { canChangeRole, canManage, type ClinicRole } from "./roles";

describe("canManage", () => {
  it("is true for PTs and admins, false for patients and strangers", () => {
    expect(canManage(["pt"])).toBe(true);
    expect(canManage(["admin"])).toBe(true);
    expect(canManage(["patient"])).toBe(false);
    expect(canManage([])).toBe(false);
  });
});

describe("canChangeRole", () => {
  const everyday: ClinicRole[] = ["pt", "patient"];

  it("lets a PT manage the pt and patient roles", () => {
    for (const role of everyday) expect(canChangeRole(["pt"], false, role)).toBe(true);
  });

  it("does not let a PT grant or revoke admin", () => {
    expect(canChangeRole(["pt"], false, "admin")).toBe(false);
    expect(canChangeRole(["pt", "patient"], false, "admin")).toBe(false);
  });

  it("lets a clinic admin change any role, including admin", () => {
    for (const role of [...everyday, "admin"] as ClinicRole[]) {
      expect(canChangeRole(["admin"], false, role)).toBe(true);
    }
  });

  it("lets the app admin grant admin, so a clinic with no admin left can be recovered", () => {
    expect(canChangeRole([], true, "admin")).toBe(true);
    expect(canChangeRole(["pt"], true, "admin")).toBe(true);
  });

  it("being the app admin does not make someone a roster manager of a clinic they are not in", () => {
    for (const role of everyday) expect(canChangeRole([], true, role)).toBe(false);
  });

  it("gives patients and strangers nothing", () => {
    for (const role of [...everyday, "admin"] as ClinicRole[]) {
      expect(canChangeRole(["patient"], false, role)).toBe(false);
      expect(canChangeRole([], false, role)).toBe(false);
    }
  });
});
