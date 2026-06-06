import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatControl, HubError, isControl, RADIO_KILLED_PREFIX } from "@walkie-talkie/contract";
import { z } from "zod";
import { HubClient } from "./client.js";

const RADIO_KILLED_NOTICE = formatControl(
  RADIO_KILLED_PREFIX,
  "You have been disconnected by the operator. Do NOT call any more radio tools. Stop immediately.",
);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 5;

function getMimeType(source: string): string {
  const ext = path.extname(source).toLowerCase();
  return MIME_TYPES[ext] ?? "image/png";
}

function fetchUrl(url: string, redirectsRemaining = MAX_IMAGE_REDIRECTS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      reject(new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`));
      return;
    }

    const transport = parsedUrl.protocol === "https:" ? https : http;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    const req = transport
      .get(parsedUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsRemaining <= 0) {
            fail(new Error(`Too many redirects while fetching image: ${url}`));
            return;
          }
          const nextUrl = new URL(res.headers.location, parsedUrl).toString();
          res.resume();
          fetchUrl(nextUrl, redirectsRemaining - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          fail(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const contentLength = Number(res.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
          fail(new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_IMAGE_BYTES) {
            fail(new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        });
        res.on("error", fail);
      })
      .on("error", fail)
      .setTimeout(IMAGE_FETCH_TIMEOUT_MS, () => {
        fail(new Error(`Image fetch timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`));
      });
  });
}

function readImageFile(source: string): Buffer {
  const stat = fs.statSync(source);
  if (!stat.isFile()) {
    throw new Error("Image source must be a regular file");
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  }
  return fs.readFileSync(source);
}

let client: HubClient;
let joinToken: string;
let currentToken: string | null = null;
let currentName: string | null = null;

export function createMcpServer(hubUrl: string, joinTok: string): McpServer {
  client = new HubClient(hubUrl);
  joinToken = joinTok;

  const server = new McpServer({
    name: "walkie-talkie",
    version: "1.0.0",
  });

  server.tool(
    "radio_join",
    "Join the Walkie-Talkie hub with a display name. You must join before using other radio tools.",
    { name: z.string().describe("Your display name for this session") },
    async ({ name }) => {
      try {
        const result = await client.register(name, joinToken, currentToken ?? undefined);
        currentToken = result.token;
        currentName = result.name;
        return {
          content: [
            {
              type: "text" as const,
              text: `Registered as "${currentName}". You are now in #all. You can now send and receive messages.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Registration failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_over",
    "Send a message to another user. Use @name format for the recipient, or @all to broadcast. Messages are scoped to a channel.",
    {
      to: z.string().describe("Recipient: @name or @all"),
      message: z.string().describe("Message content"),
      channel: z
        .string()
        .optional()
        .describe(
          "Channel to send to. IMPORTANT: Always reply in the same channel where you received the message. Defaults to #all if omitted.",
        ),
      image_data: z
        .string()
        .optional()
        .describe("Base64-encoded image data. Must be provided together with image_mime_type."),
      image_mime_type: z
        .string()
        .optional()
        .describe("MIME type of the image (e.g. 'image/png'). Must be provided together with image_data."),
    },
    async ({ to, message, channel, image_data, image_mime_type }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        const image = image_data && image_mime_type ? { data: image_data, mimeType: image_mime_type } : undefined;
        const result = await client.send(currentToken, to, message, channel, image);
        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent to ${result.to} in ${channel || "#all"} (id: ${result.id})`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Send failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_send_image",
    "Send an image from a local file path or URL. Much faster than passing base64 via radio_over.",
    {
      to: z.string().describe("Recipient: @name or @all"),
      source: z.string().describe("Image file path or URL (http/https)"),
      message: z.string().optional().describe("Optional text message to accompany the image"),
      channel: z.string().optional().describe("Channel to send to (default: #all)"),
    },
    async ({ to, source, message, channel }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        let buf: Buffer;
        if (source.startsWith("http://") || source.startsWith("https://")) {
          buf = await fetchUrl(source);
        } else {
          buf = readImageFile(source);
        }
        const data = buf.toString("base64");
        const mimeType = getMimeType(source);
        const result = await client.send(currentToken, to, message ?? "", channel, { data, mimeType });
        return {
          content: [
            {
              type: "text" as const,
              text: `Image sent to ${result.to} in ${channel || "#all"} (id: ${result.id})`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to send image: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_check",
    "Check for new messages immediately without waiting. Returns any queued messages instantly. Use this instead of radio_standby when you want to poll periodically with sleep in between.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        const result = await client.inbox(currentToken);
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const killed = result.messages.find((m) => isControl(m.content, RADIO_KILLED_PREFIX));
        if (killed) {
          currentToken = null;
          currentName = null;
          return {
            content: [
              {
                type: "text" as const,
                text: RADIO_KILLED_NOTICE,
              },
            ],
            isError: true,
          };
        }
        const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
          [];
        for (const m of result.messages) {
          if (m.image) {
            contentBlocks.push({
              type: "image" as const,
              data: m.image.data,
              mimeType: m.image.mimeType,
            });
          }
          const imageTag = m.image ? " [image attached]" : "";
          const line = `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.channel || "#all"} ${m.from} → ${m.to}: ${m.content}${imageTag}`;
          contentBlocks.push({ type: "text" as const, text: line });
        }
        const channels = [
          ...new Set(result.messages.filter((m) => m.channel && m.channel !== "#all").map((m) => m.channel)),
        ];
        if (channels.length > 0) {
          contentBlocks.push({
            type: "text" as const,
            text: `\nIMPORTANT: Reply in the same channel you received the message on. Use the channel parameter: ${channels.map((c) => `"${c}"`).join(", ")}`,
          });
        }
        return { content: contentBlocks };
      } catch (e) {
        const msg = (e as Error).message;
        if (e instanceof HubError && e.code === "UNAUTHENTICATED") {
          currentToken = null;
          currentName = null;
          return {
            content: [
              {
                type: "text" as const,
                text: RADIO_KILLED_NOTICE,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Check failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_standby",
    "Stand by for incoming messages using long polling. Blocks up to 1 hour. Returns received messages or empty if timeout.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        const result = await client.poll(currentToken);
        if (!result || result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages (poll timed out). Try again." }],
          };
        }
        // Check for kill signal from operator
        const killed = result.messages.find((m) => isControl(m.content, RADIO_KILLED_PREFIX));
        if (killed) {
          currentToken = null;
          currentName = null;
          return {
            content: [
              {
                type: "text" as const,
                text: RADIO_KILLED_NOTICE,
              },
            ],
            isError: true,
          };
        }
        const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
          [];

        for (const m of result.messages) {
          if (m.image) {
            contentBlocks.push({
              type: "image" as const,
              data: m.image.data,
              mimeType: m.image.mimeType,
            });
          }
          const imageTag = m.image ? " [image attached]" : "";
          const line = `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.channel || "#all"} ${m.from} → ${m.to}: ${m.content}${imageTag}`;
          contentBlocks.push({ type: "text" as const, text: line });
        }

        // Remind the agent to reply in the same channel the message was received on
        const channels = [
          ...new Set(result.messages.filter((m) => m.channel && m.channel !== "#all").map((m) => m.channel)),
        ];
        const hint =
          channels.length > 0
            ? `\n\nIMPORTANT: Reply in the same channel you received the message on. Use the channel parameter: ${channels.map((c) => `"${c}"`).join(", ")}`
            : "";
        if (hint) {
          contentBlocks.push({ type: "text" as const, text: hint });
        }
        return {
          content: contentBlocks,
        };
      } catch (e) {
        const msg = (e as Error).message;
        if (e instanceof HubError && e.code === "UNAUTHENTICATED") {
          currentToken = null;
          currentName = null;
          return {
            content: [
              {
                type: "text" as const,
                text: RADIO_KILLED_NOTICE,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Poll failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channels",
    "List all currently connected users on the hub and available channels.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        const [users, channels] = await Promise.all([client.users(currentToken), client.listChannels(currentToken)]);
        const connectedUsers = users.filter((u) => u.online).map((u) => u.name);
        const userText =
          connectedUsers.length > 0 ? `Connected users: ${connectedUsers.join(", ")}` : "No users connected.";
        const channelText =
          channels.length > 0
            ? `Channels: ${channels.map((c) => `${c.name} (${c.memberCount} members)`).join(", ")}`
            : "No channels.";
        return {
          content: [
            {
              type: "text" as const,
              text: `${userText}\n${channelText}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_create",
    "Create a new channel on the hub. You will automatically join the channel.",
    { name: z.string().describe("Channel name (with or without # prefix)") },
    async ({ name }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        const result = await client.createChannel(currentToken, name);
        return {
          content: [
            {
              type: "text" as const,
              text: `Channel ${result.channel} created. You have been auto-joined.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to create channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_join",
    "Join an existing channel to send and receive messages in it.",
    { channel: z.string().describe("Channel name to join (e.g. #my-channel)") },
    async ({ channel }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        await client.joinChannel(currentToken, channel);
        return {
          content: [
            {
              type: "text" as const,
              text: `Joined ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to join channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_leave",
    "Leave a channel. You cannot leave #all.",
    { channel: z.string().describe("Channel name to leave") },
    async ({ channel }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        await client.leaveChannel(currentToken, channel);
        return {
          content: [
            {
              type: "text" as const,
              text: `Left ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to leave channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_channel_invite",
    "Invite another user to a channel. The user is automatically joined and notified via their next poll.",
    {
      channel: z.string().describe("Channel name to invite the user to"),
      user: z.string().describe("User to invite (e.g. @agent-name)"),
    },
    async ({ channel, user }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      try {
        await client.inviteToChannel(currentToken, channel, user);
        return {
          content: [
            {
              type: "text" as const,
              text: `Invited ${user} to ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to invite: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "radio_token",
    "Get the current session token, hub URL, and path to radio-wait.sh script. Use this to run the wait script in a terminal for real-time polling.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use radio_join first." }],
          isError: true,
        };
      }
      const thisFile = fileURLToPath(import.meta.url);
      const waitScript = path.resolve(path.dirname(thisFile), "..", "bin", "radio-wait.sh");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              hubUrl: client.getBaseUrl(),
              token: currentToken,
              waitScript,
            }),
          },
        ],
      };
    },
  );

  server.tool("radio_out", "Sign off and disconnect from the Walkie-Talkie hub. Over and out.", {}, async () => {
    if (!currentToken) {
      return {
        content: [{ type: "text" as const, text: "Not registered." }],
      };
    }
    try {
      await client.unregister(currentToken);
      const name = currentName;
      currentToken = null;
      currentName = null;
      return {
        content: [{ type: "text" as const, text: `Unregistered "${name}". Disconnected from hub.` }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Unregister failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}
