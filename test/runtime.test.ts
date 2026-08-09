import { test } from "bun:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentResultNotice, dispatch, startWorker } from "../src/cli.ts";
import { type RenameResult } from "../src/domain.ts";
import {
  acquireLock,
  commandForPid,
  inspectWorker,
  pidAlive,
  removeOwnedWorkerPid,
  runtimeStateDir,
  workerInfo,
  WorkerShutdownOwnership,
  writeWorkerInfo,
  type WorkerInfo,
} from "../src/storage.ts";
import { shouldIgnoreProgressRename } from "../src/worker.ts";
import { WorkerShutdown } from "../src/worker-runtime.ts";

test("CLI dispatch routes actions without executing on import", async () => {
  const calls: Array<[string, { dryRun: boolean }]> = [];
  const actions = {
    status: (options: { dryRun: boolean }) => calls.push(["status", options]),
    once: (options: { dryRun: boolean }) => calls.push(["once", options]),
  };
  await dispatch("status", { actions });
  await dispatch("once", { actions, dryRun: true });
  assert.deepEqual(calls, [
    ["status", { dryRun: false }],
    ["once", { dryRun: true }],
  ]);
  await assert.rejects(dispatch("unknown", { actions }), /^Error: usage:/);

  const progress = new Map<string, string>();
  assert.equal(
    shouldIgnoreProgressRename(progress, "t1", "\u2063◆ Review Auth"),
    true,
  );
  assert.equal(shouldIgnoreProgressRename(progress, "t1", "Review Auth"), true);
  assert.equal(shouldIgnoreProgressRename(progress, "t1", "Manual Name"), false);

  const result: RenameResult = {
    dryRun: false,
    workspace: "w1",
    tab: "t1",
    candidate: { workspace: null, tab: null },
    reason: "no meaningful task",
    usedModel: true,
    ownership: { workspaceManual: false, tabManual: false },
    changes: [],
  };
  assert.deepEqual(currentResultNotice(result), {
    title: "Tab not renamed",
    body: "No meaningful task found",
    sound: "request",
  });
  assert.deepEqual(
    currentResultNotice({
      ...result,
      candidate: { workspace: null, tab: "Review Auth Changes" },
      reason: "current task",
    }),
    {
      title: "Tab not renamed",
      body: "Already named Review Auth Changes",
      sound: "request",
    },
  );
  assert.deepEqual(
    currentResultNotice({
      ...result,
      candidate: { workspace: null, tab: "Review Auth Changes" },
      reason: "current task",
      changes: [
        { kind: "tab", id: "t1", from: "1", to: "Review Auth Changes" },
      ],
    }),
    {
      title: "Tab renamed",
      body: "1 -> Review Auth Changes",
      sound: "done",
    },
  );
});

test("Bun launcher survives Herdr's minimal server PATH", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-bun-"));
  const bunDir = path.join(home, ".bun", "bin");
  const fakeBun = path.join(bunDir, "bun");
  try {
    await mkdir(bunDir, { recursive: true });
    await writeFile(fakeBun, "#!/bin/sh\nprintf 'fake-bun:%s\\n' \"$*\"\n");
    await chmod(fakeBun, 0o700);
    const child = Bun.spawn(
      [
        "/bin/sh",
        path.resolve(import.meta.dir, "../src/run-bun.sh"),
        "src/cli.ts",
        "status",
      ],
      {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.trim(), "fake-bun:src/cli.ts status");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("secret wrapper requires explicit AI opt-in, not merely provider config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-ai-gate-"));
  const bunDir = path.join(home, ".bun", "bin");
  const configDir = path.join(home, "config");
  const fakeBun = path.join(bunDir, "bun");
  const wrapper = path.join(configDir, "run-with-1password.sh");
  const launcher = path.resolve(import.meta.dir, "../src/run-bun.sh");
  try {
    await mkdir(bunDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(fakeBun, "#!/bin/sh\nprintf 'bun:%s\\n' \"$*\"\n");
    await writeFile(wrapper, "#!/bin/sh\nprintf 'wrapper:%s\\n' \"$*\"\n");
    await chmod(fakeBun, 0o700);
    await chmod(wrapper, 0o700);

    await writeFile(path.join(configDir, "provider.env"), "SMART_RENAME_API_KEY=configured-key\n");
    let child = Bun.spawn(["/bin/sh", launcher, "src/cli.ts", "start"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", HERDR_PLUGIN_CONFIG_DIR: configDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    let [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.trim(), "bun:src/cli.ts start");

    await writeFile(
      path.join(configDir, "provider.env"),
      "SMART_RENAME_AI_ENABLED=true\nSMART_RENAME_API_KEY=configured-key\n",
    );
    child = Bun.spawn(["/bin/sh", launcher, "src/cli.ts", "start"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", HERDR_PLUGIN_CONFIG_DIR: configDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.trim(), "wrapper:start");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime state is isolated by Herdr socket", () => {
  const root = "/state/tab-smart-rename";
  const defaultSocket = "/config/herdr/herdr.sock";
  const namedSocket = "/config/herdr/sessions/devtools/herdr.sock";

  assert.equal(runtimeStateDir(root, undefined), root);
  assert.equal(
    runtimeStateDir(root, defaultSocket),
    runtimeStateDir(root, defaultSocket),
  );
  assert.notEqual(
    runtimeStateDir(root, defaultSocket),
    runtimeStateDir(root, namedSocket),
  );
  assert.match(
    runtimeStateDir(root, namedSocket),
    /^\/state\/tab-smart-rename\/sessions\/[a-f0-9]{16}$/,
  );
});

test("start preflight blocks spawn and duplicate starts remain singleton", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-start-"));
  const script = "/repo/src/worker.ts";
  let record: WorkerInfo | null = null;
  let spawns = 0;
  const common = {
    stateDir: dir,
    script,
    cwd: "/repo",
    env: {},
    dependencies: {
      inspect: async () => record
        ? { status: "running" as const, info: record }
        : { status: "missing" as const },
      removeOwned: async () => {
        record = null;
      },
      sleep: async () => {},
      terminate: () => {},
      spawn: () => {
        spawns += 1;
        return {
          pid: 42,
          unref: () => {
            record = { pid: 42, script, startedAt: "now" };
          },
        };
      },
    },
  };
  try {
    await assert.rejects(
      startWorker({
        ...common,
        dependencies: {
          ...common.dependencies,
          preflight: async () => {
            throw new Error("protocol_mismatch");
          },
        },
      }),
      /protocol_mismatch/,
    );
    assert.equal(spawns, 0);
    await assert.rejects(access(path.join(dir, "worker.json")));

    const dependencies = { ...common.dependencies, preflight: async () => {} };
    const [first, second] = await Promise.all([
      startWorker({ ...common, dependencies }),
      startWorker({ ...common, dependencies }),
    ]);
    assert.equal(spawns, 1);
    assert.deepEqual(
      [first.alreadyRunning, second.alreadyRunning].sort(),
      [false, true],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate start waits through a preflight longer than the former lock timeout", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-delayed-start-"));
  const script = "/repo/src/worker.ts";
  let record: WorkerInfo | null = null;
  let spawns = 0;
  const dependencies = {
    preflight: async () => { await Bun.sleep(2_050); },
    inspect: async () => record
      ? { status: "running" as const, info: record }
      : { status: "missing" as const },
    removeOwned: async () => {},
    sleep: async () => {},
    terminate: () => {},
    spawn: () => {
      spawns += 1;
      return { pid: 42, unref: () => { record = { pid: 42, script, startedAt: "now" }; } };
    },
  };
  try {
    const first = startWorker({ stateDir: dir, script, dependencies });
    await Bun.sleep(10);
    const second = startWorker({ stateDir: dir, script, dependencies });
    const results = await Promise.all([first, second]);
    assert.equal(spawns, 1);
    assert.deepEqual(results.map((item) => item.alreadyRunning).sort(), [false, true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent start cannot spawn until shutting-down worker is quiescent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-shutdown-start-"));
  const pidFile = path.join(dir, "worker.json");
  const startLock = path.join(dir, "start.lock");
  const script = "/repo/src/worker.ts";
  let releaseActive!: () => void;
  const activeWork = new Promise<void>((resolve) => { releaseActive = resolve; });
  let lockAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
  let oldActive = true;
  let spawns = 0;
  const exits: number[] = [];
  try {
    await writeWorkerInfo(pidFile, { pid: 41, script, startedAt: "old" });
    const ownership = new WorkerShutdownOwnership({
      startLock,
      pidFile,
      pid: 41,
      script,
    });
    const shutdown = new WorkerShutdown({
      logger: { log: async () => {}, flush: async () => {} },
      stopResources: async () => {
        await ownership.begin();
        lockAcquired();
        await activeWork;
        oldActive = false;
      },
      removeOwnership: () => ownership.finish(),
      exit: (code) => { exits.push(code); },
    });
    const stopping = shutdown.signal("SIGTERM");
    await acquired;

    const starting = startWorker({
      stateDir: dir,
      script,
      dependencies: {
        preflight: async () => {},
        inspect: (file, expected) => inspectWorker(file, expected, {
          isAlive: (pid) => pid === 41 ? oldActive : pid === 42,
          commandForPid: async (pid) => `bun ${pid === 41 ? script : script}`,
        }),
        removeOwned: removeOwnedWorkerPid,
        sleep: async () => { await Bun.sleep(1); },
        terminate: () => {},
        spawn: () => {
          assert.equal(oldActive, false, "replacement spawned before old worker quiesced");
          spawns += 1;
          return {
            pid: 42,
            unref: () => {
              void writeWorkerInfo(pidFile, { pid: 42, script, startedAt: "new" });
            },
          };
        },
      },
    });
    await Bun.sleep(25);
    assert.equal(spawns, 0);
    await access(pidFile);

    releaseActive();
    const [, started] = await Promise.all([stopping, starting]);
    assert.equal(spawns, 1);
    assert.equal(started.info.pid, 42);
    assert.deepEqual(exits, [0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed child readiness is terminated without a stale ownership record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-not-ready-"));
  const script = "/repo/src/worker.ts";
  let terminated = 0;
  try {
    await assert.rejects(
      startWorker({
        stateDir: dir,
        script,
        cwd: "/repo",
        env: {},
        dependencies: {
          preflight: async () => {},
          inspect: async () => ({ status: "missing" }),
          removeOwned: async () => {},
          sleep: async () => {},
          spawn: () => ({ pid: 42, unref: () => {} }),
          terminate: (pid) => {
            assert.equal(pid, 42);
            terminated += 1;
          },
        },
      }),
      /did not become ready/,
    );
    assert.equal(terminated, 1);
    await assert.rejects(access(path.join(dir, "worker.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker ownership cleanup requires exact pid and script", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-owner-"));
  const pidFile = path.join(dir, "worker.json");
  try {
    await writeWorkerInfo(pidFile, { pid: 42, script: "/repo/worker.ts", startedAt: "now" });
    await removeOwnedWorkerPid(pidFile, 42, "/other/worker.ts");
    await access(pidFile);
    await removeOwnedWorkerPid(pidFile, 43, "/repo/worker.ts");
    await access(pidFile);
    await removeOwnedWorkerPid(pidFile, 42, "/repo/worker.ts");
    await assert.rejects(access(pidFile));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PID command inspection has one deadline across a never-closing reader and reap", async () => {
  let kills = 0;
  const stdout = new ReadableStream<Uint8Array>({
    start() {
      // Deliberately never enqueue or close.
    },
  });
  const started = Date.now();
  await assert.rejects(
    commandForPid(42, {
      timeoutMs: 25,
      spawn: () => ({
        stdout,
        exited: new Promise<number>(() => {}),
        kill: () => { kills += 1; },
      }),
    }),
    /ps inspection timed out/,
  );
  assert.ok(Date.now() - started < 500);
  assert.equal(kills, 1);
});

test("live old-script and uncertain ps records are non-destructive conflicts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-conflict-"));
  const pidFile = path.join(dir, "worker.json");
  const oldScript = "/old/src/worker.ts";
  try {
    await writeWorkerInfo(pidFile, { pid: 42, script: oldScript, startedAt: "now" });
    let result = await inspectWorker(pidFile, "/new/src/worker.ts", {
      isAlive: () => true,
      commandForPid: async () => `bun ${oldScript}`,
    });
    assert.equal(result.status, "conflict");
    await access(pidFile);

    result = await inspectWorker(pidFile, oldScript, {
      isAlive: () => true,
      commandForPid: async () => { throw new Error("ps unavailable"); },
    });
    assert.equal(result.status, "conflict");
    assert.equal(JSON.parse(await readFile(pidFile, "utf8")).script, oldScript);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("start refuses a replacement record that appears during exact stale cleanup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-replace-"));
  const pidFile = path.join(dir, "worker.json");
  const script = "/repo/src/worker.ts";
  const replacement = { pid: 52, script: "/other/worker.ts", startedAt: "later" };
  let spawns = 0;
  try {
    await writeWorkerInfo(pidFile, { pid: 51, script, startedAt: "old" });
    await assert.rejects(startWorker({
      stateDir: dir,
      script,
      dependencies: {
        preflight: async () => {},
        inspect: (file, expected) => inspectWorker(file, expected, {
          isAlive: (pid) => pid === replacement.pid,
          commandForPid: async () => `bun ${replacement.script}`,
        }),
        removeOwned: async (file, pid, expected) => {
          await writeWorkerInfo(file, replacement);
          await removeOwnedWorkerPid(file, pid, expected);
        },
        spawn: () => { spawns += 1; return { pid: 99, unref: () => {} }; },
        sleep: async () => {},
        terminate: () => {},
      },
    }), /record changed/);
    assert.equal(spawns, 0);
    assert.deepEqual(JSON.parse(await readFile(pidFile, "utf8")), replacement);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live lock owners are never stolen solely due to age", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-live-lock-"));
  const lock = path.join(dir, "state.lock");
  try {
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, nonce: "live" })}\n`);
    await utimes(lock, new Date(0), new Date(0));
    await assert.rejects(
      acquireLock(lock, { timeoutMs: 30, retryMs: 5, staleMs: 1 }),
      /timed out waiting for lock/,
    );
    assert.equal(JSON.parse(await readFile(lock, "utf8")).nonce, "live");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("locks recover dead owners and workers require exact Bun scripts", async () => {
  assert.equal(pidAlive(42, () => true), true);
  assert.equal(
    pidAlive(42, () => {
      throw new Error("gone");
    }),
    false,
  );
  assert.equal(pidAlive(1, () => true), false);
  assert.equal(pidAlive(42, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }), true);

  const dir = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-runtime-"));
  const lock = path.join(dir, "state.lock");
  const pidFile = path.join(dir, "worker.json");
  const expected = "/repo/herdr-tab-smart-rename/src/worker.ts";
  try {
    await writeFile(lock, '{"pid":99999999,"nonce":"old"}\n');
    const release = await acquireLock(lock, { timeoutMs: 500 });
    await release();
    await assert.rejects(access(lock));

    await writeFile(
      pidFile,
      `${JSON.stringify({ pid: 42, script: expected, startedAt: "now" })}\n`,
    );
    const dependencies = {
      isAlive: () => true,
      commandForPid: async () => `bun ${expected}`,
    };
    assert.equal((await workerInfo(pidFile, expected, dependencies))?.pid, 42);
    await assert.rejects(
      workerInfo(pidFile, "/other/src/worker.ts", dependencies),
      /different script/,
    );
    await access(pidFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
