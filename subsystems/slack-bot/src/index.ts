import bolt from "@slack/bolt";

const { App } = bolt;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.WALKIE_TALKIE_SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.WALKIE_TALKIE_SLACK_APP_TOKEN;
const HUB_URL = process.env.WALKIE_TALKIE_HUB_URL || "http://localhost:9559";
const JOIN_TOKEN = process.env.WALKIE_TALKIE_JOIN_TOKEN;
let slackNotifyChannel: string | null = process.env.WALKIE_TALKIE_SLACK_SYSTEM_NOTIFY_CHANNEL ?? null;
const BOT_NAME = "slack";
const HUB_REQUEST_TIMEOUT_MS = 10_000;
const HUB_POLL_TIMEOUT_MS = 3_660_000; // 1 hour hub hold + 60s client margin
const REGISTER_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REGISTER_GRACE_RETRY_MS = 35_000;

if (!SLACK_BOT_TOKEN) {
  console.error("WALKIE_TALKIE_SLACK_BOT_TOKEN environment variable is required");
  process.exit(1);
}
if (!SLACK_APP_TOKEN) {
  console.error("WALKIE_TALKIE_SLACK_APP_TOKEN environment variable is required");
  process.exit(1);
}
if (!JOIN_TOKEN) {
  console.error("WALKIE_TALKIE_JOIN_TOKEN environment variable is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Hub client
// ---------------------------------------------------------------------------

let hubToken: string | null = null;
let botUserId: string | null = null;

class HubUnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "HubUnauthorizedError";
  }
}

class RetryableHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableHubError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt: number): number {
  return REGISTER_RETRY_DELAYS_MS[Math.min(attempt, REGISTER_RETRY_DELAYS_MS.length - 1)];
}

async function hubFetch(path: string, init: RequestInit = {}, timeoutMs = HUB_REQUEST_TIMEOUT_MS): Promise<Response> {
  return fetch(`${HUB_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readHubError(res: Response, fallback: string): Promise<string> {
  try {
    const err = (await res.json()) as { error?: string };
    return err.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function hubRegister(): Promise<void> {
  let attempt = 0;
  while (!shuttingDown) {
    try {
      const res = await hubFetch("/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JOIN_TOKEN}`,
        },
        body: JSON.stringify({ name: BOT_NAME, oldToken: hubToken, role: "bridge" }),
      });
      if (res.ok) {
        const data = (await res.json()) as { token: string; name: string };
        hubToken = data.token;
        console.log(`[hub] Registered as "${data.name}"`);
        return;
      }
      const error = await readHubError(res, `HTTP ${res.status}`);
      if (res.status === 409) {
        console.log("[hub] Already registered, waiting for grace period to expire...");
        await sleep(REGISTER_GRACE_RETRY_MS);
        attempt = 0;
        continue;
      }
      if (res.status >= 500) {
        throw new RetryableHubError(`Hub returned ${res.status}: ${error}`);
      }
      throw new Error(`Failed to register on Hub: ${error}`);
    } catch (e) {
      if (e instanceof Error && !(e instanceof RetryableHubError) && e.message.startsWith("Failed to register")) {
        throw e;
      }
      const delayMs = getRetryDelayMs(attempt++);
      console.error(`[hub] Register failed: ${(e as Error).message}. Retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }
  throw new Error("Shutting down before Hub registration completed");
}

async function hubSend(to: string, content: string): Promise<void> {
  const res = await hubFetch("/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify({ to, content }),
  });
  if (!res.ok) {
    const error = await readHubError(res, "Send failed");
    throw new Error(`Failed to send message: ${error}`);
  }
}

interface HubMessage {
  id: string;
  deliveryId?: string;
  from: string;
  to: string;
  content: string;
  channel: string;
  timestamp: number;
  image?: {
    data: string;
    mimeType: string;
  };
}

interface HubUser {
  name: string;
  online: boolean;
  role: string;
}

async function hubGetAgents(): Promise<HubUser[]> {
  const res = await hubFetch("/users");
  if (!res.ok) {
    const error = await readHubError(res, "Failed to fetch users");
    throw new Error(`Failed to get agents: ${error}`);
  }
  const data = (await res.json()) as { users: HubUser[] };
  return data.users.filter((u) => u.role === "agent" && u.online);
}

async function replyIfNoAgents(
  say: (message: { text: string; thread_ts: string }) => Promise<unknown>,
  threadTs: string,
): Promise<boolean> {
  try {
    const agents = await hubGetAgents();
    if (agents.length > 0) return false;
    await say({ text: "No agents are currently connected to the Hub.", thread_ts: threadTs });
  } catch (e) {
    await say({ text: `Hub is unavailable: ${(e as Error).message}`, thread_ts: threadTs });
  }
  return true;
}

async function hubPoll(): Promise<HubMessage[]> {
  const res = await hubFetch(
    "/poll",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${hubToken}`,
      },
    },
    HUB_POLL_TIMEOUT_MS,
  );
  if (res.status === 401) {
    throw new HubUnauthorizedError();
  }
  if (res.status === 204) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`Poll failed: ${res.status}`);
  }
  const data = (await res.json()) as { messages: HubMessage[] };
  return data.messages;
}

async function hubAck(deliveryId: string): Promise<void> {
  const res = await hubFetch("/ack", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify({ deliveryIds: [deliveryId] }),
  });
  if (!res.ok) {
    const error = await readHubError(res, "Ack failed");
    throw new Error(`Failed to ack message: ${error}`);
  }
}

async function ackIfDelivered(msg: HubMessage): Promise<void> {
  if (msg.deliveryId) {
    await hubAck(msg.deliveryId);
  }
}

// ---------------------------------------------------------------------------
// Pending reply tracking
// ---------------------------------------------------------------------------

interface PendingReply {
  slackChannel: string;
  threadTs: string;
}

// Map: agent name -> pending reply info
// When we send to @all, we use "*" as the key
const pendingReplies = new Map<string, PendingReply>();

// Map: Slack thread_ts -> last agent name used in that thread
const threadAgents = new Map<string, string>();

// ---------------------------------------------------------------------------
// System message formatting
// ---------------------------------------------------------------------------

function formatSystemMessage(content: string): string | null {
  if (content.startsWith("CONNECTED_USERS: ")) {
    const users = content.slice("CONNECTED_USERS: ".length);
    if (users === "(none)") {
      return ":satellite: Walkie-Talkie bridge connected. No agents online.";
    }
    return `:satellite: Walkie-Talkie bridge connected. Online agents: ${users}`;
  }
  if (content.startsWith("USER_JOINED: ")) {
    const name = content.slice("USER_JOINED: ".length);
    return `:loud_sound: *${name}* joined Walkie-Talkie`;
  }
  if (content.startsWith("USER_LEFT: ")) {
    const name = content.slice("USER_LEFT: ".length);
    return `:mute: *${name}* left Walkie-Talkie`;
  }
  return null;
}

function formatSlackReply(msg: HubMessage): string {
  const body = msg.content.trim() || "(no text)";
  const imageNotice = msg.image
    ? `\n\n[image attached: ${msg.image.mimeType}, ${msg.image.data.length} base64 chars; Slack bridge cannot upload images yet]`
    : "";
  return `*@@${msg.from}*:\n${body}${imageNotice}`;
}

// ---------------------------------------------------------------------------
// Poll loop — receives messages from Hub and posts to Slack
// ---------------------------------------------------------------------------

let slackApp: InstanceType<typeof App>;

async function pollLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const messages = await hubPoll();
      for (const msg of messages) {
        // Handle system notifications (user join/leave)
        if (msg.from === "system") {
          console.log(`[system] ${msg.content}`);
          if (msg.content.startsWith("RADIO_KILLED:")) {
            console.log("[slack-bot] Received RADIO_KILLED, stopping poll loop.");
            await ackIfDelivered(msg);
            return;
          }
          if (slackNotifyChannel) {
            const text = formatSystemMessage(msg.content);
            if (text) {
              try {
                await slackApp.client.chat.postMessage({ channel: slackNotifyChannel, text });
              } catch (e) {
                const err = (e as Error).message;
                console.error(
                  `[notify] Failed to post to ${slackNotifyChannel}: ${err}. Disabling Slack notifications.`,
                );
                slackNotifyChannel = null;
              }
            }
          }
          await ackIfDelivered(msg);
          continue;
        }
        // Skip our own messages
        if (msg.from === BOT_NAME) {
          await ackIfDelivered(msg);
          continue;
        }

        // Find the pending reply for this agent or for @all
        const pending = pendingReplies.get(msg.from) || pendingReplies.get("*");
        if (pending) {
          pendingReplies.delete(msg.from);
          pendingReplies.delete("*");

          await slackApp.client.chat.postMessage({
            channel: pending.slackChannel,
            thread_ts: pending.threadTs,
            text: formatSlackReply(msg),
          });
          await ackIfDelivered(msg);
        } else {
          // No pending reply — post as a new message to a default channel if configured
          const imageTag = msg.image ? ` [image attached: ${msg.image.mimeType}]` : "";
          console.log(`[hub] Unmatched message from ${msg.from}: ${msg.content.slice(0, 100)}${imageTag}`);
          await ackIfDelivered(msg);
        }
      }
    } catch (e) {
      if (e instanceof HubUnauthorizedError) {
        hubToken = null;
        console.log("[slack-bot] Hub rejected poll token, stopping poll loop.");
        return;
      }
      console.error("[poll] Error:", (e as Error).message);
      // Re-register and retry
      try {
        await hubRegister();
      } catch (regErr) {
        console.error("[poll] Re-register failed:", (regErr as Error).message);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// ---------------------------------------------------------------------------
// Slack mention handling
// ---------------------------------------------------------------------------

function stripBotMention(text: string): string {
  // Remove only the bot's own mention, keep all other <@USER> mentions intact
  if (botUserId) {
    return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }
  return text;
}

// ---------------------------------------------------------------------------
// Parse mention text: "@walkie-talkie @@alice do something" or "@walkie-talkie do something"
// ---------------------------------------------------------------------------

function parseCommand(text: string): { to: string; content: string } {
  const trimmed = text.trim();

  // Check if the first token is @@someone (double-@ to avoid Slack mention confusion)
  const match = trimmed.match(/^@@(\S+)\s+([\s\S]*)$/);
  if (match) {
    return { to: `@${match[1]}`, content: match[2].trim() };
  }

  // No target specified — send to @all
  return { to: "@all", content: trimmed };
}

// ---------------------------------------------------------------------------
// Slack app
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  slackApp = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Handle mentions: @walkie-talkie <message>
  slackApp.event("app_mention", async ({ event, say }) => {
    const rawText = stripBotMention(event.text);

    if (!rawText) {
      await say({
        text: "Usage: `@walkie-talkie @@agent-name message` or `@walkie-talkie message`",
        thread_ts: event.ts,
      });
      return;
    }

    const { to, content } = parseCommand(rawText);

    if (await replyIfNoAgents(say, event.ts)) {
      return;
    }

    // Post "thinking..." in thread
    const thinkingRes = await say({ text: `_thinking... (sending to ${to})_`, thread_ts: event.ts });

    // Track pending reply and remember agent for this thread
    const agentKey = to === "@all" ? "*" : to.slice(1);
    pendingReplies.set(agentKey, {
      slackChannel: event.channel,
      threadTs: event.ts,
    });
    if (to !== "@all") {
      threadAgents.set(event.ts, to);
    }

    // Send to Hub
    try {
      await hubSend(to, `[from Slack] ${content}`);
      console.log(`[slack] ${to}: ${content.slice(0, 100)}`);
    } catch (e) {
      const errorMsg = (e as Error).message;
      // Update the thinking message with the error
      if (thinkingRes?.ts) {
        await slackApp.client.chat.update({
          channel: event.channel,
          ts: thinkingRes.ts,
          text: `Error: ${errorMsg}`,
        });
      }
      pendingReplies.delete(agentKey);
    }
  });

  // Handle thread replies (without @mention)
  slackApp.message(async ({ message, say }) => {
    const msg = message as unknown as Record<string, unknown>;
    // Only handle thread replies
    if (!msg.thread_ts) return;
    // Ignore bot's own messages
    if (msg.bot_id) return;

    const text = typeof msg.text === "string" ? msg.text : "";
    const rawText = stripBotMention(text);
    if (!rawText) return;

    const threadTs = msg.thread_ts as string;
    const channel = msg.channel as string;

    // If no target specified, use the last agent from this thread
    let { to, content } = parseCommand(rawText);
    if (to === "@all" && threadAgents.has(threadTs)) {
      to = threadAgents.get(threadTs)!;
      content = rawText;
    }

    if (await replyIfNoAgents(say, threadTs)) {
      return;
    }

    // Track pending reply for the thread
    const agentKey = to === "@all" ? "*" : to.slice(1);
    if (to !== "@all") {
      threadAgents.set(threadTs, to);
    }
    pendingReplies.set(agentKey, {
      slackChannel: channel,
      threadTs,
    });

    try {
      await hubSend(to, `[from Slack] ${content}`);
      console.log(`[slack:thread] ${to}: ${content.slice(0, 100)}`);
    } catch (e) {
      await say({ text: `Error: ${(e as Error).message}`, thread_ts: threadTs });
      pendingReplies.delete(agentKey);
    }
  });

  // Get bot's own user ID
  const authResult = await slackApp.client.auth.test();
  botUserId = authResult.user_id ?? null;
  console.log(`[slack] Bot user ID: ${botUserId}`);

  // Register on Hub
  await hubRegister();

  // Start poll loop
  pollLoop();

  // Start Slack app
  await slackApp.start();
  console.log("[slack-bot] Running");
}

async function notifyShutdown(): Promise<void> {
  if (!slackNotifyChannel) return;
  try {
    await slackApp.client.chat.postMessage({
      channel: slackNotifyChannel,
      text: ":electric_plug: Walkie-Talkie bridge disconnected.",
    });
  } catch {
    // best effort
  }
}

let shuttingDown = false;
async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[slack-bot] Shutting down...");
  await notifyShutdown();
  process.exit(exitCode);
}

function fatal(reason: string, err: unknown): void {
  console.error(`[fatal] ${reason}:`, err);
  void shutdown(1);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", (err) => fatal("uncaughtException", err));
process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));

main().catch((e) => {
  console.error("Fatal:", e);
  notifyShutdown().finally(() => process.exit(1));
});
