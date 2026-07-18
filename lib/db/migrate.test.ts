import { describe, expect, it } from "vitest";
import { orderMigrations, pendingMigrations } from "./migrate";

describe("orderMigrations", () => {
  it("keeps only numbered .sql files, in filename order", () => {
    expect(
      orderMigrations(["0002_cases.sql", "notes.md", "0001_init.sql", "seed.sql", ".DS_Store"]),
    ).toEqual(["0001_init.sql", "0002_cases.sql"]);
  });

  it("zero-padded prefixes sort numerically via lexicographic order", () => {
    expect(orderMigrations(["0010_ten.sql", "0002_two.sql", "0001_one.sql"])).toEqual([
      "0001_one.sql",
      "0002_two.sql",
      "0010_ten.sql",
    ]);
  });
});

describe("pendingMigrations", () => {
  it("skips applied files, preserving apply order", () => {
    expect(
      pendingMigrations(["0001_init.sql", "0002_cases.sql", "0003_turns.sql"], ["0001_init.sql"]),
    ).toEqual(["0002_cases.sql", "0003_turns.sql"]);
  });

  it("is empty when everything is applied", () => {
    expect(pendingMigrations(["0001_init.sql"], ["0001_init.sql"])).toEqual([]);
  });

  it("ignores applied entries that no longer exist on disk", () => {
    expect(pendingMigrations(["0002_cases.sql"], ["0001_init.sql"])).toEqual(["0002_cases.sql"]);
  });
});
