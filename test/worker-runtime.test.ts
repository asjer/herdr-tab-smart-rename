import { test } from "bun:test";
import assert from "node:assert/strict";
import { HerdrRuntimeError } from "../src/failure.ts";
import {
  CoalescingScheduler,
  ReconnectController,
  reconnectDelay,
  WorkerShutdown,
} from "../src/worker-runtime.ts";

test("reconnect backoff grows with jitter bounds and a hard cap", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((attempt) => reconnectDelay(attempt, () => 1)),
    [1_000, 2_000, 4_000, 8_000],
  );
  assert.equal(reconnectDelay(30, () => 1), 60_000);
  assert.equal(reconnectDelay(3, () => 0), 4_000);
});

test("coalescing scheduler bounds event bursts and retains latest acknowledgement", async () => {
  const evaluated: string[] = [];
  const acknowledgements: string[] = [];
  const scheduler = new CoalescingScheduler({
    scan: async () => [],
    evaluate: async (tabId) => {
      evaluated.push(tabId);
    },
    acknowledge: async (item) => {
      acknowledgements.push(`${item.id}:${item.label}`);
    },
    onError: () => {},
    onFatal: () => {},
  });

  for (let index = 0; index < 1_000; index += 1) scheduler.requestTab("t1");
  scheduler.requestAcknowledgement({ kind: "tab", id: "t1", label: "Old" });
  scheduler.requestAcknowledgement({ kind: "tab", id: "t1", label: "Latest" });
  assert.deepEqual(scheduler.pendingCounts(), {
    tabs: 1,
    acknowledgements: 1,
    rescan: false,
  });
  await scheduler.drainForTest();
  assert.deepEqual(evaluated, ["t1"]);
  assert.deepEqual(acknowledgements, ["t1:Latest"]);
  await scheduler.stop();
});

test("sweep requested during work adds at most one follow-up drain", async () => {
  let scans = 0;
  let evaluations = 0;
  let scheduler: CoalescingScheduler;
  scheduler = new CoalescingScheduler({
    scan: async () => {
      scans += 1;
      return ["t1"];
    },
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) scheduler.requestRescan();
    },
    acknowledge: async () => {},
    onError: () => {},
    onFatal: () => {},
  });
  scheduler.requestRescan();
  await scheduler.drainForTest();
  assert.equal(scans, 2);
  assert.equal(evaluations, 2);
  await scheduler.stop();
});

test("transient work retains one rescan while fatal work stops", async () => {
  let errors = 0;
  const transient = new CoalescingScheduler({
    scan: async () => {
      throw new Error("ECONNREFUSED");
    },
    evaluate: async () => {},
    acknowledge: async () => {},
    onError: () => {
      errors += 1;
    },
    onFatal: () => {
      throw new Error("unexpected fatal");
    },
  });
  transient.requestRescan();
  await transient.drainForTest();
  assert.equal(errors, 1);
  assert.equal(transient.pendingCounts().rescan, true);
  await transient.stop();

  let fatals = 0;
  const fatal = new CoalescingScheduler({
    scan: async () => {
      throw new HerdrRuntimeError("protocol_mismatch", "protocol_mismatch");
    },
    evaluate: async () => {},
    acknowledge: async () => {},
    onError: () => {},
    onFatal: () => {
      fatals += 1;
    },
  });
  fatal.requestRescan();
  await fatal.drainForTest();
  assert.equal(fatals, 1);
  fatal.requestRescan();
  await fatal.drainForTest();
  assert.equal(fatals, 1);
});

test("failed in-flight acknowledgement preserves newer value and different-key suffix", async () => {
  let rejectOld!: (error: Error) => void;
  const oldAttempt = new Promise<void>((_, reject) => { rejectOld = reject; });
  const seen: string[] = [];
  const scheduler = new CoalescingScheduler({
    scan: async () => [],
    evaluate: async () => {},
    acknowledge: async (item) => {
      seen.push(item.label);
      if (item.label === "Old") await oldAttempt;
    },
    onError: () => {},
    onFatal: () => {},
  });
  scheduler.requestAcknowledgement({ kind: "tab", id: "t1", label: "Old" });
  scheduler.requestAcknowledgement({ kind: "tab", id: "t2", label: "Second key" });
  const draining = scheduler.drainForTest();
  await Bun.sleep(0);
  scheduler.requestAcknowledgement({ kind: "tab", id: "t1", label: "Latest" });
  rejectOld(new Error("ECONNRESET"));
  await draining;
  await scheduler.drainForTest();
  assert.deepEqual(seen, ["Old", "Latest", "Second key"]);
  await scheduler.stop();
});

test("ack suffix merge never exceeds cap and collapses overflow to one rescan", async () => {
  let rejectFirst!: (error: Error) => void;
  const firstAttempt = new Promise<void>((_, reject) => { rejectFirst = reject; });
  let scans = 0;
  const scheduler = new CoalescingScheduler({
    maxPending: 3,
    scan: async () => { scans += 1; return []; },
    evaluate: async () => {},
    acknowledge: async (item) => {
      if (item.id === "suffix-1") await firstAttempt;
    },
    onError: () => {},
    onFatal: () => {},
  });
  for (const id of ["suffix-1", "suffix-2", "suffix-3"]) {
    scheduler.requestAcknowledgement({ kind: "tab", id, label: id });
  }
  const draining = scheduler.drainForTest();
  await Bun.sleep(0);
  for (const id of ["new-1", "new-2", "new-3"]) {
    scheduler.requestAcknowledgement({ kind: "tab", id, label: id });
  }
  rejectFirst(new Error("ECONNRESET"));
  await draining;

  const pending = scheduler.pendingCounts();
  assert.ok(pending.acknowledgements <= 3);
  assert.deepEqual(pending, { tabs: 0, acknowledgements: 0, rescan: true });
  assert.equal(scans, 0);
  await scheduler.drainForTest();
  assert.equal(scans, 1);
  assert.deepEqual(scheduler.pendingCounts(), {
    tabs: 0,
    acknowledgements: 0,
    rescan: false,
  });
  await scheduler.stop();
});

test("transient tab failure preserves the current and remaining dirty batch", async () => {
  const seen: string[] = [];
  let failed = false;
  const scheduler = new CoalescingScheduler({
    scan: async () => [],
    evaluate: async (tabId) => {
      seen.push(tabId);
      if (!failed) {
        failed = true;
        throw new Error("ECONNRESET");
      }
    },
    acknowledge: async () => {},
    onError: () => {},
    onFatal: () => {},
  });
  scheduler.requestTab("a");
  scheduler.requestTab("b");
  await scheduler.drainForTest();
  assert.deepEqual(scheduler.pendingCounts(), { tabs: 2, acknowledgements: 0, rescan: false });
  await scheduler.drainForTest();
  assert.deepEqual(seen, ["a", "a", "b"]);
  await scheduler.stop();
});

test("scheduler cardinality overflow collapses to one rescan", () => {
  const scheduler = new CoalescingScheduler({
    scan: async () => [], evaluate: async () => {}, acknowledge: async () => {},
    onError: () => {}, onFatal: () => {}, maxPending: 3,
  });
  for (const id of ["a", "b", "c", "d"]) scheduler.requestTab(id);
  assert.deepEqual(scheduler.pendingCounts(), { tabs: 0, acknowledgements: 0, rescan: true });
  for (const id of ["a", "b", "c", "d"]) {
    scheduler.requestAcknowledgement({ kind: "tab", id, label: id });
  }
  assert.equal(scheduler.pendingCounts().rescan, true);
  assert.ok(scheduler.pendingCounts().acknowledgements <= 3);
});

test("reconnect controller coalesces close, resets only on valid event, and stops fatally", () => {
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  let connects = 0;
  const controller = new ReconnectController({
    connect: () => { connects += 1; },
    random: () => 1,
    setTimer: ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
      (timer as unknown as { cleared: boolean }).cleared = true;
    }) as typeof clearTimeout,
  });
  controller.closed();
  controller.closed(); // error+close/duplicate close still means one timer
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 1_000);
  timers[0]!.callback();
  assert.equal(connects, 1);
  controller.closed();
  assert.equal(timers[1]!.delay, 2_000); // connect alone did not reset
  timers[1]!.callback();
  controller.validEvent();
  controller.closed();
  assert.equal(timers[2]!.delay, 1_000);
  controller.stop();
  assert.equal(timers[2]!.cleared, true);
  timers[2]!.callback();
  assert.equal(connects, 2);
});

test("fatal shutdown logs once, removes exact ownership, and exits nonzero", async () => {
  const messages: string[] = [];
  let stopped = 0;
  let removed = 0;
  const exits: number[] = [];
  const shutdown = new WorkerShutdown({
    logger: {
      log: async (message) => {
        messages.push(message);
      },
      flush: async () => {},
    },
    stopResources: async () => {
      stopped += 1;
    },
    removeOwnership: async () => {
      removed += 1;
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  const failure = new HerdrRuntimeError("protocol_mismatch", "protocol_mismatch");
  await Promise.all([shutdown.fatal(failure), shutdown.fatal(failure)]);
  assert.equal(stopped, 1);
  assert.equal(removed, 1);
  assert.deepEqual(exits, [1]);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /fatal protocol_mismatch/);
});

test("shutdown guarantees exit before deadline when cleanup hangs or rejects", async () => {
  const never = new Promise<void>(() => {});
  const trace: string[] = [];
  const shutdown = new WorkerShutdown({
    deadlineMs: 25,
    logger: {
      log: async () => { trace.push("log"); throw new Error("disk failed"); },
      flush: async () => { trace.push("flush"); },
    },
    stopResources: () => never,
    removeOwnership: async () => { trace.push("remove"); throw new Error("remove failed"); },
    exit: (code) => { trace.push(`exit:${code}`); },
  });
  const started = Date.now();
  await Promise.all([shutdown.signal("SIGTERM"), shutdown.signal("SIGTERM")]);
  assert.ok(Date.now() - started < 500);
  assert.equal(trace.includes("remove"), false);
  assert.deepEqual(trace.filter((item) => item.startsWith("exit:")), ["exit:0"]);
});
