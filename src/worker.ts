#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { type Socket } from "node:net";
import {
  snapshot,
  subscribe,
  tabProgressBase,
  type HerdrEvent,
} from "./herdr.ts";
import { createService } from "./service.ts";
import {
  ensurePrivateDir,
  runtimeStateDir,
  statePaths,
  WorkerShutdownOwnership,
  writeWorkerInfo,
} from "./storage.ts";
import { createWorkerLogger } from "./worker-log.ts";
import {
  CoalescingScheduler,
  ReconnectController,
  WorkerShutdown,
} from "./worker-runtime.ts";

export const SWEEP_INTERVAL_MS = 60_000;
const workerScript = fileURLToPath(import.meta.url);

export function shouldIgnoreProgressRename(
  progressBases: Map<string, string>,
  tabId: string,
  label: string,
): boolean {
  const progressBase = tabProgressBase(label);
  if (progressBase !== null) {
    progressBases.set(tabId, progressBase);
    return true;
  }
  const restoring = progressBases.get(tabId);
  progressBases.delete(tabId);
  return restoring === label;
}

export async function runWorker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const stateRoot = env.HERDR_PLUGIN_STATE_DIR;
  if (!stateRoot) throw new Error("HERDR_PLUGIN_STATE_DIR is required");
  const socketPath = env.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH is required");

  const stateDir = runtimeStateDir(stateRoot, socketPath);
  await ensurePrivateDir(stateDir);
  const paths = statePaths(stateDir);
  const logger = createWorkerLogger({ file: paths.log, archive: paths.logArchive });
  const service = createService({ stateDir, env });
  const shutdownOwnership = new WorkerShutdownOwnership({
    startLock: paths.startLock,
    pidFile: paths.pid,
    pid: process.pid,
    script: workerScript,
  });

  // Initialization is the child-side readiness check.
  await service.initialize();

  let socket: Socket | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const progressBases = new Map<string, string>();
  let lifecycle: WorkerShutdown;
  let connect: () => void;
  const reconnect = new ReconnectController({ connect: () => connect() });

  const scheduler = new CoalescingScheduler({
    scan: async () => (await snapshot(env)).tabs.map((tab) => tab.tab_id),
    evaluate: async (tabId) => {
      const result = await service.evaluate(tabId);
      if (result?.changes.length) {
        await logger.log(`renamed ${JSON.stringify(result.changes)}`);
      }
    },
    acknowledge: (item) => service.acknowledge(item.kind, item.id, item.label),
    onError: (error) => logger.log(`task deferred: ${errorMessage(error)}`),
    onFatal: (error) => lifecycle.fatal(error),
  });

  const stopResources = async (): Promise<void> => {
    await shutdownOwnership.begin();
    stopped = true;
    reconnect.stop();
    if (sweepTimer) clearInterval(sweepTimer);
    socket?.destroy();
    socket = null;
    await scheduler.stop();
  };

  lifecycle = new WorkerShutdown({
    logger,
    stopResources,
    removeOwnership: () => shutdownOwnership.finish(),
    exit: (code) => process.exit(code),
  });

  const handleEvent = (event: HerdrEvent): void => {
    reconnect.validEvent();
    if (event.type === "workspace_renamed" && event.workspace_id && event.label) {
      scheduler.requestAcknowledgement({
        kind: "workspace",
        id: event.workspace_id,
        label: event.label,
      });
      return;
    }
    if (event.type === "tab_renamed" && event.tab_id && event.label) {
      if (shouldIgnoreProgressRename(progressBases, event.tab_id, event.label)) return;
      scheduler.requestAcknowledgement({ kind: "tab", id: event.tab_id, label: event.label });
      return;
    }
    if (event.type === "tab_closed") {
      if (event.tab_id) progressBases.delete(event.tab_id);
      return;
    }
    if (event.type === "workspace_closed") return;

    const directTabId = event.tab_id || event.tab?.tab_id || event.pane?.tab_id;
    if (directTabId) scheduler.requestTab(directTabId);
    else scheduler.requestRescan();
  };

  connect = (): void => {
    if (stopped) return;
    const connection = subscribe(
      socketPath,
      handleEvent,
      (error) => {
        if (error.fatal) {
          reconnect.stop();
          void lifecycle.fatal(error);
        }
        else void logger.log(`socket response error: ${error.message}`);
      },
    );
    socket = connection;
    connection.on("error", (error) => {
      void logger.log(`socket error: ${errorMessage(error)}`);
    });
    connection.on("close", () => {
      if (socket !== connection || stopped) return;
      socket = null;
      reconnect.closed();
    });
  };

  process.once("SIGTERM", () => void lifecycle.signal("SIGTERM"));
  process.once("SIGINT", () => void lifecycle.signal("SIGINT"));
  process.once("uncaughtException", (error) => void lifecycle.fatal(error));
  process.once("unhandledRejection", (error) => void lifecycle.fatal(error));

  // Publish readiness only after lifecycle handlers and cleanup are armed.
  await writeWorkerInfo(paths.pid, {
    pid: process.pid,
    script: workerScript,
    startedAt: new Date().toISOString(),
  });
  await logger.log(`started pid=${process.pid}`);
  scheduler.requestRescan();
  sweepTimer = setInterval(() => scheduler.requestRescan(), SWEEP_INTERVAL_MS);
  connect();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await runWorker();
