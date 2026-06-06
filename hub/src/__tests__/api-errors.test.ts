import {
  codeForStatus,
  HubError,
  type HubErrorBody,
  isHubErrorBody,
  isRetryable,
  statusForCode,
} from "@walkie-talkie/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// launchAgent is mocked to throw so /admin-agent-start produces a real 500,
// letting us prove the generic-error guarantee end to end.
const LEAKY_INTERNAL = "ENOENT: spawn /secret/internal/path failed at sqlite3_step";
vi.mock("../launcher.js", () => ({
  launchAgent: vi.fn(() => {
    throw new Error(LEAKY_INTERNAL);
  }),
  autoLaunchAgents: vi.fn(),
}));

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

interface ErrorBodyWire extends HubErrorBody {
  error: string;
}

describe("error taxonomy (contract)", () => {
  it("maps HTTP status to code and back", () => {
    expect(codeForStatus(401)).toBe("UNAUTHENTICATED");
    expect(codeForStatus(400)).toBe("BAD_REQUEST");
    expect(codeForStatus(500)).toBe("INTERNAL");
    expect(codeForStatus(418)).toBe("INTERNAL"); // unknown -> INTERNAL
    expect(statusForCode("UNAUTHENTICATED")).toBe(401);
    expect(statusForCode("RECIPIENT_NOT_FOUND")).toBe(404);
    expect(statusForCode("HUB_UNREACHABLE")).toBe(503);
  });

  it("marks only transient codes retryable", () => {
    expect(isRetryable("HUB_UNREACHABLE")).toBe(true);
    expect(isRetryable("INTERNAL")).toBe(true);
    expect(isRetryable("UNAUTHENTICATED")).toBe(false);
    expect(isRetryable("BAD_REQUEST")).toBe(false);
  });

  it("round-trips through toBody/fromBody", () => {
    const err = new HubError("BAD_REQUEST", "nope");
    const body = err.toBody();
    expect(body).toEqual({ code: "BAD_REQUEST", message: "nope", retryable: false });
    const restored = HubError.fromBody(body, 400);
    expect(restored).toBeInstanceOf(HubError);
    expect(restored.code).toBe("BAD_REQUEST");
    expect(restored.status).toBe(400);
  });

  it("identifies error bodies via the type guard", () => {
    expect(isHubErrorBody({ code: "INTERNAL", message: "x", retryable: true })).toBe(true);
    expect(isHubErrorBody({ error: "x" })).toBe(false);
    expect(isHubErrorBody(null)).toBe(false);
  });
});

describe("error wire shape", () => {
  it("401 carries code UNAUTHENTICATED and legacy error field", async () => {
    const res = await fetch(`${ctx.baseUrl}/poll`, { headers: { Authorization: "Bearer bogus" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBodyWire;
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(body.retryable).toBe(false);
    expect(body.error).toBeDefined(); // backward compat for slack-bot/dashboard
    expect(body.message).toBeDefined();
  });

  it("400 invalid JSON carries code BAD_REQUEST", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBodyWire;
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("send to unknown recipient carries code RECIPIENT_NOT_FOUND", async () => {
    const token = await registerUser(ctx, "alice");
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: "@ghost", content: "hi" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBodyWire;
    expect(body.code).toBe("RECIPIENT_NOT_FOUND");
  });
});

describe("internal errors never leak internals", () => {
  it("500 from a thrown launcher returns a generic body with code INTERNAL", async () => {
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.adminToken}`,
    };
    const created = await fetch(`${ctx.baseUrl}/admin-agent-config-create`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "leaky-agent", workDir: "/tmp" }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const res = await fetch(`${ctx.baseUrl}/admin-agent-start`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ id }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBodyWire;
    expect(body.code).toBe("INTERNAL");
    expect(body.retryable).toBe(true);

    // The raw internal error must not reach the caller through any field.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("ENOENT");
    expect(serialized).not.toContain("/secret/internal/path");
    expect(serialized).not.toContain("sqlite3_step");
  });
});
