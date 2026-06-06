import type { IncomingMessage, ServerResponse } from "node:http";
import { drainQueue } from "./router.js";
import type { Message } from "./types.js";

const POLL_TIMEOUT_MS = 3_600_000; // 1 hour

type Waiter = {
  userName: string;
  startedAt: number;
  expiresAt: number;
};

type Connection = {
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
};

const waiters = new Map<string, Waiter>();
const connections = new Map<string, Connection>();

// Track users explicitly detected as offline (poll connection dropped).
// Registered users NOT in this set are considered online (default = online).
const offlineUsers = new Set<string>();

let onDisconnectCallback: ((userName: string) => void) | null = null;

export function onPollDisconnect(cb: (userName: string) => void): void {
  onDisconnectCallback = cb;
}

export function isOnline(userName: string): boolean {
  return !offlineUsers.has(userName);
}

export function setOnline(userName: string): void {
  offlineUsers.delete(userName);
}

export function setOffline(userName: string): void {
  offlineUsers.add(userName);
}

export function addPoll(userName: string, req: IncomingMessage, res: ServerResponse): void {
  removePoll(userName);

  console.log(`[poll-start] ${userName} waiting for messages...`);
  const startedAt = Date.now();
  waiters.set(userName, {
    userName,
    startedAt,
    expiresAt: startedAt + POLL_TIMEOUT_MS,
  });

  const timer = setTimeout(() => {
    waiters.delete(userName);
    connections.delete(userName);
    console.log(`[poll-timeout] ${userName} (no messages after ${POLL_TIMEOUT_MS / 1000}s)`);
    res.writeHead(204);
    res.end();
  }, POLL_TIMEOUT_MS);

  connections.set(userName, { res, timer });

  // Detect unexpected connection drop (agent crash, network loss).
  // Listen on req (not res) — more reliable when no response has been written yet.
  req.on("close", () => {
    if (!res.writableEnded && waiters.has(userName)) {
      console.log(`[poll-disconnect] ${userName} connection dropped`);
      clearTimeout(timer);
      waiters.delete(userName);
      connections.delete(userName);
      onDisconnectCallback?.(userName);
    }
  });

  const messages = drainQueue(userName);
  if (messages.length > 0) {
    deliverToWaitingConnection(userName, messages, "poll-immediate");
  }
}

export function deliverMessage(userName: string): void {
  if (!waiters.has(userName) || !connections.has(userName)) return;
  const messages = drainQueue(userName);
  if (messages.length === 0) return;
  deliverToWaitingConnection(userName, messages, "poll-deliver");
}

function deliverToWaitingConnection(userName: string, messages: Message[], logLabel: string): boolean {
  if (!waiters.has(userName)) return false;
  const connection = connections.get(userName);
  if (!connection) return false;

  clearTimeout(connection.timer);
  waiters.delete(userName);
  connections.delete(userName);

  for (const m of messages) {
    if (m.image) {
      console.log(`[${logLabel}] ${userName} <- image (${m.image.mimeType}, ${m.image.data.length} chars base64)`);
    }
  }
  console.log(`[${logLabel}] ${userName} <- ${messages.length} message(s)`);

  connection.res.writeHead(200, { "Content-Type": "application/json" });
  connection.res.end(JSON.stringify({ messages }));
  return true;
}

export function closeAllPolls(): void {
  for (const [, connection] of connections) {
    clearTimeout(connection.timer);
    if (!connection.res.writableEnded) {
      connection.res.writeHead(204);
      connection.res.end();
    }
  }
  waiters.clear();
  connections.clear();
}

export function removePoll(userName: string): void {
  const connection = connections.get(userName);
  waiters.delete(userName);
  connections.delete(userName);
  if (connection) {
    clearTimeout(connection.timer);
    if (!connection.res.writableEnded) {
      connection.res.writeHead(204);
      connection.res.end();
    }
  }
}
