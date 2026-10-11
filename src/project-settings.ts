import { z } from "zod";
import type { ProjectShell, ServerSettings, ThreadEnvMode } from "./types.js";

// Mirrors the installed T3 0.0.45 project-file contract and lenient JSON parser.
const nonEmpty = z.string().min(1).transform((s) => s.trim()).pipe(z.string().min(1));
const projectFile = z.object({
  $schema: z.string().optional(),
  iconPath: z.string().min(1).max(512).transform((s) => s.trim()).pipe(z.string().min(1)).optional(),
  defaultThreadEnvMode: z.enum(["local", "worktree"]).optional(),
  worktreeSubmodules: z.enum(["recursive", "top-level", "none"]).optional(),
  scripts: z.array(z.object({
    name: nonEmpty, command: nonEmpty,
    icon: z.enum(["play", "test", "lint", "configure", "build", "debug"]).optional(),
    runOnWorktreeCreate: z.boolean().optional(), async: z.boolean().optional(),
    previewUrl: nonEmpty.optional(), autoOpenPreview: z.boolean().optional(),
  })).max(50).optional(),
});

export function parseProjectEnvMode(contents: string): ThreadEnvMode | null {
  try {
    let stripped = contents.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (match, literal) => literal ?? "");
    stripped = stripped.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g, (match, literal) => literal ?? "");
    stripped = stripped.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (match, literal, bracket) => literal ?? bracket ?? "");
    const parsed = projectFile.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data.defaultThreadEnvMode ?? null : null;
  } catch {
    return null;
  }
}

/** Same order as T3: stored project override, legacy project, environment, file, local. */
export async function resolveLaunchDefaults(settings: ServerSettings, project: ProjectShell, readFile: () => Promise<ThreadEnvMode | null>) {
  if (![null, "local", "worktree"].includes(settings.defaultThreadEnvMode) ||
      typeof settings.newWorktreesStartFromOrigin !== "boolean" || !settings.projectSettingsOverrides) {
    throw new Error("T3 settings contract changed; cannot resolve the project's worktree default.");
  }
  const overrides = settings.projectSettingsOverrides[project.id] ?? {};
  const mode = overrides.defaultThreadEnvMode !== undefined ? overrides.defaultThreadEnvMode :
    !settings.projectSettingsFolded && project.defaultThreadEnvMode != null ? project.defaultThreadEnvMode : settings.defaultThreadEnvMode;
  return {
    envMode: mode ?? await readFile() ?? "local",
    startFromOrigin: overrides.newWorktreesStartFromOrigin ?? settings.newWorktreesStartFromOrigin,
  };
}
