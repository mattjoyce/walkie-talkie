import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("POST /register", () => {
  it("should register a new user and return a token", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-alice" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-alice");
    expect(body.token).toBeTruthy();
  });

  it("should reject duplicate registration", async () => {
    await registerUser(ctx, "reg-dup");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-dup" }),
    });
    expect(res.status).toBe(409);
  });

  it("should allow reconnect with old token", async () => {
    const token = await registerUser(ctx, "reg-reconnect");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-reconnect", oldToken: token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-reconnect");
    // New token should be different
    expect(body.token).toBeTruthy();
  });

  it("should preserve channel memberships during old-token reconnect", async () => {
    const token = await registerUser(ctx, "reg-reconnect-channel");
    await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "reconnect-room" }),
    });

    const reconnectRes = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-reconnect-channel", oldToken: token }),
    });
    expect(reconnectRes.status).toBe(200);

    const channelsRes = await fetch(`${ctx.baseUrl}/channels`);
    const channelsBody = (await channelsRes.json()) as {
      channels: { name: string; members: string[] }[];
    };
    const room = channelsBody.channels.find((channel) => channel.name === "#reconnect-room");
    expect(room?.members).toContain("reg-reconnect-channel");
  });

  it("should reject reconnect with wrong old token", async () => {
    await registerUser(ctx, "reg-wrongtoken");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-wrongtoken", oldToken: "wrong" }),
    });
    expect(res.status).toBe(409);
  });

  it("should reject missing name", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /unregister", () => {
  it("should unregister an authenticated user", async () => {
    const token = await registerUser(ctx, "reg-unreg");
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    // Should no longer appear in users list
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const usersBody = (await usersRes.json()) as { users: { name: string }[] };
    expect(usersBody.users.map((u) => u.name)).not.toContain("reg-unreg");
  });

  it("should reject unregister without token", async () => {
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

describe("liveness reporting", () => {
  it("should expose last-seen user state in /health", async () => {
    const token = await registerUser(ctx, "reg-health");
    const res = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const healthRes = await fetch(`${ctx.baseUrl}/health`);
    const health = (await healthRes.json()) as {
      users: { name: string; online: boolean; lastSeenAt: number | null; stale: boolean }[];
    };
    const user = health.users.find((u) => u.name === "reg-health");
    expect(user).toBeDefined();
    expect(user!.online).toBe(true);
    expect(user!.lastSeenAt).toEqual(expect.any(Number));
    expect(user!.stale).toBe(false);
  });
});
