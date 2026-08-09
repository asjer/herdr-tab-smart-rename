#!/usr/bin/env bun
import path from "node:path";
import { type RenameResult } from "./domain.ts";
import { beginTabProgress, run, snapshot, snapshotPreflight } from "./herdr.ts";
import { aiEnabled, loadNamingPrompt, loadProviderConfig } from "./provider.ts";
import { createService } from "./service.ts";
import {
  acquireLock,
  ensurePrivateDir,
  inspectWorker,
  removeOwnedWorkerPid,
  runtimeStateDir,
  statePaths,
  workerInfo,
  type WorkerInfo,
  type WorkerInspection,
} from "./storage.ts";
import { sanitizeText } from "./text.ts";

const root = process.env.HERDR_PLUGIN_ROOT || path.resolve(import.meta.dir, "..");
const workerScript = path.join(root, "src", "worker.ts");

function requireStateDir(): string {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) {
    throw new Error(
      "HERDR_PLUGIN_STATE_DIR is required (Herdr sets it for plugin actions)",
    );
  }
  return runtimeStateDir(stateDir, process.env.HERDR_SOCKET_PATH);
}

async function notify(
  title: string,
  body = "",
  sound: "none" | "done" | "request" = "none",
): Promise<void> {
  const args = ["notification", "show", title];
  const safeBody = sanitizeText(body).slice(0, 120);
  if (safeBody) args.push("--body", safeBody);
  args.push("--position", "bottom-right", "--sound", sound);
  await run(process.env.HERDR_BIN_PATH || "herdr", args, {
    env: process.env,
    timeout: 3_000,
  }).catch(() => {});
}

export function currentResultNotice(result: RenameResult | null): {
  title: string;
  body: string;
  sound: "done" | "request";
} {
  const change = result?.changes.find((item) => item.kind === "tab");
  if (change) {
    return {
      title: "Tab renamed",
      body: `${change.from} -> ${change.to}`,
      sound: "done",
    };
  }
  if (!result) {
    return {
      title: "Tab not renamed",
      body: "No eligible tab",
      sound: "request",
    };
  }
  return {
    title: "Tab not renamed",
    body: result.candidate.tab
      ? `Already named ${result.candidate.tab}`
      : "No meaningful task found",
    sound: "request",
  };
}

interface SpawnedWorker {
  pid: number;
  unref(): void;
}

interface StartWorkerDependencies {
  preflight(env: NodeJS.ProcessEnv): Promise<void>;
  inspect(pidFile: string, script: string): Promise<WorkerInspection>;
  removeOwned(pidFile: string, pid: number, script: string): Promise<void>;
  spawn(script: string, cwd: string, env: NodeJS.ProcessEnv): SpawnedWorker;
  sleep(ms: number): Promise<void>;
  terminate(pid: number): void;
}

interface StartWorkerOptions {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  script?: string;
  cwd?: string;
  dependencies?: Partial<StartWorkerDependencies>;
}

const defaultStartDependencies: StartWorkerDependencies = {
  preflight: snapshotPreflight,
  inspect: inspectWorker,
  removeOwned: removeOwnedWorkerPid,
  spawn: (script, cwd, env) => {
    const child = Bun.spawn([process.execPath, script], {
      cwd,
      env,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return child;
  },
  sleep: Bun.sleep,
  terminate: (pid) => process.kill(pid, "SIGTERM"),
};

export async function startWorker({
  stateDir,
  env = process.env,
  script = workerScript,
  cwd = root,
  dependencies = {},
}: StartWorkerOptions): Promise<{ info: WorkerInfo; alreadyRunning: boolean }> {
  await ensurePrivateDir(stateDir);
  const paths = statePaths(stateDir);
  const deps = { ...defaultStartDependencies, ...dependencies };
  const release = await acquireLock(paths.startLock, {
    timeoutMs: 20_000,
    staleMs: 60_000,
  });
  try {
    let inspection = await deps.inspect(paths.pid, script);
    if (inspection.status === "running") {
      return { info: inspection.info, alreadyRunning: true };
    }
    if (inspection.status === "conflict") {
      throw new Error(`Smart Rename start refused: ${inspection.reason}`);
    }
    if (inspection.status === "stale") {
      await deps.removeOwned(paths.pid, inspection.info.pid, inspection.info.script);
      inspection = await deps.inspect(paths.pid, script);
      if (inspection.status !== "missing") {
        throw new Error("Smart Rename start refused: ownership record changed during stale cleanup");
      }
    }

    await deps.preflight(env);
    const child = deps.spawn(script, cwd, env);
    child.unref();
    let ready: WorkerInfo | null = null;
    try {
      for (let count = 0; count < 50; count += 1) {
        await deps.sleep(100);
        const current = await deps.inspect(paths.pid, script);
        if (current.status === "running" && current.info.pid === child.pid) {
          ready = current.info;
          break;
        }
        if (current.status === "conflict" ||
            (current.status === "running" && current.info.pid !== child.pid)) {
          throw new Error("Smart Rename start refused: conflicting worker record appeared");
        }
      }
      if (ready) return { info: ready, alreadyRunning: false };
      throw new Error("Smart Rename worker did not become ready");
    } finally {
      if (!ready) {
        try {
          deps.terminate(child.pid);
        } catch {
          // A child that failed startup may already be gone.
        }
        await deps.removeOwned(paths.pid, child.pid, script);
      }
    }
  } finally {
    await release();
  }
}

async function start(): Promise<void> {
  const result = await startWorker({ stateDir: requireStateDir() });
  console.log(
    result.alreadyRunning
      ? `Smart Rename already running (pid ${result.info.pid})`
      : `Smart Rename started (pid ${result.info.pid})`,
  );
}

async function stop(): Promise<void> {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  if (!info) {
    console.log("Smart Rename is not running");
    return;
  }
  process.kill(info.pid, "SIGTERM");
  for (let count = 0; count < 30; count += 1) {
    await Bun.sleep(100);
    if (!(await workerInfo(paths.pid, workerScript))) {
      console.log("Smart Rename stopped");
      return;
    }
  }
  throw new Error(`worker ${info.pid} did not stop`);
}

async function status(): Promise<void> {
  const paths = statePaths(requireStateDir());
  const info = await workerInfo(paths.pid, workerScript);
  const mode = aiEnabled(process.env) ? "AI enabled" : "AI disabled";
  if (!info) {
    console.log(`Smart Rename stopped (${mode})`);
    return;
  }
  console.log(`Smart Rename running (pid ${info.pid}, since ${info.startedAt}, ${mode})`);
}

async function renameAll(): Promise<RenameResult[]> {
  const stateDir = requireStateDir();
  await ensurePrivateDir(stateDir);
  const service = createService({ stateDir });
  const initial = await service.initialize();
  const results = await service.evaluateAll(initial, {
    resetKind: "tab",
    forceRefresh: true,
  });
  console.log(JSON.stringify(results, null, 2));
  return results;
}

interface OnceOptions {
  resetKind?: "workspace" | "tab" | null;
  forceRefresh?: boolean;
  dryRun?: boolean;
  progress?: boolean;
}

async function once({
  resetKind = null,
  forceRefresh = false,
  dryRun = false,
  progress = false,
}: OnceOptions = {}): Promise<RenameResult | null> {
  const current = await snapshot();
  const tabId = process.env.HERDR_TAB_ID || current.focused_tab_id;
  const workspaceId =
    process.env.HERDR_WORKSPACE_ID || current.focused_workspace_id;
  if (!tabId || !workspaceId) throw new Error("No current Herdr tab/workspace");

  const stateDir = dryRun
    ? process.env.HERDR_PLUGIN_STATE_DIR
    : requireStateDir();
  if (stateDir) await ensurePrivateDir(stateDir);
  const service = createService({
    ...(stateDir ? { stateDir } : {}),
    ...(progress ? { modelActivity: beginTabProgress } : {}),
    dryRun,
  });
  await service.initialize(current);
  const targetTab =
    resetKind === "workspace"
      ? current.workspaces.find((item) => item.workspace_id === workspaceId)
          ?.active_tab_id || tabId
      : tabId;
  const result = await service.evaluate(targetTab, {
    snapshot: current,
    resetKind,
    forceRefresh,
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function openConfigPane(entrypoint: string): Promise<void> {
  await run(
    process.env.HERDR_BIN_PATH || "herdr",
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      "tab-smart-rename",
      "--entrypoint",
      entrypoint,
      "--placement",
      "overlay",
    ],
    { env: process.env },
  );
}

async function configureAi(): Promise<void> {
  await openConfigPane("provider-config");
}

async function configurePrompt(): Promise<void> {
  await openConfigPane("prompt-config");
}

async function checkAi(): Promise<void> {
  if (!aiEnabled(process.env)) {
    const summary = "AI disabled; set SMART_RENAME_AI_ENABLED=1 to opt in";
    await notify("AI disabled", summary);
    console.log(summary);
    return;
  }
  try {
    const config = await loadProviderConfig(process.env);
    await loadNamingPrompt(config, process.env);
    const summary = `${config.provider}/${config.model}`;
    await notify("AI ready", summary);
    console.log(summary);
  } catch (error) {
    const message = errorMessage(error);
    await notify("Config missing", message, "request");
    throw error;
  }
}

async function renameNow(): Promise<void> {
  await notify("Renaming tab");
  const notice = currentResultNotice(
    await once({ resetKind: "tab", forceRefresh: true, progress: true }),
  );
  await notify(notice.title, notice.body, notice.sound);
}

async function renameEveryTab(): Promise<void> {
  await notify("Renaming tabs");
  const results = await renameAll();
  const renamed = results.reduce(
    (count, result) =>
      count + result.changes.filter((item) => item.kind === "tab").length,
    0,
  );
  await notify(
    renamed ? "Tabs renamed" : "No tabs renamed",
    `${renamed}/${results.length}`,
    renamed ? "done" : "request",
  );
}

interface DispatchOptions {
  dryRun?: boolean;
  actions?: Record<string, (options: { dryRun: boolean }) => unknown>;
}

const defaultActions: NonNullable<DispatchOptions["actions"]> = {
  start,
  stop,
  status,
  "configure-ai": configureAi,
  "configure-prompt": configurePrompt,
  "check-ai": checkAi,
  once: ({ dryRun }) => once({ dryRun }),
  "dry-run": () => once({ dryRun: true }),
  "rename-now": renameNow,
  all: renameEveryTab,
  "reset-tab": () => once({ resetKind: "tab", forceRefresh: true }),
  "reset-workspace": () =>
    once({ resetKind: "workspace", forceRefresh: true }),
};

export async function dispatch(
  command: string | undefined,
  { dryRun = false, actions = defaultActions }: DispatchOptions = {},
): Promise<unknown> {
  const action = command ? actions[command] : undefined;
  if (!action) {
    throw new Error(
      "usage: cli.ts start|stop|status|configure-ai|configure-prompt|check-ai|once [--dry-run]|dry-run|rename-now|all|reset-tab|reset-workspace",
    );
  }
  return action({ dryRun });
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  try {
    await dispatch(command, { dryRun: argv.includes("--dry-run") });
  } catch (error) {
    const message = errorMessage(error);
    if (command === "rename-now" || command === "all") {
      await notify("Rename failed", message, "request");
    }
    console.error(`Smart Rename: ${message}`);
    process.exitCode = 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await main();
