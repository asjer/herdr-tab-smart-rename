import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  acknowledgeRename,
  aiCircuitAllows,
  buildModelContext,
  emptyState,
  heuristicTitle,
  isDefaultLabel,
  markAiFailure,
  markModelAttempt,
  markModelSuccess,
  observeStableContext,
  prepareRename,
  reconcileItem,
  resetOwnership,
  sessionTabLabel,
  shouldCallModel,
  validateTabLabel,
  workspaceCandidate,
  MAX_CONTEXT_CHARS,
  MODEL_RATE_MS,
  type NamingContext,
} from "../src/domain.ts";
import { sanitizeText } from "../src/text.ts";

test("ownership transitions preserve manual names and expected writes", () => {
  assert.equal(isDefaultLabel("12", 12), true);
  assert.equal(reconcileItem(undefined, "3", true).manual, false);
  assert.deepEqual(
    reconcileItem(
      { manual: true, autoLabel: "Old Automatic Name", observedLabel: "Old Automatic Name" },
      "1",
      true,
    ),
    { manual: false, observedLabel: "1" },
  );
  assert.equal(reconcileItem(undefined, "Manual Task", false).manual, true);
  assert.equal(
    reconcileItem({ autoLabel: "Build API" }, "Manual Name").manual,
    true,
  );
  const prepared = prepareRename({}, "Fix Socket Reconnect");
  assert.deepEqual(acknowledgeRename(prepared, "Fix Socket Reconnect"), {
    autoLabel: "Fix Socket Reconnect",
    manual: false,
    observedLabel: "Fix Socket Reconnect",
  });
  assert.equal(acknowledgeRename(prepared, "My Name").manual, true);
  assert.deepEqual(resetOwnership({ manual: true, autoLabel: "Old" }), {
    manual: false,
  });
});

test("label, workspace, and process policy stays deterministic", () => {
  for (const [label, valid] of [
    ["Fix Socket Reconnect", true],
    ["Optimize VAR for Explainers", true],
    ["fix socket", false],
    ["One", false],
    ["This Label Has Far Too Many Words", false],
    ["Fix\nSocket", false],
  ] as const) {
    assert.equal(validateTabLabel(label), valid, label);
  }
  assert.equal(
    workspaceCandidate({ label: "var", number: 1 }, { cwd: "/code/other" }, "/code/other"),
    "VAR",
  );
  for (const [command, title] of [
    ["npm run dev", "Dev Server"],
    ["pytest -q", "Run Tests"],
    ["bun test", "Run Tests"],
    ["docker logs -f api", "View Logs"],
    ["ssh host", "Remote Shell"],
    ["zsh", null],
  ] as const) {
    assert.equal(heuristicTitle({ focusedPane: { process: { command } } }), title);
  }
});

test("worktree Pi session names become readable tab labels", () => {
  assert.equal(sessionTabLabel("wt:harden-smart-rename"), "harden smart rename");
  assert.equal(sessionTabLabel("WT:Rails-Replatform"), "Rails Replatform");
  assert.equal(sessionTabLabel("regular-session-name"), "regular-session-name");
  assert.equal(sessionTabLabel("wt:---"), null);
});

test("model context keeps weighted session evidence under the hard cap", () => {
  const huge = "x".repeat(20_000);
  const context = buildModelContext({
    workspaceName: huge,
    paneContexts: [
      {
        focused: true,
        label: "1",
        process: { name: huge, command: huge, cwd: huge },
        recentOutput: huge,
        sessionMessages: {
          origin: [huge],
          middle: [huge],
          recent: Array.from({ length: 4 }, () => huge),
        },
        userMessages: Array.from({ length: 6 }, () => huge),
      },
    ],
  });
  assert.ok(JSON.stringify(context).length <= MAX_CONTEXT_CHARS);
  assert.ok("sessionTimeline" in context);
  assert.deepEqual(Object.keys(context.sessionTimeline), ["origin", "middle", "recent"]);
  assert.equal("currentTab" in context, false);
});

test("text sanitization delegates ANSI and secret removal to libraries", () => {
  const input = [
    "\u001b[31msecret\u001b[0m",
    "Authorization: Bearer abc.def.ghi",
    'OPENAI_API_KEY="sk-abcdefghijklmnop"',
    "AWS_SECRET_ACCESS_KEY=verysecret",
    "https://user:password@example.com/path",
    "github_pat_abcdefghijklmnop",
    `sk-kimi-${"*".repeat(32)}tPJd`,
  ].join(" ");
  const output = sanitizeText(input, "");
  assert.doesNotMatch(
    output,
    /\u001b|abc\.def|verysecret|password@example|abcdefghijklmnop|tPJd/,
  );
  assert.match(output, /redacted/i);
});

test("provider circuit persists category-specific cooldowns", () => {
  const state = emptyState();
  const hour = 60 * 60 * 1_000;
  for (const category of ["config", "auth", "quota"] as const) {
    const isolated = emptyState();
    markAiFailure(isolated, category, 10);
    assert.equal(isolated.aiCircuit?.retryAt, 10 + 6 * hour);
  }
  const invalid = emptyState();
  markAiFailure(invalid, "invalid-response", 10);
  assert.equal(invalid.aiCircuit?.retryAt, 10 + hour);
  const transient = emptyState();
  const delays: number[] = [];
  for (let count = 0; count < 5; count += 1) {
    markAiFailure(transient, "timeout", 10);
    delays.push(transient.aiCircuit!.retryAt - 10);
  }
  assert.deepEqual(delays, [5, 10, 20, 30, 30].map((minutes) => minutes * 60_000));
  assert.equal(aiCircuitAllows(state, 1_000), true);
  markAiFailure(state, "network", 1_000);
  assert.equal(state.aiCircuit?.category, "network");
  assert.equal(state.aiCircuit?.failures, 1);
  assert.equal(aiCircuitAllows(state, 1_001), false);
  assert.equal(aiCircuitAllows(state, state.aiCircuit!.retryAt), true);

  markAiFailure(state, "network", 2_000);
  assert.equal(state.aiCircuit?.failures, 2);
  const networkDelay = state.aiCircuit!.retryAt - 2_000;
  markAiFailure(state, "quota", 3_000);
  assert.equal(state.aiCircuit?.category, "quota");
  assert.equal(state.aiCircuit?.failures, 1);
  assert.ok(state.aiCircuit!.retryAt - 3_000 > networkDelay);
});

test("stable fingerprints and model cooldown suppress churn", () => {
  const state = emptyState();
  const context: NamingContext = {
    project: "Agents",
    userRequests: ["inspect logs"],
  };
  assert.equal(observeStableContext(state, "t1", context), false);
  assert.equal(observeStableContext(state, "t1", context), true);
  assert.equal(shouldCallModel(state, "t1", context, 1_000_000).allowed, true);
  markModelAttempt(state, "t1", 1_000_000);
  assert.equal(shouldCallModel(state, "t1", context, 1_000_001).allowed, false);
  assert.equal(
    shouldCallModel(state, "t1", context, 1_000_000 + MODEL_RATE_MS + 1).allowed,
    true,
  );
  markAiFailure(state, "network", 1_000_000);
  markModelSuccess(state, "t1", context);
  assert.equal(state.aiCircuit, undefined);
  assert.equal(
    shouldCallModel(state, "t1", context, 1_000_000 + MODEL_RATE_MS * 2).allowed,
    false,
  );
});
