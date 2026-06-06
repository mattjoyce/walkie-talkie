import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyAssertionPolicy,
  checkInvariants,
  findAuthViolations,
  findMembershipViolations,
  findOfflineSubsetViolations,
  formatInvariantError,
  getInvariantViolationCount,
} from "../invariants.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

describe("findAuthViolations (I1: user<->token bijection)", () => {
  it("returns [] for a consistent bijection", () => {
    const users = new Map([
      ["alice", { token: "tok-a" }],
      ["bob", { token: "tok-b" }],
    ]);
    const tokenToName = new Map([
      ["tok-a", "alice"],
      ["tok-b", "bob"],
    ]);
    expect(findAuthViolations(users, tokenToName)).toEqual([]);
  });

  it("flags a size mismatch", () => {
    const users = new Map([["alice", { token: "tok-a" }]]);
    const tokenToName = new Map([
      ["tok-a", "alice"],
      ["tok-orphan", "ghost"],
    ]);
    expect(findAuthViolations(users, tokenToName).some((v) => v.includes("size"))).toBe(true);
  });

  it("flags a broken name->token->name round-trip", () => {
    const users = new Map([["alice", { token: "tok-a" }]]);
    const tokenToName = new Map([["tok-a", "mallory"]]); // points to the wrong name
    const violations = findAuthViolations(users, tokenToName);
    expect(violations.some((v) => v.includes('"alice"'))).toBe(true);
  });

  it("flags a broken token->name->token round-trip", () => {
    const users = new Map([["alice", { token: "tok-real" }]]);
    const tokenToName = new Map([["tok-stale", "alice"]]); // stale token still indexed
    const violations = findAuthViolations(users, tokenToName);
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("findOfflineSubsetViolations (I2: offline subset of registered)", () => {
  const isRegistered = (name: string) => name === "alice" || name === "bob";

  it("returns [] when all offline users are registered", () => {
    expect(findOfflineSubsetViolations(["alice"], isRegistered)).toEqual([]);
  });

  it("flags an offline user that is not registered", () => {
    const violations = findOfflineSubsetViolations(["alice", "ghost"], isRegistered);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("ghost");
  });
});

describe("findMembershipViolations (I3/I6/I7: memory agrees with DB)", () => {
  const healthyMemory = new Map<string, Set<string>>([
    ["#all", new Set(["alice"])],
    ["#dev", new Set(["alice"])],
  ]);
  const dbMembers = new Map<string, Set<string>>([
    ["#all", new Set(["alice"])],
    ["#dev", new Set(["alice"])],
  ]);
  const dbChannels = new Set(["#all", "#dev"]);

  it("returns [] when memory agrees with the DB", () => {
    expect(findMembershipViolations(healthyMemory, dbMembers, dbChannels)).toEqual([]);
  });

  it("flags a missing #all channel (I6)", () => {
    const memory = new Map<string, Set<string>>([["#dev", new Set(["alice"])]]);
    const violations = findMembershipViolations(memory, dbMembers, dbChannels);
    expect(violations.some((v) => v.includes("#all"))).toBe(true);
  });

  it("flags a ghost channel present in memory but not the DB (I7)", () => {
    const memory = new Map<string, Set<string>>([
      ["#all", new Set(["alice"])],
      ["#ghost", new Set(["alice"])],
    ]);
    const violations = findMembershipViolations(memory, dbMembers, dbChannels);
    expect(violations.some((v) => v.includes("#ghost"))).toBe(true);
  });

  it("flags a member present in memory but not the DB (I3)", () => {
    const memory = new Map<string, Set<string>>([["#all", new Set(["alice", "stowaway"])]]);
    const violations = findMembershipViolations(memory, dbMembers, dbChannels);
    expect(violations.some((v) => v.includes("stowaway"))).toBe(true);
  });
});

describe("assertion policy (strict throws, default logs+counts)", () => {
  it("does nothing when there are no violations, in either mode", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => applyAssertionPolicy([], "ctx", { strict: true })).not.toThrow();
    expect(() => applyAssertionPolicy([], "ctx", { strict: false })).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("throws in strict mode when violations exist", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => applyAssertionPolicy(["bad"], "ctx", { strict: true })).toThrow(/bad/);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does NOT throw in the default (non-strict) mode but logs and counts the violation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = getInvariantViolationCount();
    expect(() => applyAssertionPolicy(["bad1", "bad2"], "ctx", { strict: false })).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(getInvariantViolationCount()).toBe(before + 2);
    errorSpy.mockRestore();
  });

  it("formats violations with the context", () => {
    const message = formatInvariantError("register", ["v1", "v2"]);
    expect(message).toContain("register");
    expect(message).toContain("v1");
    expect(message).toContain("v2");
  });
});

describe("checkInvariants on a healthy running server", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer(ctx);
  });

  it("reports no violations after register + channel activity", async () => {
    await registerUser(ctx, "alice");
    await registerUser(ctx, "bob");
    expect(checkInvariants()).toEqual([]);
  });
});
