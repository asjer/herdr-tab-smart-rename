import { test } from "bun:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type PaneContext,
  type NameSuggestion,
} from "../src/domain.ts";
import { AiProviderError } from "../src/provider.ts";
import {
  type HerdrPane,
  type HerdrSnapshot,
} from "../src/herdr.ts";
import {
  AutoNameService,
  focusedPaneFor,
  type ServiceDependencies,
} from "../src/service.ts";
import {
  loadState,
  statePaths,
  withStateTransaction,
} from "../src/storage.ts";

function liveSnapshot(tabLabel = "1"): HerdrSnapshot {
  return {
    focused_workspace_id: "w1",
    focused_tab_id: "t1",
    focused_pane_id: "p1",
    workspaces: [
      {
        workspace_id: "w1",
        label: "Agents",
        number: 1,
        active_tab_id: "t1",
      },
    ],
    tabs: [
      {
        tab_id: "t1",
        workspace_id: "w1",
        label: tabLabel,
        number: 1,
      },
    ],
    panes: [
      {
        pane_id: "p1",
        tab_id: "t1",
        workspace_id: "w1",
        cwd: "/tmp/agents",
        agent: "pi",
      },
    ],
    layouts: [{ tab_id: "t1", focused_pane_id: "p1" }],
  };
}

function contextFor(
  pane: HerdrPane,
  {
    command = "node --test",
    userMessages = [],
  }: { command?: string; userMessages?: string[] } = {},
): PaneContext {
  return {
    focused: true,
    label: pane.label ?? "",
    process: { name: "node", command, cwd: pane.cwd ?? "" },
    recentOutput: "",
    userMessages,
  };
}

function dependencies(
  current: () => HerdrSnapshot,
  overrides: Partial<ServiceDependencies> = {},
): Partial<ServiceDependencies> {
  return {
    snapshot: async () => current(),
    focusedPaneContext: async (pane) => contextFor(pane),
    siblingPaneContext: async (pane) => ({
      ...contextFor(pane),
      focused: false,
      recentOutput: "",
      userMessages: [],
    }),
    rename: async () => {},
    ...overrides,
  };
}

test("working agents outrank focused supporting commands", () => {
  const snap = liveSnapshot();
  snap.layouts[0]!.focused_pane_id = "server";
  snap.panes[0]!.agent_status = "working";
  snap.panes.push({
    pane_id: "server",
    tab_id: "t1",
    workspace_id: "w1",
    agent_status: "unknown",
  });
  assert.equal(focusedPaneFor(snap.tabs[0]!, snap)?.pane_id, "p1");
});

test("state transactions serialize concurrent writers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-state-"));
  const paths = statePaths(dir);
  try {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withStateTransaction(paths.state, paths.stateLock, (state) => {
          state.count = (typeof state.count === "number" ? state.count : 0) + 1;
        }),
      ),
    );
    assert.equal((await loadState(paths.state)).count, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all-tab dry run visits tabs sequentially without writing state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-dry-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot();
  delete snap.panes[0]!.agent;
  snap.tabs.push({ tab_id: "t2", workspace_id: "w1", label: "2", number: 2 });
  snap.panes.push({ pane_id: "p2", tab_id: "t2", workspace_id: "w1" });
  snap.layouts.push({ tab_id: "t2", focused_pane_id: "p2" });
  const visits: string[] = [];
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    dryRun: true,
    namer: { suggest: async () => unexpectedModel() },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) => {
        visits.push(pane.pane_id);
        return contextFor(pane);
      },
      rename: async () => {
        throw new Error("unexpected rename");
      },
    }),
  });
  try {
    const results = await service.evaluateAll(snap);
    assert.deepEqual(visits, ["p1", "p2"]);
    assert.deepEqual(results.map((result) => result.candidate.tab), [
      "Run Tests",
      "Run Tests",
    ]);
    await assert.rejects(access(paths.state));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi session names take priority over model-generated tab names", async () => {
  const snap = liveSnapshot();
  let modelCalls = 0;
  const service = new AutoNameService({
    dryRun: true,
    namer: {
      suggest: async () => {
        modelCalls += 1;
        return { tab: "Generated Tab Name", reason: "model" };
      },
    },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) => ({
        ...contextFor(pane, { userMessages: ["Please organize my downloads"] }),
        sessionMessages: {
          name: "Downloads ordenen en grote bestanden vinden",
          origin: ["Please organize my downloads"],
          middle: [],
          recent: [],
        },
      }),
    }),
  });

  const result = await service.evaluate("t1", { snapshot: snap });
  assert.ok(result);
  assert.equal(result.candidate.tab, "Downloads ordenen en grote");
  assert.equal(result.reason, "Pi session name");
  assert.equal(modelCalls, 0);
});

test("Pi tabs wait for the first user prompt before naming", async () => {
  const snap = liveSnapshot();
  let modelCalls = 0;
  const service = new AutoNameService({
    dryRun: true,
    namer: {
      suggest: async () => {
        modelCalls += 1;
        return { tab: "View NPM Package Info", reason: "startup output" };
      },
    },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) => ({
        ...contextFor(pane, { command: "pi" }),
        recentOutput: "View NPM package info",
      }),
    }),
  });

  const result = await service.evaluate("t1", { snapshot: snap });
  assert.ok(result);
  assert.equal(result.candidate.tab, null);
  assert.equal(result.reason, "waiting for first Pi user prompt");
  assert.equal(modelCalls, 0);
});

test("manual ownership short-circuits context and model work", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-manual-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("Manual Task");
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: { suggest: async () => unexpectedModel() },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async () => {
        throw new Error("unexpected context read");
      },
    }),
  });
  try {
    await service.initialize(snap);
    const result = await service.evaluate("t1", { snapshot: snap });
    assert.ok(result);
    assert.equal(result.reason, "manual ownership");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AI is hard-disabled by default even for explicit refresh", async () => {
  const snap = liveSnapshot();
  let modelCalls = 0;
  const service = new AutoNameService({
    dryRun: true,
    namer: {
      suggest: async () => {
        modelCalls += 1;
        return { tab: "Generated Task Name", reason: "model" };
      },
    },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) =>
        contextFor(pane, {
          command: "zsh",
          userMessages: ["Give this ambiguous task a name"],
        }),
    }),
  });
  const result = await service.evaluate("t1", {
    snapshot: snap,
    forceRefresh: true,
  });
  assert.ok(result);
  assert.equal(result.reason, "AI disabled");
  assert.equal(result.usedModel, false);
  assert.equal(modelCalls, 0);
});

test("explicit refresh reclaims manual tabs and bypasses model gates when AI opted in", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-force-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot("Manual Task");
  let calls = 0;
  const activity: string[] = [];
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    aiEnabled: true,
    namer: {
      suggest: async () => {
        calls += 1;
        return { tab: "Fresh Task Name", reason: "current task" };
      },
    },
    modelActivity: async (tab) => {
      activity.push(`start:${tab.label}`);
      return async () => {
        activity.push("stop");
      };
    },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) =>
        contextFor(pane, { userMessages: ["Give this tab a fresh name"] }),
      rename: async (kind, id, label) => {
        if (kind === "tab" && id === "t1") snap.tabs[0]!.label = label;
      },
    }),
  });
  try {
    await service.initialize(snap);
    const first = await service.evaluate("t1", {
      resetKind: "tab",
      forceRefresh: true,
    });
    assert.ok(first);
    await service.acknowledge("tab", "t1", "Fresh Task Name");
    const gated = await service.evaluate("t1");
    assert.ok(gated);
    assert.equal(gated.reason, "unchanged or rate-limited context");
    const forced = await service.evaluate("t1", { forceRefresh: true });
    assert.ok(forced);
    assert.equal(forced.usedModel, true);
    assert.equal(calls, 2);
    assert.deepEqual(activity, [
      "start:Manual Task",
      "stop",
      "start:Fresh Task Name",
      "stop",
    ]);
    assert.equal((await loadState(paths.state)).tabs.t1?.manual, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent evaluations keep expected writes durable and avoid stale races", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-race-"));
  const paths = statePaths(dir);
  let label = "1";
  const current = () => {
    const snap = liveSnapshot(label);
    delete snap.panes[0]!.agent;
    return snap;
  };
  let sawExpected = false;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    namer: { suggest: async () => unexpectedModel() },
    dependencies: dependencies(current, {
      rename: async (kind, id, next) => {
        if (kind !== "tab" || id !== "t1") return;
        const state = await loadState(paths.state);
        sawExpected ||= state.tabs[id]?.expectedLabel === next;
        label = next;
      },
    }),
  });
  try {
    await service.initialize(current());
    await Promise.all([service.evaluate("t1"), service.evaluate("t1")]);
    const record = (await loadState(paths.state)).tabs.t1;
    assert.equal(sawExpected, true);
    assert.equal(record?.manual, false);
    assert.equal(record?.autoLabel, "Run Tests");
    assert.equal(record?.expectedLabel, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider failures open a persisted AI-only cooldown without worker failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-failure-"));
  const paths = statePaths(dir);
  const snap = liveSnapshot();
  let stopped = false;
  let calls = 0;
  let now = 1_000_000;
  const service = new AutoNameService({
    stateFile: paths.state,
    stateLock: paths.stateLock,
    aiEnabled: true,
    now: () => now,
    namer: {
      suggest: async () => {
        calls += 1;
        throw new AiProviderError("quota", "AI request failed (quota): sk-provider-secret raw response");
      },
    },
    modelActivity: async () => async () => {
      stopped = true;
    },
    dependencies: dependencies(() => snap, {
      focusedPaneContext: async (pane) =>
        contextFor(pane, { userMessages: ["Build automatic tab naming"] }),
    }),
  });
  try {
    await service.initialize(snap);
    const failed = await service.evaluate("t1");
    assert.ok(failed);
    assert.equal(failed.reason, "AI unavailable (quota)");
    assert.equal(stopped, true);
    let state = await loadState(paths.state);
    assert.equal(typeof state.modelAttempts.t1, "number");
    assert.equal(state.fingerprints.t1, undefined);
    assert.equal(state.aiCircuit?.category, "quota");
    assert.doesNotMatch(await readFile(paths.state, "utf8"), /provider-secret|raw response/);

    stopped = false;
    const cooling = await service.evaluate("t1", { forceRefresh: true });
    assert.ok(cooling);
    assert.equal(cooling.reason, "AI cooling down (quota)");
    assert.equal(calls, 1);
    assert.equal(stopped, false);

    now = state.aiCircuit!.retryAt;
    await service.evaluate("t1", { forceRefresh: true });
    assert.equal(calls, 2);
    state = await loadState(paths.state);
    assert.equal(state.aiCircuit?.failures, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function unexpectedModel(): NameSuggestion {
  throw new Error("unexpected model call");
}
