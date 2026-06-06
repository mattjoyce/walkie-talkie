import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerUser, resetAuthState } from "../auth.js";
import { initGeneralChannel, joinChannel, resetChannelState } from "../channels.js";
import { initDB } from "../db.js";
import { addPoll, closeAllPolls, removePoll } from "../polling.js";
import { ackDeliveries, drainQueue, ensureQueue, peekQueue, routeMessage } from "../router.js";

class FakeResponse {
  statusCode: number | null = null;
  headers: Record<string, string> | undefined;
  body = "";
  writableEnded = false;

  writeHead(statusCode: number, headers?: Record<string, string>): void {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = ""): void {
    this.body = body;
    this.writableEnded = true;
  }
}

function setupUsers(): void {
  registerUser("alice");
  registerUser("bob");
  ensureQueue("alice");
  ensureQueue("bob");
  joinChannel("#all", "alice");
  joinChannel("#all", "bob");
}

function makeRequest(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function makeResponse(): ServerResponse & FakeResponse {
  return new FakeResponse() as ServerResponse & FakeResponse;
}

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  resetAuthState();
  resetChannelState();
  initGeneralChannel();
  closeAllPolls();
});

afterEach(() => {
  closeAllPolls();
  vi.useRealTimers();
});

describe("poll delivery", () => {
  it("keeps queued messages when no user is waiting", () => {
    setupUsers();

    routeMessage("alice", "@bob", "queued");

    const messages = drainQueue("bob");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("queued");
  });

  it("flushes queued messages through the connection sink when a waiter registers", () => {
    setupUsers();
    routeMessage("alice", "@bob", "queued");

    const res = makeResponse();
    addPoll("bob", makeRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(res.body)).toEqual({
      messages: [expect.objectContaining({ content: "queued", to: "bob" })],
    });
    const pending = peekQueue("bob");
    expect(pending).toHaveLength(1);
    ackDeliveries(
      "bob",
      pending.map((message) => message.deliveryId).filter((id): id is string => Boolean(id)),
    );
    expect(peekQueue("bob")).toEqual([]);
  });

  it("ends and removes a waiting connection on explicit removal", () => {
    setupUsers();

    const res = makeResponse();
    addPoll("bob", makeRequest(), res);
    removePoll("bob");

    expect(res.statusCode).toBe(204);
    expect(res.writableEnded).toBe(true);
  });

  it("times out a waiting connection without messages", () => {
    vi.useFakeTimers();
    setupUsers();

    const res = makeResponse();
    addPoll("bob", makeRequest(), res);
    vi.advanceTimersByTime(3_600_000);

    expect(res.statusCode).toBe(204);
    expect(res.writableEnded).toBe(true);
  });
});
