import { describe, expect, it } from "vitest";
import { parseProjectEnvMode, resolveLaunchDefaults } from "../src/project-settings.js";
import type { ProjectShell, ServerSettings } from "../src/types.js";

const project: ProjectShell = { id: "p", title: "p", workspaceRoot: "/repo", defaultModelSelection: null, defaultThreadEnvMode: "worktree" };
const settings: ServerSettings = { defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: true, projectSettingsFolded: true, projectSettingsOverrides: {} };

describe("T3 launch defaults", () => {
  it.each([
    ["local", "worktree", "local"], ["worktree", "local", "worktree"],
    [null, "worktree", "worktree"], [null, "local", "local"], [null, null, "local"],
  ] as const)("environment %s, file %s resolves to %s", async (global, file, expected) => {
    expect((await resolveLaunchDefaults({ ...settings, defaultThreadEnvMode: global }, project, async () => file)).envMode).toBe(expected);
  });
  it.each(["local", "worktree", null] as const)("project override %s beats the environment", async (override) => {
    const result = await resolveLaunchDefaults({ ...settings, projectSettingsOverrides: { p: { defaultThreadEnvMode: override, newWorktreesStartFromOrigin: false } } }, project, async () => "worktree");
    expect(result).toEqual({ envMode: override ?? "worktree", startFromOrigin: false });
  });
  it("uses legacy project mode only before T3 folded it into settings", async () => {
    expect((await resolveLaunchDefaults({ ...settings, projectSettingsFolded: false }, project, async () => null)).envMode).toBe("worktree");
    expect((await resolveLaunchDefaults(settings, project, async () => null)).envMode).toBe("local");
  });
  it("does not read the project file when the settings tiers decide", async () => {
    expect((await resolveLaunchDefaults(settings, project, async () => { throw Error("unused"); })).envMode).toBe("local");
  });
  it("fails a settings contract change instead of guessing local", async () => {
    await expect(resolveLaunchDefaults({ ...settings, defaultThreadEnvMode: undefined } as unknown as ServerSettings, project, async () => null)).rejects.toThrow(/contract changed/);
  });
});

describe("T3 project-file defaults", () => {
  it("accepts T3's comments and trailing commas without stripping quoted URLs", () => {
    expect(parseProjectEnvMode('{ // comment\n "defaultThreadEnvMode":"worktree", "scripts":[{"name":"setup","command":"echo https://x/*test*/",},], /* c */ }')).toBe("worktree");
  });
  it.each(['{}', '{broken', '{"defaultThreadEnvMode":"invalid"}', '{"defaultThreadEnvMode":"worktree","scripts":[{"name":"bad"}]}', 'null', '{"defaultThreadEnvMode":"worktree","worktreeSubmodules":"bad"}'])('invalid or unset file %s falls back', (file) => {
    expect(parseProjectEnvMode(file)).toBeNull();
  });
});
