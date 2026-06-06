import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("POST /send", () => {
  it("should send a broadcast message", async () => {
    const aliceToken = await registerUser(ctx, "msg-alice");
    await registerUser(ctx, "msg-bob");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ to: "@all", content: "hello everyone" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.to).toBe("@all");
    expect(body.id).toBeTruthy();
  });

  it("should send a DM", async () => {
    const aliceToken = await registerUser(ctx, "dm-alice");
    await registerUser(ctx, "dm-bob");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ to: "@dm-bob", content: "hi bob" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.to).toBe("dm-bob");
  });

  it("should redeliver inbox messages until acknowledged", async () => {
    const aliceToken = await registerUser(ctx, "ack-alice");
    const bobToken = await registerUser(ctx, "ack-bob");

    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ to: "@ack-bob", content: "ack me" }),
    });
    expect(sendRes.status).toBe(200);

    const firstInbox = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    const firstBody = (await firstInbox.json()) as { messages: { content: string; deliveryId?: string }[] };
    expect(firstBody.messages).toHaveLength(1);
    expect(firstBody.messages[0].content).toBe("ack me");
    expect(firstBody.messages[0].deliveryId).toBeTruthy();

    const secondInbox = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    const secondBody = (await secondInbox.json()) as { messages: { content: string; deliveryId?: string }[] };
    expect(secondBody.messages).toHaveLength(1);

    const ackRes = await fetch(`${ctx.baseUrl}/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bobToken}`,
      },
      body: JSON.stringify({ deliveryIds: [firstBody.messages[0].deliveryId] }),
    });
    expect(ackRes.status).toBe(200);

    const finalInbox = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    const finalBody = (await finalInbox.json()) as { messages: unknown[] };
    expect(finalBody.messages).toEqual([]);
  });

  it("should handle TYPING indicator", async () => {
    const token = await registerUser(ctx, "typing-user");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: "@all", content: "TYPING", channel: "#general" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("typing");
  });

  it("should reject missing fields", async () => {
    const token = await registerUser(ctx, "send-bad");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: "@all" }), // missing content
    });
    expect(res.status).toBe(400);
  });

  it("should return 404 when target user not found", async () => {
    const token = await registerUser(ctx, "send-nouser");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: "@ghost", content: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  it("should send a message with image", async () => {
    const token = await registerUser(ctx, "img-sender");
    await registerUser(ctx, "img-receiver");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: "@all",
        content: "check this image",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; to: string };
    expect(body.id).toBeTruthy();
  });

  it("should reject invalid image payloads", async () => {
    const token = await registerUser(ctx, "img-invalid-sender");
    await registerUser(ctx, "img-invalid-receiver");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: "@all",
        image: { data: "iVBORw0KGgo=", mimeType: "text/plain" },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Image mimeType must start with image/",
      code: "BAD_REQUEST",
    });
  });

  it("should reject oversized images before routing", async () => {
    const token = await registerUser(ctx, "img-large-sender");
    await registerUser(ctx, "img-large-receiver");
    const tooLargeImage = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: "@all",
        image: { data: tooLargeImage, mimeType: "image/png" },
      }),
    });

    expect(res.status).toBe(413);
  });

  it("should accept image-only message without content", async () => {
    const token = await registerUser(ctx, "imgonly-sender");
    await registerUser(ctx, "imgonly-receiver");

    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: "@all",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject unauthorized send", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@all", content: "hi" }),
    });
    expect(res.status).toBe(401);
  });
});
