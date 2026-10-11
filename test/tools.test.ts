import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { commandIds } from "../src/ids.js";
import type { T3Api } from "../src/t3.js";
import { registerTools } from "../src/tools.js";
import type { Provider, ShellSnapshot, ThreadDetailSnapshot, ThreadShell, VcsListRefsResult } from "../src/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

/** Capture tool handlers straight off McpServer so no transport is needed. */
function harness(api: Partial<T3Api>) {
  const server = new McpServer({ name: "test", version: "0" });
  const handlers = new Map<string, Handler>();
  const original = server.registerTool.bind(server);
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, meta: unknown, cb: Handler) => {
    handlers.set(name, cb);
    return original(name, meta as never, cb as never);
  };
  registerTools(server, { api: api as T3Api, origin: "http://t3", environmentId: "env-9" });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await handlers.get(name)!(args);
    const text = result.content.map((c) => c.text).join("");
    return result.isError ? { error: text } : JSON.parse(text);
  };
}

const provider: Provider = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "claude-opus-5", name: "Opus" }],
};

const threadShell = (id: string, latestTurn: ThreadShell["latestTurn"]): ThreadShell => ({
  id,
  projectId: "p1",
  title: "t",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn,
  updatedAt: "",
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const detail = (shell: ThreadShell, messages: ThreadDetailSnapshot["thread"]["messages"] = []): ThreadDetailSnapshot => {
  const { hasPendingApprovals: _a, hasPendingUserInput: _b, hasActionableProposedPlan: _c, ...rest } = shell;
  return { snapshotSequence: 1, thread: { ...rest, messages } };
};

const shell = (threads: ThreadShell[]): ShellSnapshot => ({
  snapshotSequence: 1,
  projects: [{ id: "p1", title: "proj", workspaceRoot: "C:\\code\\proj", defaultModelSelection: null }],
  threads,
});

const refs: VcsListRefsResult = {
  isRepo: true,
  nextCursor: null,
  refs: [
    { name: "main", current: true, isDefault: true, worktreePath: "c:/code/proj" },
    { name: "feat", current: false, isDefault: false, worktreePath: "C:\\code\\proj-feat" },
  ],
};

const base = (key: string) => ({ project: "p1", harness: "claudeAgent", model: "claude-opus-5", title: "T", prompt: "go", idempotencyKey: key });

describe("t3_create_thread", () => {
  it("creates with bootstrap and reports the web url", async () => {
    const calls: unknown[] = [];
    const ids = commandIds("launch", "k1");
    const call = harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
      createThreadWithFirstTurn: async (spec) => {
        calls.push(spec);
        return { sequence: 1 };
      },
      thread: async () => detail(threadShell(ids.threadId, null)),
    });
    const result = await call("t3_create_thread", base("k1"));
    expect(result.reused).toBe(false);
    expect(result.url).toBe(`http://t3/env-9/${ids.threadId}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ threadId: ids.threadId, commandId: ids.commandId, branch: "main", worktreePath: null });
  });

  it("does not bypass an unfinished worktree bootstrap on retry", async () => {
    const ids = commandIds("launch", "k2");
    const started: unknown[] = [];
    const call = harness({
      shell: async () => shell([threadShell(ids.threadId, null)]),
      config: async () => ({ providers: [provider] }),
      startTurn: async (spec) => {
        started.push(spec);
        return { sequence: 2 };
      },
      createThreadWithFirstTurn: async () => {
        throw new Error("must not re-bootstrap");
      },
      thread: async () => detail(threadShell(ids.threadId, null)),
    });
    const result = await call("t3_create_thread", { ...base("k2"), newWorktree: { baseBranch: "main", branch: "feature/new" } });
    expect(result.reused).toBe(true);
    expect(started).toHaveLength(0);
  });

  it("reuses a launched thread without dispatching anything, and honours wait", async () => {
    const ids = commandIds("launch", "k3");
    const turn = { turnId: "T", state: "completed", startedAt: "2026-01-01T00:00:01.000Z", completedAt: null, assistantMessageId: "a1" };
    const call = harness({
      shell: async () => shell([threadShell(ids.threadId, turn)]),
      config: async () => ({ providers: [provider] }),
      startTurn: async () => {
        throw new Error("must not dispatch");
      },
      createThreadWithFirstTurn: async () => {
        throw new Error("must not dispatch");
      },
      thread: async () => detail(threadShell(ids.threadId, turn)),
      listRefs: async () => refs,
      waitForTurnSettled: async () => ({
        snapshot: detail(threadShell(ids.threadId, turn), [
          { id: "a1", role: "assistant", text: "PONG", turnId: "T", streaming: false, createdAt: "" },
        ]),
        timedOut: false,
      }),
    });
    const result = await call("t3_create_thread", { ...base("k3"), wait: true });
    expect(result.reused).toBe(true);
    expect(result.reply.text).toBe("PONG");
  });

  it("rejects both worktreePath and newWorktree, and an unknown baseBranch", async () => {
    const call = harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [provider] }),
      listRefs: async () => refs,
    });
    expect((await call("t3_create_thread", { ...base("k4"), worktreePath: "x", newWorktree: { baseBranch: "main" } })).error).toMatch(/not both/);
    expect((await call("t3_create_thread", { ...base("k4"), newWorktree: { baseBranch: "nope" } })).error).toMatch(/not a local branch/);
  });
});

describe("t3_send_message", () => {
  it("sends mid-turn (steering) while a turn is running, and a retry of an already-sent message does not dispatch again", async () => {
    const running = { turnId: "R", state: "running", startedAt: "", completedAt: null, assistantMessageId: null };
    const ids = commandIds("t1", "step");
    const dispatched: string[] = [];
    const call = harness({
      thread: async () => detail(threadShell("t1", running), [{ id: ids.messageId, role: "user", text: "x", turnId: "R", streaming: false, createdAt: "" }]),
      startTurn: async (spec) => {
        dispatched.push(spec.messageId);
      },
    });
    const steer = await call("t3_send_message", { threadId: "t1", prompt: "p", idempotencyKey: "other" });
    expect(steer.error).toBeUndefined();
    expect(steer.reused).toBe(false);
    expect(dispatched).toEqual([commandIds("t1", "other").messageId]);
    const retry = await call("t3_send_message", { threadId: "t1", prompt: "p", idempotencyKey: "step" });
    expect(retry.reused).toBe(true);
    expect(dispatched).toHaveLength(1);
  });
});

describe("t3_list_harnesses", () => {
  it("hides unusable harnesses by default and explains them when asked", async () => {
    const signedOut: Provider = { ...provider, instanceId: "codex", driver: "codex", auth: { status: "unauthenticated" } };
    const call = harness({ config: async () => ({ providers: [provider, signedOut] }) });
    expect((await call("t3_list_harnesses")).map((h: { harnessId: string }) => h.harnessId)).toEqual(["claudeAgent"]);
    const all = await call("t3_list_harnesses", { includeUnusable: true });
    expect(all[1]).toMatchObject({ harnessId: "codex", usable: false, reason: expect.stringMatching(/signed in/) });
  });
});

describe("t3_list_worktrees", () => {
  it("does not list the project root twice when paths differ only by case or slashes", async () => {
    const call = harness({ shell: async () => shell([]), listRefs: async () => refs });
    const result = await call("t3_list_worktrees", { project: "proj" });
    expect(result.worktrees.map((w: { worktreePath: string }) => w.worktreePath)).toEqual(["C:\\code\\proj", "C:\\code\\proj-feat"]);
  });
});


describe("bridge model defaults", () => {
  const opus = {
    slug: "claude-opus-5-5", name: "Claude Opus 5.5",
    capabilities: { optionDescriptors: [{ id: "effort", type: "select", options: [{ id: "medium" }, { id: "high" }] }] },
  };

  it("uses Opus 5.5 medium when harness and model are omitted", async () => {
    let selection;
    const call = harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [{ ...provider, models: [opus] }] }),
      listRefs: async () => refs,
      createThreadWithFirstTurn: async (spec) => {
        selection = spec.modelSelection;
        return { sequence: 1 };
      },
      thread: async () => detail(threadShell("t", null)),
    });
    const result = await call("t3_create_thread", { project: "p1", title: "T", prompt: "go", idempotencyKey: "default" });
    expect(result.error).toBeUndefined();
    expect(selection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] });
  });

  it("honours an explicit effort and rejects an unsupported one before launch", async () => {
    const selections: unknown[] = [];
    const call = harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [{ ...provider, models: [opus] }] }),
      listRefs: async () => refs,
      createThreadWithFirstTurn: async (spec) => {
        selections.push(spec.modelSelection);
        return { sequence: 1 };
      },
      thread: async () => detail(threadShell("t", null)),
    });
    const args = { project: "p1", title: "T", prompt: "go", idempotencyKey: "effort" };
    expect((await call("t3_create_thread", { ...args, effort: "high" })).error).toBeUndefined();
    expect(selections).toEqual([{ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] }]);
    expect((await call("t3_create_thread", { ...args, effort: "not-supported" })).error).toMatch(/not offered/);
    expect(selections).toHaveLength(1);
  });

  it("requires an explicit model for a non-default harness", async () => {
    const call = harness({
      shell: async () => shell([]),
      config: async () => ({ providers: [{ ...provider, instanceId: "codex", driver: "codex" }] }),
      createThreadWithFirstTurn: async () => { throw new Error("must not launch"); },
    });
    const result = await call("t3_create_thread", { project: "p1", harness: "codex", title: "T", prompt: "go", idempotencyKey: "other" });
    expect(result.error).toMatch(/explicit model/);
  });
});

describe("thread settlement", () => {
  it("reads the accepted command's state and scopes settle and unsettle retry keys separately", async () => {
    const calls: unknown[] = [];
    let settled = false;
    let reads = 0;
    const call = harness({
      setThreadSettled: async (...args) => {
        calls.push(args);
        settled = args[2];
        reads = 0;
        return { sequence: 2 };
      },
      thread: async () => ({
        snapshotSequence: ++reads === 1 ? 1 : 2,
        thread: { ...detail(threadShell("t1", null)).thread, settledAt: settled ? "2026-10-11T00:00:00Z" : null, settledOverride: settled ? "settled" : "active" },
      }),
    });
    const args = { threadId: "t1", idempotencyKey: "state" };
    expect((await call("t3_settle_thread", args)).settled).toBe(true);
    expect((await call("t3_unsettle_thread", args)).settled).toBe(false);
    expect(calls).toEqual([
      [commandIds("t3_settle_thread:t1", "state").commandId, "t1", true],
      [commandIds("t3_unsettle_thread:t1", "state").commandId, "t1", false],
    ]);
  });

  it("leaves a running thread alone when T3 rejects settlement", async () => {
    const call = harness({
      setThreadSettled: async () => { throw new Error("Thread is running"); },
      interruptTurn: async () => { throw new Error("must not interrupt"); },
    });
    expect((await call("t3_settle_thread", { threadId: "busy", idempotencyKey: "settle-busy" })).error).toBe("Thread is running");
  });
});
