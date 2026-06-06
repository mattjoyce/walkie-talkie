import path from "node:path";
import Database from "better-sqlite3";

import type { Message, MessageImage, UserRole } from "./types.js";

export interface AgentConfigRow {
  id: string;
  name: string;
  work_dir: string;
  command: string;
  auto_start: number;
  env_vars: string | null;
  created_at: number;
}

export interface ChannelRow {
  name: string;
  created_by: string;
  created_at: number;
}

export interface ChannelMemberRow {
  channel: string;
  user_name: string;
}

export interface UserRow {
  name: string;
  token: string;
  role: UserRole;
  registered_at: number;
  epoch: number;
}

export interface DeliveryRow {
  id: string;
  recipient: string;
  message_json: string;
  enqueued_at: number;
  sequence: number;
}

let db: Database.Database;
const DB_BUSY_TIMEOUT_MS = 5_000;
const DB_SLOW_QUERY_MS = 50;
const MAX_READ_LIMIT = 500;
const MAX_CHANNEL_ROWS = 500;
const MAX_AGENT_CONFIG_ROWS = 500;
const MAX_USER_CHANNEL_ROWS = 500;
const MAX_CHANNEL_MEMBER_ROWS = 10_000;
const MAX_DELIVERY_QUEUE_ROWS = 500;

function clampLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_READ_LIMIT);
}

function logSlowQuery(name: string, startedAt: number): void {
  const elapsed = Date.now() - startedAt;
  if (elapsed > DB_SLOW_QUERY_MS) {
    console.warn(`[db] ${name} took ${elapsed}ms`);
  }
}

export function initDB(): void {
  const dbPath = process.env.WALKIE_TALKIE_DB_PATH ?? path.join(process.cwd(), "walkie-talkie.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel TEXT NOT NULL,
      user_name TEXT NOT NULL,
      PRIMARY KEY (channel, user_name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0
    )
  `);

  try {
    db.exec("ALTER TABLE users ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      content TEXT NOT NULL,
      channel TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_queue (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      recipient TEXT NOT NULL,
      message_json TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_queue_recipient_sequence
    ON delivery_queue (recipient, sequence)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp
    ON messages (channel, timestamp)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS read_cursors (
      user_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_name, channel)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      work_dir TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      auto_start INTEGER NOT NULL DEFAULT 0,
      env_vars TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  try {
    db.exec("ALTER TABLE agent_configs ADD COLUMN env_vars TEXT");
  } catch {
    /* column already exists */
  }

  try {
    db.exec("ALTER TABLE messages ADD COLUMN image TEXT");
  } catch {
    /* column already exists */
  }

  // Seed #all if it doesn't exist
  const existing = db.prepare("SELECT name FROM channels WHERE name = ?").get("#all");
  if (!existing) {
    db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(
      "#all",
      "system",
      Date.now(),
    );
  }
}

export function dbCreateChannel(name: string, createdBy: string): ChannelRow {
  const now = Date.now();
  db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(name, createdBy, now);
  return { name, created_by: createdBy, created_at: now };
}

export function dbDeleteChannel(name: string): boolean {
  const result = db.prepare("DELETE FROM channels WHERE name = ?").run(name);
  return result.changes > 0;
}

export function dbListChannels(): ChannelRow[] {
  return db
    .prepare("SELECT name, created_by, created_at FROM channels ORDER BY created_at LIMIT ?")
    .all(MAX_CHANNEL_ROWS) as ChannelRow[];
}

export function dbGetChannel(name: string): ChannelRow | undefined {
  return db.prepare("SELECT name, created_by, created_at FROM channels WHERE name = ?").get(name) as
    | ChannelRow
    | undefined;
}

export function dbAddChannelMember(channel: string, userName: string): void {
  db.prepare("INSERT OR IGNORE INTO channel_members (channel, user_name) VALUES (?, ?)").run(channel, userName);
}

export function dbRemoveChannelMember(channel: string, userName: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ? AND user_name = ?").run(channel, userName);
}

export function dbRemoveAllMembersOfChannel(channel: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ?").run(channel);
}

export function dbRemoveUserFromAllChannels(userName: string): void {
  db.prepare("DELETE FROM channel_members WHERE user_name = ?").run(userName);
}

export function dbGetUserChannels(userName: string): string[] {
  const rows = db
    .prepare("SELECT channel FROM channel_members WHERE user_name = ? LIMIT ?")
    .all(userName, MAX_USER_CHANNEL_ROWS) as {
    channel: string;
  }[];
  return rows.map((r) => r.channel);
}

export function dbListChannelMembers(): ChannelMemberRow[] {
  return db
    .prepare("SELECT channel, user_name FROM channel_members ORDER BY channel, user_name LIMIT ?")
    .all(MAX_CHANNEL_MEMBER_ROWS) as ChannelMemberRow[];
}

export function dbSaveUser(name: string, token: string, role: UserRole, registeredAt: number, epoch: number): void {
  db.prepare(
    `INSERT INTO users (name, token, role, registered_at, epoch) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       token = excluded.token,
       role = excluded.role,
       registered_at = excluded.registered_at,
       epoch = excluded.epoch`,
  ).run(name, token, role, registeredAt, epoch);
}

export function dbDeleteUser(name: string): void {
  db.prepare("DELETE FROM users WHERE name = ?").run(name);
}

export function dbListUsers(): UserRow[] {
  return db
    .prepare("SELECT name, token, role, registered_at, epoch FROM users ORDER BY registered_at LIMIT ?")
    .all(MAX_READ_LIMIT) as UserRow[];
}

const ALL_CHANNEL_MAX = 200;

export function dbSaveMessage(msg: Message): void {
  db.prepare(
    `INSERT INTO messages (id, "from", "to", content, channel, timestamp, image) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.from,
    msg.to,
    msg.content,
    msg.channel,
    msg.timestamp,
    msg.image ? JSON.stringify(msg.image) : null,
  );

  if (msg.channel === "#all") {
    dbPruneAllChannel();
  }
}

function parseMessageRow(row: Record<string, unknown>): Message {
  const imageStr = row.image as string | null;
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    content: row.content as string,
    channel: row.channel as string,
    timestamp: row.timestamp as number,
    image: imageStr ? (JSON.parse(imageStr) as MessageImage) : undefined,
  };
}

export function dbGetChannelMessages(channel: string, limit = 50): Message[] {
  const startedAt = Date.now();
  const rows = db
    .prepare(
      `SELECT id, "from", "to", content, channel, timestamp, image FROM messages WHERE channel = ? ORDER BY timestamp ASC LIMIT ?`,
    )
    .all(channel, clampLimit(limit, 50)) as Record<string, unknown>[];
  logSlowQuery("dbGetChannelMessages", startedAt);
  return rows.map(parseMessageRow);
}

export function dbGetRecentMessages(limit = 200): Message[] {
  const startedAt = Date.now();
  const rows = db
    .prepare(`SELECT id, "from", "to", content, channel, timestamp, image FROM messages ORDER BY timestamp ASC LIMIT ?`)
    .all(clampLimit(limit, 200)) as Record<string, unknown>[];
  logSlowQuery("dbGetRecentMessages", startedAt);
  return rows.map(parseMessageRow);
}

export function dbDeleteChannelMessages(channel: string): void {
  db.prepare("DELETE FROM messages WHERE channel = ?").run(channel);
}

export function dbEnqueueDelivery(id: string, recipient: string, message: Message): void {
  db.prepare("INSERT INTO delivery_queue (id, recipient, message_json, enqueued_at) VALUES (?, ?, ?, ?)").run(
    id,
    recipient,
    JSON.stringify(message),
    Date.now(),
  );
  dbPruneDeliveryQueue(recipient);
}

export function dbListDeliveries(recipient: string, limit = MAX_DELIVERY_QUEUE_ROWS): DeliveryRow[] {
  return db
    .prepare(
      "SELECT id, recipient, message_json, enqueued_at, sequence FROM delivery_queue WHERE recipient = ? ORDER BY sequence LIMIT ?",
    )
    .all(recipient, clampLimit(limit, MAX_DELIVERY_QUEUE_ROWS)) as DeliveryRow[];
}

export function dbAckDeliveries(recipient: string, deliveryIds: string[]): void {
  if (deliveryIds.length === 0) return;
  const placeholders = deliveryIds.map(() => "?").join(", ");
  db.prepare(`DELETE FROM delivery_queue WHERE recipient = ? AND id IN (${placeholders})`).run(
    recipient,
    ...deliveryIds,
  );
}

export function dbDeleteDeliveriesForRecipient(recipient: string): void {
  db.prepare("DELETE FROM delivery_queue WHERE recipient = ?").run(recipient);
}

function dbPruneDeliveryQueue(recipient: string): void {
  const result = db
    .prepare(
      `DELETE FROM delivery_queue
       WHERE recipient = ?
       AND id NOT IN (
         SELECT id FROM delivery_queue
         WHERE recipient = ?
         ORDER BY sequence DESC
         LIMIT ?
       )`,
    )
    .run(recipient, recipient, MAX_DELIVERY_QUEUE_ROWS);
  if (result.changes > 0) {
    console.warn(
      `[delivery] Dropped ${result.changes} oldest queued message(s) for ${recipient}; queue cap is ${MAX_DELIVERY_QUEUE_ROWS}`,
    );
  }
}

export function dbUpdateReadCursor(userName: string, channel: string, timestamp?: number): void {
  const ts = timestamp ?? Date.now();
  db.prepare(
    `INSERT INTO read_cursors (user_name, channel, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_name, channel) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
  ).run(userName, channel, ts);
}

export function dbGetUnreadCounts(userName: string): Record<string, number> {
  const startedAt = Date.now();
  const rows = db
    .prepare(
      `SELECT m.channel, COUNT(*) as cnt
     FROM messages m
     LEFT JOIN read_cursors rc ON rc.user_name = ? AND rc.channel = m.channel
     WHERE m.timestamp > COALESCE(rc.last_read_at, 0)
     GROUP BY m.channel
     ORDER BY m.channel
     LIMIT ?`,
    )
    .all(userName, MAX_CHANNEL_ROWS) as { channel: string; cnt: number }[];
  logSlowQuery("dbGetUnreadCounts", startedAt);
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.channel] = row.cnt;
  }
  return result;
}

export function dbDeleteReadCursorsForChannel(channel: string): void {
  db.prepare("DELETE FROM read_cursors WHERE channel = ?").run(channel);
}

// Agent config CRUD
export function dbCreateAgentConfig(
  id: string,
  name: string,
  workDir: string,
  command: string,
  autoStart: boolean,
  envVars?: Record<string, string>,
): AgentConfigRow {
  const now = Date.now();
  const envJson = envVars ? JSON.stringify(envVars) : null;
  db.prepare(
    "INSERT INTO agent_configs (id, name, work_dir, command, auto_start, env_vars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, name, workDir, command, autoStart ? 1 : 0, envJson, now);
  return { id, name, work_dir: workDir, command, auto_start: autoStart ? 1 : 0, env_vars: envJson, created_at: now };
}

export function dbListAgentConfigs(): AgentConfigRow[] {
  return db
    .prepare("SELECT * FROM agent_configs ORDER BY created_at LIMIT ?")
    .all(MAX_AGENT_CONFIG_ROWS) as AgentConfigRow[];
}

export function dbGetBusyTimeoutMs(): number {
  return (db.pragma("busy_timeout", { simple: true }) as number) ?? 0;
}

export function dbHealthCheck(): boolean {
  const result = db.prepare("SELECT 1 as ok").get() as { ok: number } | undefined;
  return result?.ok === 1;
}

export function dbGetAgentConfig(id: string): AgentConfigRow | undefined {
  return db.prepare("SELECT * FROM agent_configs WHERE id = ?").get(id) as AgentConfigRow | undefined;
}

export function dbUpdateAgentConfig(
  id: string,
  updates: {
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  },
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.workDir !== undefined) {
    fields.push("work_dir = ?");
    values.push(updates.workDir);
  }
  if (updates.command !== undefined) {
    fields.push("command = ?");
    values.push(updates.command);
  }
  if (updates.autoStart !== undefined) {
    fields.push("auto_start = ?");
    values.push(updates.autoStart ? 1 : 0);
  }
  if (updates.envVars !== undefined) {
    fields.push("env_vars = ?");
    values.push(updates.envVars ? JSON.stringify(updates.envVars) : null);
  }
  if (fields.length === 0) return false;
  values.push(id);
  const result = db.prepare(`UPDATE agent_configs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function dbDeleteAgentConfig(id: string): boolean {
  const result = db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  return result.changes > 0;
}

function dbPruneAllChannel(): void {
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel = '#all'").get() as { cnt: number })
    .cnt;
  if (count > ALL_CHANNEL_MAX) {
    db.prepare(
      `DELETE FROM messages WHERE channel = '#all' AND id NOT IN (
        SELECT id FROM messages WHERE channel = '#all' ORDER BY timestamp DESC LIMIT ?
      )`,
    ).run(ALL_CHANNEL_MAX);
  }
}
