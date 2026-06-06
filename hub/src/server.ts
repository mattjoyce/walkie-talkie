import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type AgentConfigDTO,
  CONNECTED_USERS_PREFIX,
  codeForStatus,
  formatControl,
  type HubErrorCode,
  isRetryable,
  RADIO_KILLED_PREFIX,
  STALE_GRACE_MS,
  TYPING_SIGNAL,
  USER_JOINED_PREFIX,
  USER_LEFT_PREFIX,
} from "@walkie-talkie/contract";
import {
  authenticateRequest,
  getRegisteredUsers,
  getSessionEpoch,
  getUserRole,
  getUserToken,
  isCurrentSession,
  isUserRegistered,
  registerUser,
  unregisterUser,
} from "./auth.js";
import {
  ensureChannelMembership,
  getChannelMemberCounts,
  getChannelMembers,
  isChannelMember,
  joinChannel,
  leaveChannel,
  removeChannel,
} from "./channels.js";
import { getDashboardHTML } from "./dashboard.js";
import {
  dbCreateAgentConfig,
  dbCreateChannel,
  dbDeleteAgentConfig,
  dbDeleteChannel,
  dbDeleteChannelMessages,
  dbDeleteReadCursorsForChannel,
  dbGetAgentConfig,
  dbGetChannel,
  dbGetChannelMessages,
  dbGetRecentMessages,
  dbGetUnreadCounts,
  dbGetUserChannels,
  dbHealthCheck,
  dbListAgentConfigs,
  dbListChannels,
  dbUpdateAgentConfig,
  dbUpdateReadCursor,
} from "./db.js";
import { addSSEClient, broadcast } from "./events.js";
import { launchAgent } from "./launcher.js";
import { addPoll, isOnline, onPollDisconnect, removePoll, setOffline, setOnline } from "./polling.js";
import {
  ackDeliveries,
  enqueueAndDeliver,
  ensureQueue,
  notifyBridges,
  peekQueue,
  removeQueue,
  routeMessage,
} from "./router.js";
import type { AckRequest, MessageImage, RegisterRequest, RouteHandler, SendRequest } from "./types.js";

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const DASHBOARD_SESSION_TTL_MS = 60 * 60 * 1000;
const LIVENESS_STALE_MS = 45_000;
const MAX_ACK_DELIVERY_IDS = 500;
const dashboardSessions = new Map<string, number>();
const lastSeenByUser = new Map<string, number>();
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearGraceTimer(name: string): void {
  const graceTimer = staleTimers.get(name);
  if (graceTimer) {
    clearTimeout(graceTimer);
    staleTimers.delete(name);
  }
}

export function clearAllGraceTimers(): void {
  for (const name of staleTimers.keys()) {
    clearGraceTimer(name);
  }
}

class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        req.resume();
        reject(new RequestError(413, `Request body exceeds ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RequestError(400, "Invalid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Generic text for any 500 — never echo raw internals to a caller. */
const INTERNAL_ERROR_MESSAGE = "Internal server error";

function sendError(res: ServerResponse, status: number, message: string, code?: HubErrorCode): void {
  const resolvedCode = code ?? codeForStatus(status);
  // `error` is kept for backward compatibility (slack-bot, dashboard read it);
  // `code`/`retryable` are the typed fields callers should branch on.
  sendJson(res, status, {
    error: message,
    code: resolvedCode,
    message,
    retryable: isRetryable(resolvedCode),
  });
}

/**
 * Send a 500 without leaking internals: the real error is logged server-side,
 * the caller receives only a generic message.
 */
function sendInternalError(res: ServerResponse, context: string, err: unknown): void {
  console.error(`[error] ${context}:`, err);
  sendError(res, 500, INTERNAL_ERROR_MESSAGE, "INTERNAL");
}

function rejectStaleSession(
  res: ServerResponse,
  userName: string | undefined,
  sessionEpoch: number | undefined,
): boolean {
  if (!userName || !isCurrentSession(userName, sessionEpoch)) {
    sendError(res, 401, "Unauthorized");
    return true;
  }
  return false;
}

function handleRouteError(res: ServerResponse, err: unknown): void {
  if (err instanceof RequestError) {
    sendError(res, err.status, err.message);
    return;
  }
  sendInternalError(res, "unhandled route error", err);
}

function validateImagePayload(image: unknown): MessageImage | undefined {
  if (image === undefined) return undefined;
  if (!image || typeof image !== "object") {
    throw new RequestError(400, "Invalid image payload");
  }
  const candidate = image as { data?: unknown; mimeType?: unknown };
  if (typeof candidate.data !== "string" || typeof candidate.mimeType !== "string") {
    throw new RequestError(400, "Invalid image payload");
  }
  if (!candidate.mimeType.startsWith("image/")) {
    throw new RequestError(400, "Image mimeType must start with image/");
  }
  const decodedBytes = Buffer.byteLength(candidate.data, "base64");
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw new RequestError(413, `Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  }
  return { data: candidate.data, mimeType: candidate.mimeType };
}

const handleRegister: RouteHandler = async (req, res) => {
  const body = await readJson<RegisterRequest>(req);
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  try {
    // Allow reconnection only if the caller proves ownership with the old token
    if (isUserRegistered(body.name)) {
      const existingToken = getUserToken(body.name);
      if (!body.oldToken || body.oldToken !== existingToken) {
        return sendError(res, 409, `User "${body.name}" is already registered`);
      }
      removePoll(body.name);
      unregisterUser(body.name, { preserveMemberships: true });
    }
    // Cancel grace timer if reconnecting
    clearGraceTimer(body.name);
    const role = body.role === "bridge" ? "bridge" : "agent";
    const user = registerUser(body.name, role);
    lastSeenByUser.set(body.name, Date.now());
    ensureQueue(body.name);
    setOnline(body.name);
    // Auto-join #all
    try {
      joinChannel("#all", body.name);
    } catch {
      /* already joined or channel issue */
    }
    // Restore previous channel memberships from DB
    const previousChannels = dbGetUserChannels(body.name);
    for (const ch of previousChannels) {
      if (ch === "#all") continue;
      try {
        joinChannel(ch, body.name);
        broadcast({ type: "channel_join", channel: ch, userName: body.name, timestamp: Date.now() });
        console.log(`[auto-rejoin] ${body.name} -> ${ch}`);
      } catch {
        /* channel may no longer exist */
      }
    }
    broadcast({ type: "join", name: body.name, timestamp: Date.now() });
    console.log(`[register] ${body.name}`);

    if (role === "agent") {
      notifyBridges(formatControl(USER_JOINED_PREFIX, body.name));
    } else if (role === "bridge") {
      // Send current agent list to the newly connected bridge (even if empty)
      const agents = getRegisteredUsers().filter((n) => n !== body.name && getUserRole(n) === "agent");
      enqueueAndDeliver(body.name, {
        id: randomUUID(),
        from: "system",
        to: body.name,
        content: formatControl(CONNECTED_USERS_PREFIX, agents.length > 0 ? agents.join(", ") : "(none)"),
        channel: "#all",
        timestamp: Date.now(),
      });
    }

    sendJson(res, 200, { token: user.token, name: user.name });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleSend: RouteHandler = async (req, res, userName, sessionEpoch) => {
  const body = await readJson<SendRequest>(req);
  if (rejectStaleSession(res, userName, sessionEpoch)) return;
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  const image = validateImagePayload(body.image);
  // Typing indicator: broadcast typing event without routing to chat log
  if (body.content === TYPING_SIGNAL) {
    const channel = body.channel || "#all";
    dbUpdateReadCursor(userName!, channel);
    broadcast({ type: "typing", name: userName!, channel, timestamp: Date.now() });
    console.log(`[typing] ${userName}`);
    return sendJson(res, 200, { id: "typing", to: body.to });
  }
  const content = body.content || "";
  const channel = body.channel || "#all";
  try {
    const message = routeMessage(userName!, body.to, content, channel, image);
    broadcast({
      type: "message",
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[send] ${userName} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    sendJson(res, 200, { id: message.id, to: message.to });
  } catch (e) {
    sendError(res, 404, (e as Error).message, "RECIPIENT_NOT_FOUND");
  }
};

const handleInbox: RouteHandler = async (_req, res, userName) => {
  const messages = peekQueue(userName!);
  sendJson(res, 200, { messages });
};

const handleAck: RouteHandler = async (req, res, userName, sessionEpoch) => {
  const body = await readJson<AckRequest>(req);
  if (rejectStaleSession(res, userName, sessionEpoch)) return;
  if (
    !Array.isArray(body.deliveryIds) ||
    body.deliveryIds.length > MAX_ACK_DELIVERY_IDS ||
    body.deliveryIds.some((id) => typeof id !== "string" || !id)
  ) {
    return sendError(res, 400, "Missing or invalid 'deliveryIds' field");
  }
  ackDeliveries(userName!, body.deliveryIds);
  sendJson(res, 200, { ok: true });
};

const handlePoll: RouteHandler = async (req, res, userName) => {
  const wasOffline = !isOnline(userName!);
  addPoll(userName!, req, res);
  if (wasOffline) {
    setOnline(userName!);
    broadcast({ type: "status", name: userName!, online: true, timestamp: Date.now() });
  }
};

const handleUsers: RouteHandler = async (_req, res) => {
  const users = getRegisteredUsers().map((name) => ({
    name,
    online: isOnline(name),
    role: getUserRole(name) ?? "agent",
  }));
  sendJson(res, 200, { users });
};

const handleHealth: RouteHandler = async (_req, res) => {
  const now = Date.now();
  const users = getRegisteredUsers().map((name) => ({
    name,
    role: getUserRole(name) ?? "agent",
    online: isOnline(name),
    lastSeenAt: lastSeenByUser.get(name) ?? null,
    stale: now - (lastSeenByUser.get(name) ?? 0) > LIVENESS_STALE_MS,
  }));
  const agents = dbListAgentConfigs().map((config) => ({
    name: config.name,
    configured: true,
    online: isUserRegistered(config.name) && isOnline(config.name),
    lastSeenAt: lastSeenByUser.get(config.name) ?? null,
    stale: now - (lastSeenByUser.get(config.name) ?? 0) > LIVENESS_STALE_MS,
  }));
  sendJson(res, 200, {
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: now,
    db: { ok: dbHealthCheck() },
    users,
    agents,
  });
};

const handleUnregister: RouteHandler = async (_req, res, userName) => {
  const role = getUserRole(userName!);
  removePoll(userName!);
  removeQueue(userName!);
  lastSeenByUser.delete(userName!);
  clearGraceTimer(userName!);
  unregisterUser(userName!);
  broadcast({ type: "leave", name: userName!, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(formatControl(USER_LEFT_PREFIX, userName!));
  }
  console.log(`[unregister] ${userName}`);
  sendJson(res, 200, { ok: true });
};

function kickUser(name: string): boolean {
  if (!getRegisteredUsers().includes(name)) return false;
  const role = getUserRole(name);
  // Send a termination message directly to the target user's queue only
  ensureQueue(name);
  enqueueAndDeliver(name, {
    id: randomUUID(),
    from: "system",
    to: name,
    content: formatControl(RADIO_KILLED_PREFIX, "You have been disconnected by the operator."),
    channel: "#all",
    timestamp: Date.now(),
  });
  removePoll(name);
  removeQueue(name);
  lastSeenByUser.delete(name);
  clearGraceTimer(name);
  unregisterUser(name);
  broadcast({ type: "leave", name, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(formatControl(USER_LEFT_PREFIX, name));
  }
  console.log(`[kick] ${name}`);
  return true;
}

const handleKick: RouteHandler = async (req, res) => {
  const body = await readJson<{ name?: string }>(req);
  if (!body.name) {
    return sendError(res, 400, "Missing 'name' field");
  }
  if (kickUser(body.name)) {
    sendJson(res, 200, { ok: true, kicked: body.name });
  } else {
    sendError(res, 404, `User "${body.name}" not found`);
  }
};

const handleKickAll: RouteHandler = async (_req, res) => {
  const agents = [...getRegisteredUsers()].filter((name) => name !== "operator");
  for (const name of agents) {
    kickUser(name);
  }
  sendJson(res, 200, { ok: true, kicked: agents });
};

const handleAdminSend: RouteHandler = async (req, res) => {
  const body = await readJson<{
    from?: string;
    to?: string;
    content?: string;
    channel?: string;
    image?: { data: string; mimeType: string };
  }>(req);
  const from = body.from || "operator";
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  const image = validateImagePayload(body.image);
  const content = body.content || "";
  const channel = body.channel || "#all";
  // Auto-register the admin sender so agents can reply
  if (!isUserRegistered(from)) {
    try {
      registerUser(from);
      ensureQueue(from);
      try {
        joinChannel("#all", from);
      } catch {
        /* already joined */
      }
      broadcast({ type: "join", name: from, timestamp: Date.now() });
      console.log(`[auto-register] ${from}`);
    } catch {
      /* already registered */
    }
  }
  // Ensure operator is in target channel
  try {
    joinChannel(channel, from);
  } catch {
    /* already joined or channel issue */
  }
  try {
    const message = routeMessage(from, body.to, content, channel, image);
    broadcast({
      type: "message",
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[admin-send] ${from} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    sendJson(res, 200, { id: message.id, to: message.to });
  } catch (e) {
    sendError(res, 404, (e as Error).message, "RECIPIENT_NOT_FOUND");
  }
};

// Channel endpoints
const handleChannelCreate: RouteHandler = async (req, res, userName, sessionEpoch) => {
  const body = await readJson<{ name?: string }>(req);
  if (rejectStaleSession(res, userName, sessionEpoch)) return;
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, userName!);
    ensureChannelMembership(channelName);
    // Auto-join the creator
    joinChannel(channelName, userName!);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    broadcast({ type: "channel_join", channel: channelName, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-create] ${channelName} by ${userName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendInternalError(res, `channel-create ${channelName}`, e);
  }
};

const handleChannelJoin: RouteHandler = async (req, res, userName, sessionEpoch) => {
  const body = await readJson<{ channel?: string }>(req);
  if (rejectStaleSession(res, userName, sessionEpoch)) return;
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  try {
    joinChannel(body.channel, userName!);
    broadcast({ type: "channel_join", channel: body.channel, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-join] ${userName} -> ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

const handleChannelLeave: RouteHandler = async (req, res, userName, sessionEpoch) => {
  const body = await readJson<{ channel?: string }>(req);
  if (rejectStaleSession(res, userName, sessionEpoch)) return;
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (body.channel === "#all") {
    return sendError(res, 400, "Cannot leave #all");
  }
  leaveChannel(body.channel, userName!);
  broadcast({ type: "channel_leave", channel: body.channel, userName: userName!, timestamp: Date.now() });
  console.log(`[channel-leave] ${userName} <- ${body.channel}`);
  sendJson(res, 200, { ok: true, channel: body.channel });
};

const handleChannelInvite: RouteHandler = async (req, res, userName, sessionEpoch) => {
  const body = await readJson<{ channel?: string; user?: string }>(req);
  if (rejectStaleSession(res, userName, sessionEpoch)) return;
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (!body.user || typeof body.user !== "string") {
    return sendError(res, 400, "Missing or invalid 'user' field");
  }
  const targetName = body.user.startsWith("@") ? body.user.slice(1) : body.user;
  if (!isUserRegistered(targetName)) {
    return sendError(res, 404, `User "${targetName}" is not connected`);
  }
  try {
    joinChannel(body.channel, targetName);
    broadcast({ type: "channel_join", channel: body.channel, userName: targetName, timestamp: Date.now() });
    // Notify the invited user via a system message in the channel
    routeMessage("system", `@${targetName}`, `You have been invited to ${body.channel} by ${userName}`, body.channel);
    console.log(`[channel-invite] ${userName} invited ${targetName} to ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel, user: targetName });
  } catch (e) {
    sendError(res, 400, (e as Error).message);
  }
};

const handleListChannels: RouteHandler = async (_req, res) => {
  const channels = dbListChannels();
  const memberCounts = getChannelMemberCounts();
  const result = channels.map((ch) => ({
    name: ch.name,
    createdBy: ch.created_by,
    createdAt: ch.created_at,
    memberCount: memberCounts.get(ch.name) ?? 0,
    members: getChannelMembers(ch.name),
  }));
  sendJson(res, 200, { channels: result });
};

const handleChannelHistory: RouteHandler = async (req, res, userName) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  if (!channel) {
    return sendError(res, 400, "Missing 'channel' query parameter");
  }
  if (!isChannelMember(channel, userName!)) {
    return sendError(res, 403, `You are not a member of ${channel}`);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const messages = dbGetChannelMessages(channel, limit);
  sendJson(res, 200, { messages });
};

const handleAdminChannelCreate: RouteHandler = async (req, res) => {
  const body = await readJson<{ name?: string }>(req);
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, "operator");
    ensureChannelMembership(channelName);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    console.log(`[admin-channel-create] ${channelName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendInternalError(res, `admin-channel-create ${channelName}`, e);
  }
};

const handleAdminChannelHistory: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 500);
  if (channel) {
    const messages = dbGetChannelMessages(channel, limit);
    sendJson(res, 200, { messages });
  } else {
    const messages = dbGetRecentMessages(limit);
    sendJson(res, 200, { messages });
  }
};

const handleAdminChannelDelete: RouteHandler = async (req, res) => {
  const body = await readJson<{ name?: string }>(req);
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (body.name === "#all") {
    return sendError(res, 400, "Cannot delete #all");
  }
  if (!dbGetChannel(body.name)) {
    return sendError(res, 404, `Channel "${body.name}" not found`);
  }
  dbDeleteChannel(body.name);
  dbDeleteChannelMessages(body.name);
  dbDeleteReadCursorsForChannel(body.name);
  removeChannel(body.name);
  broadcast({ type: "channel_delete", name: body.name, timestamp: Date.now() });
  console.log(`[admin-channel-delete] ${body.name}`);
  sendJson(res, 200, { ok: true, channel: body.name });
};

const handleAdminMarkRead: RouteHandler = async (req, res) => {
  const body = await readJson<{ channel?: string; timestamp?: number }>(req);
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  const ts = body.timestamp ?? Date.now();
  dbUpdateReadCursor("operator", body.channel, ts);
  broadcast({ type: "read_update", userName: "operator", channel: body.channel, timestamp: ts });
  sendJson(res, 200, { ok: true });
};

const handleAdminUnreadCounts: RouteHandler = async (_req, res) => {
  const counts = dbGetUnreadCounts("operator");
  sendJson(res, 200, { counts });
};

// Agent config endpoints
const handleAdminAgentConfigs: RouteHandler = async (_req, res) => {
  const configs = dbListAgentConfigs();
  const result: AgentConfigDTO[] = configs.map((c) => ({
    id: c.id,
    name: c.name,
    workDir: c.work_dir,
    command: c.command,
    autoStart: c.auto_start === 1,
    envVars: c.env_vars ? JSON.parse(c.env_vars) : {},
    createdAt: c.created_at,
    online: isUserRegistered(c.name) && isOnline(c.name),
  }));
  sendJson(res, 200, { configs: result });
};

const handleAdminAgentConfigCreate: RouteHandler = async (req, res) => {
  const body = await readJson<{
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string>;
  }>(req);
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (!AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  if (!body.workDir || typeof body.workDir !== "string") {
    return sendError(res, 400, "Missing or invalid 'workDir' field");
  }
  try {
    const id = randomUUID();
    const config = dbCreateAgentConfig(
      id,
      body.name,
      body.workDir,
      body.command || "",
      body.autoStart ?? false,
      body.envVars,
    );
    broadcast({ type: "agent_config_create", id: config.id, name: config.name, timestamp: Date.now() });
    console.log(`[agent-config-create] ${config.name}`);
    sendJson(res, 200, { ok: true, id: config.id });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleAdminAgentConfigUpdate: RouteHandler = async (req, res) => {
  const body = await readJson<{
    id?: string;
    name?: string;
    workDir?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  }>(req);
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (body.name && !AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(config.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  dbUpdateAgentConfig(body.id, {
    name: body.name,
    workDir: body.workDir,
    autoStart: body.autoStart,
    envVars: body.envVars,
  });
  const name = body.name ?? config.name;
  broadcast({ type: "agent_config_update", id: body.id, name, timestamp: Date.now() });
  console.log(`[agent-config-update] ${name}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentConfigDelete: RouteHandler = async (req, res) => {
  const body = await readJson<{ id?: string }>(req);
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const configToDelete = dbGetAgentConfig(body.id);
  if (!configToDelete) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(configToDelete.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  if (!dbDeleteAgentConfig(body.id)) {
    return sendError(res, 404, "Agent config not found");
  }
  broadcast({ type: "agent_config_delete", id: body.id, timestamp: Date.now() });
  console.log(`[agent-config-delete] ${body.id}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentStart: RouteHandler = async (req, res) => {
  const body = await readJson<{ id?: string }>(req);
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  try {
    await launchAgent(config);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendInternalError(res, `agent-start ${config.name}`, e);
  }
};

const publicRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/health": { method: "GET", handler: handleHealth },
  "/users": { method: "GET", handler: handleUsers },
  "/channels": { method: "GET", handler: handleListChannels },
};

const joinRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/register": { method: "POST", handler: handleRegister },
};

const adminRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/kick": { method: "POST", handler: handleKick },
  "/kick-all": { method: "POST", handler: handleKickAll },
  "/admin-send": { method: "POST", handler: handleAdminSend },
  "/admin-channel-create": { method: "POST", handler: handleAdminChannelCreate },
  "/admin-channel-delete": { method: "POST", handler: handleAdminChannelDelete },
  "/admin-channel-history": { method: "GET", handler: handleAdminChannelHistory },
  "/admin-mark-read": { method: "POST", handler: handleAdminMarkRead },
  "/admin-unread-counts": { method: "GET", handler: handleAdminUnreadCounts },
  "/admin-agent-configs": { method: "GET", handler: handleAdminAgentConfigs },
  "/admin-agent-config-create": { method: "POST", handler: handleAdminAgentConfigCreate },
  "/admin-agent-config-update": { method: "POST", handler: handleAdminAgentConfigUpdate },
  "/admin-agent-config-delete": { method: "POST", handler: handleAdminAgentConfigDelete },
  "/admin-agent-start": { method: "POST", handler: handleAdminAgentStart },
};

const protectedRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/send": { method: "POST", handler: handleSend },
  "/poll": { method: "GET", handler: handlePoll },
  "/inbox": { method: "GET", handler: handleInbox },
  "/ack": { method: "POST", handler: handleAck },
  "/unregister": { method: "POST", handler: handleUnregister },
  "/channel-create": { method: "POST", handler: handleChannelCreate },
  "/channel-join": { method: "POST", handler: handleChannelJoin },
  "/channel-leave": { method: "POST", handler: handleChannelLeave },
  "/channel-invite": { method: "POST", handler: handleChannelInvite },
  "/channel-history": { method: "GET", handler: handleChannelHistory },
};

function authenticateBearer(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token === expected;
}

function createDashboardSession(): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + DASHBOARD_SESSION_TTL_MS;
  dashboardSessions.set(token, expiresAt);
  return { token, expiresAt };
}

function authenticateDashboardSession(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  const expiresAt = dashboardSessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    dashboardSessions.delete(token);
    return false;
  }
  return true;
}

export function createHubServer(port: number, adminToken: string, joinToken: string): import("node:http").Server {
  // When a poll connection drops unexpectedly, mark user offline and start grace timer
  onPollDisconnect((userName) => {
    if (!isUserRegistered(userName)) return;
    setOffline(userName);
    broadcast({ type: "status", name: userName, online: false, timestamp: Date.now() });
    console.log(`[offline] ${userName} (grace period ${STALE_GRACE_MS / 1000}s)`);

    clearGraceTimer(userName);
    const sessionEpoch = getSessionEpoch(userName);
    if (sessionEpoch === null) return;

    staleTimers.set(
      userName,
      setTimeout(() => {
        staleTimers.delete(userName);
        if (isUserRegistered(userName) && !isOnline(userName) && isCurrentSession(userName, sessionEpoch)) {
          const role = getUserRole(userName);
          removePoll(userName);
          removeQueue(userName);
          setOffline(userName);
          lastSeenByUser.delete(userName);
          unregisterUser(userName);
          broadcast({ type: "leave", name: userName, timestamp: Date.now() });
          if (role === "agent") {
            notifyBridges(formatControl(USER_LEFT_PREFIX, userName));
          }
          console.log(`[auto-unregister] ${userName} (stale)`);
        }
      }, STALE_GRACE_MS),
    );
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Dashboard & SSE
    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHTML());
      return;
    }
    if (path === "/events" && req.method === "GET") {
      addSSEClient(res);
      return;
    }

    if (path === "/dashboard-login") {
      if (req.method !== "POST") {
        sendError(res, 405, "Method not allowed");
        return;
      }
      readJson<{ token?: string }>(req)
        .then((body) => {
          if (body.token !== adminToken) {
            sendError(res, 401, "Admin token required");
            return;
          }
          sendJson(res, 200, createDashboardSession());
        })
        .catch((e) => {
          handleRouteError(res, e);
        });
      return;
    }

    // Public routes
    const publicRoute = publicRoutes[path];
    if (publicRoute) {
      if (req.method !== publicRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      publicRoute.handler(req, res).catch((e) => {
        handleRouteError(res, e);
      });
      return;
    }

    // Join routes (require join token)
    const joinRoute = joinRoutes[path];
    if (joinRoute) {
      if (req.method !== joinRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, joinToken)) {
        sendError(res, 401, "Join token required");
        return;
      }
      joinRoute.handler(req, res).catch((e) => {
        handleRouteError(res, e);
      });
      return;
    }

    // Admin routes (require admin token)
    const adminRoute = adminRoutes[path];
    if (adminRoute) {
      if (req.method !== adminRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, adminToken) && !authenticateDashboardSession(req)) {
        sendError(res, 401, "Admin token required");
        return;
      }
      adminRoute.handler(req, res).catch((e) => {
        handleRouteError(res, e);
      });
      return;
    }

    // User-protected routes (require user token)
    const protectedRoute = protectedRoutes[path];
    if (protectedRoute) {
      if (req.method !== protectedRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      const userName = authenticateRequest(req);
      if (!userName) {
        sendError(res, 401, "Unauthorized");
        return;
      }
      const sessionEpoch = getSessionEpoch(userName);
      if (sessionEpoch === null) {
        sendError(res, 401, "Unauthorized");
        return;
      }
      // Any authenticated request proves the agent is alive
      if (!isOnline(userName)) {
        setOnline(userName);
        broadcast({ type: "status", name: userName, online: true, timestamp: Date.now() });
      }
      lastSeenByUser.set(userName, Date.now());
      protectedRoute.handler(req, res, userName, sessionEpoch).catch((e) => {
        handleRouteError(res, e);
      });
      return;
    }

    sendError(res, 404, "Not found");
  }

  const server = createServer(handleRequest);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${port} is already in use. Is another Hub instance running?`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Walkie-Talkie Hub listening on http://localhost:${port}`);
  });
  return server;
}
