import http from "node:http";
import https from "node:https";
import {
  type ChannelSummary,
  codeForStatus,
  HubError,
  type HubUser,
  isHubErrorBody,
  type Message,
  POLL_CLIENT_TIMEOUT_MS,
  type PollResponse,
  type RegisterResponse,
  type SendResponse,
  type UsersResponse,
} from "@walkie-talkie/contract";

interface RequestOptions {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface HubResponse<T = unknown> {
  status: number;
  data: T;
}

export type { HubUser } from "@walkie-talkie/contract";

export class HubClient {
  private baseUrl: URL;

  constructor(hubUrl: string) {
    this.baseUrl = new URL(hubUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl.toString().replace(/\/$/, "");
  }

  private request<T>(options: RequestOptions): Promise<HubResponse<T>> {
    return new Promise((resolve, reject) => {
      const isHttps = this.baseUrl.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {};
      if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
      }

      let bodyStr: string | undefined;
      if (options.body !== undefined) {
        bodyStr = JSON.stringify(options.body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }

      const req = transport.request(
        {
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port,
          path: options.path,
          method: options.method,
          headers,
          timeout: options.timeoutMs ?? 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            const status = res.statusCode ?? 0;
            if (status === 204 || raw.length === 0) {
              resolve({ status, data: {} as T });
              return;
            }
            try {
              resolve({ status, data: JSON.parse(raw) as T });
            } catch {
              // Don't echo the raw (possibly huge / sensitive) body back out.
              reject(new HubError("INTERNAL", "Invalid response from hub"));
            }
          });
        },
      );

      // Connection refused / DNS / reset etc. — the hub is unreachable, not a
      // protocol error. Surface a typed, retryable error, never raw ECONNREFUSED.
      req.on("error", () => reject(new HubError("HUB_UNREACHABLE", "Hub is unreachable")));
      req.on("timeout", () => {
        req.destroy();
        reject(new HubError("HUB_UNREACHABLE", "Hub request timed out"));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * Turn a non-200 response into a typed HubError. Uses the typed wire fields
   * when present, otherwise derives a code from the HTTP status.
   */
  private toHubError(res: HubResponse, fallbackMessage: string): HubError {
    if (isHubErrorBody(res.data)) {
      return HubError.fromBody(res.data, res.status);
    }
    // res.data may be null / a primitive (odd non-200 body) — read `error` defensively.
    const message = (res.data as { error?: string } | null)?.error ?? fallbackMessage;
    return new HubError(codeForStatus(res.status), message, res.status);
  }

  async register(name: string, joinToken: string, oldToken?: string): Promise<RegisterResponse> {
    const body: { name: string; oldToken?: string } = { name };
    if (oldToken) body.oldToken = oldToken;
    const res = await this.request<RegisterResponse>({
      method: "POST",
      path: "/register",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Registration failed");
    }
    return res.data;
  }

  async unregister(token: string): Promise<void> {
    await this.request({
      method: "POST",
      path: "/unregister",
      token,
    });
  }

  async send(
    token: string,
    to: string,
    content: string,
    channel?: string,
    image?: { data: string; mimeType: string },
  ): Promise<SendResponse> {
    const body: { to: string; content: string; channel?: string; image?: { data: string; mimeType: string } } = {
      to,
      content,
    };
    if (channel) body.channel = channel;
    if (image) body.image = image;
    const res = await this.request<SendResponse>({
      method: "POST",
      path: "/send",
      token,
      body,
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Send failed");
    }
    return res.data;
  }

  async poll(token: string): Promise<PollResponse | null> {
    const res = await this.request<PollResponse>({
      method: "GET",
      path: "/poll",
      token,
      timeoutMs: POLL_CLIENT_TIMEOUT_MS,
    });
    if (res.status === 204) return null;
    if (res.status !== 200) {
      throw this.toHubError(res, "Poll failed");
    }
    await this.ackDeliveredMessages(token, res.data.messages);
    return res.data;
  }

  async inbox(token: string): Promise<PollResponse> {
    const res = await this.request<PollResponse>({
      method: "GET",
      path: "/inbox",
      token,
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Inbox fetch failed");
    }
    await this.ackDeliveredMessages(token, res.data.messages);
    return res.data;
  }

  private async ackDeliveredMessages(token: string, messages: Message[]): Promise<void> {
    const deliveryIds = messages.map((message) => message.deliveryId).filter((id): id is string => Boolean(id));
    if (deliveryIds.length === 0) return;
    const res = await this.request<{ ok: boolean }>({
      method: "POST",
      path: "/ack",
      token,
      body: { deliveryIds },
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Ack failed");
    }
  }

  async users(token: string): Promise<HubUser[]> {
    const res = await this.request<UsersResponse>({
      method: "GET",
      path: "/users",
      token,
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Failed to get users");
    }
    return res.data.users;
  }

  async listChannels(token: string): Promise<ChannelSummary[]> {
    const res = await this.request<{ channels: ChannelSummary[] }>({
      method: "GET",
      path: "/channels",
      token,
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Failed to list channels");
    }
    return res.data.channels;
  }

  async createChannel(token: string, name: string): Promise<{ channel: string }> {
    const res = await this.request<{ ok: boolean; channel: string }>({
      method: "POST",
      path: "/channel-create",
      token,
      body: { name },
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Failed to create channel");
    }
    return { channel: res.data.channel };
  }

  async joinChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-join",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Failed to join channel");
    }
  }

  async leaveChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-leave",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Failed to leave channel");
    }
  }

  async inviteToChannel(token: string, channel: string, user: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-invite",
      token,
      body: { channel, user },
    });
    if (res.status !== 200) {
      throw this.toHubError(res, "Failed to invite user to channel");
    }
  }
}
