import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("authentication", () => {
  it("should reject /register without join token", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject /send without user token", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@all", content: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject /kick without admin token", async () => {
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject wrong method on /register", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.joinToken}` },
    });
    expect(res.status).toBe(405);
  });

  it("should reject wrong method on /send", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });

  it("should reject wrong method on /kick", async () => {
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });

  it("should return 404 for unknown paths", async () => {
    const res = await fetch(`${ctx.baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it("should allow public access to /users", async () => {
    const res = await fetch(`${ctx.baseUrl}/users`);
    expect(res.status).toBe(200);
  });

  it("should allow public access to /channels", async () => {
    const res = await fetch(`${ctx.baseUrl}/channels`);
    expect(res.status).toBe(200);
  });

  it("should allow public access to /health", async () => {
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; db: { ok: boolean }; users: unknown[]; agents: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(Array.isArray(body.users)).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
  });
});

describe("request hardening", () => {
  it("sets request and header timeouts", () => {
    expect(ctx.server.requestTimeout).toBe(30_000);
    expect(ctx.server.headersTimeout).toBe(10_000);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: "{",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON", code: "BAD_REQUEST" });
  });

  it("returns 413 for oversized request bodies", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "x".repeat(8 * 1024 * 1024) }),
    });

    expect(res.status).toBe(413);
  });
});

describe("dashboard session authentication", () => {
  it("does not embed the master admin token in dashboard HTML", async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(ctx.adminToken);
    expect(html).toContain("/dashboard-login");
  });

  it("issues a dashboard session token for the correct admin token", async () => {
    const res = await fetch(`${ctx.baseUrl}/dashboard-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ctx.adminToken }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(ctx.adminToken);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const adminRes = await fetch(`${ctx.baseUrl}/admin-unread-counts`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(adminRes.status).toBe(200);
  });

  it("rejects dashboard login with the wrong token", async () => {
    const res = await fetch(`${ctx.baseUrl}/dashboard-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });

    expect(res.status).toBe(401);
  });
});
