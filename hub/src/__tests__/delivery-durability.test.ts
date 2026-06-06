import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticateRequest, loadUsersFromDB, registerUser, resetAuthState } from "../auth.js";
import { initGeneralChannel, joinChannel, loadMembershipFromDB, resetChannelState } from "../channels.js";
import { initDB } from "../db.js";
import { ensureQueue, peekQueue, routeMessage } from "../router.js";

function setTempDB(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "walkie-delivery-"));
  process.env.WALKIE_TALKIE_DB_PATH = path.join(dir, "hub.db");
}

function authReq(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

beforeEach(() => {
  setTempDB();
  initDB();
  resetAuthState();
  resetChannelState();
  initGeneralChannel();
});

describe("durable auth and delivery", () => {
  it("reloads registered user tokens from DB", () => {
    const user = registerUser("alice");

    resetAuthState();
    loadUsersFromDB();

    expect(authenticateRequest(authReq(user.token))).toBe("alice");
  });

  it("keeps undelivered messages across DB reinitialization", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    ensureQueue("bob");
    joinChannel("#all", "alice");
    joinChannel("#all", "bob");

    routeMessage("alice", "@bob", "survives restart");
    expect(peekQueue("bob")).toHaveLength(1);

    resetChannelState();
    initDB();
    loadMembershipFromDB();

    const messages = peekQueue("bob");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ content: "survives restart", to: "bob" }));
    expect(messages[0].deliveryId).toBeTruthy();
  });
});
