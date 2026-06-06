import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigRow } from "../db.js";

const mocks = vi.hoisted(() => ({
  dbListAgentConfigs: vi.fn(),
  execFile: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: mocks.writeFileSync,
}));

vi.mock("../db.js", () => ({
  dbListAgentConfigs: mocks.dbListAgentConfigs,
}));

const { autoLaunchAgents, launchAgent } = await import("../launcher.js");

function agentConfig(overrides: Partial<AgentConfigRow> = {}): AgentConfigRow {
  return {
    id: "agent-1",
    name: "alice",
    work_dir: "/tmp",
    command: "",
    auto_start: 1,
    env_vars: null,
    created_at: Date.now(),
    ...overrides,
  };
}

describe("launchAgent", () => {
  beforeEach(() => {
    mocks.dbListAgentConfigs.mockReset();
    mocks.execFile.mockReset();
    mocks.writeFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a timeout to osascript", async () => {
    mocks.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(null));

    await launchAgent(agentConfig());

    expect(mocks.execFile).toHaveBeenCalledWith(
      "osascript",
      expect.any(Array),
      { timeout: 30_000 },
      expect.any(Function),
    );
  });

  it("rejects cleanly when the launch script cannot be written", async () => {
    mocks.writeFileSync.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(launchAgent(agentConfig())).rejects.toThrow("Failed to create launch script: disk full");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe("autoLaunchAgents", () => {
  beforeEach(() => {
    mocks.dbListAgentConfigs.mockReset();
    mocks.execFile.mockReset();
    mocks.writeFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs launch failures from the auto-launch chain", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.dbListAgentConfigs.mockReturnValue([agentConfig()]);
    mocks.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(new Error("osascript stalled")));

    autoLaunchAgents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleSpy).toHaveBeenCalledWith("[auto-launch] Failed: Failed to open iTerm2: osascript stalled");
  });
});
