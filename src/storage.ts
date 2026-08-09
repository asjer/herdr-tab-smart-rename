import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { nonProviderSubprocessEnv } from "./subprocess-env.ts";
import {
  emptyState,
  type SmartRenameState,
} from "./domain.ts";

const OwnershipRecordSchema = z.object({
  manual: z.boolean().optional(),
  autoLabel: z.string().optional(),
  expectedLabel: z.string().optional(),
  observedLabel: z.string().optional(),
});

const AiCircuitSchema = z.object({
  category: z.enum(["config", "auth", "quota", "network", "timeout", "invalid-response", "unknown"]),
  failures: z.number().int().positive(),
  retryAt: z.number(),
});

const StateSchema: z.ZodType<SmartRenameState> = z.looseObject({
  version: z.literal(1),
  workspaces: z.record(z.string(), OwnershipRecordSchema),
  tabs: z.record(z.string(), OwnershipRecordSchema),
  modelAttempts: z.record(z.string(), z.number()),
  fingerprints: z.record(z.string(), z.string()),
  pendingFingerprints: z.record(z.string(), z.string()),
  aiCircuit: AiCircuitSchema.optional(),
});

const UnknownRecordSchema = z.record(z.string(), z.unknown());

const WorkerInfoSchema = z.object({
  pid: z.number().int().positive(),
  script: z.string().min(1),
  startedAt: z.string().min(1),
});

const LockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  nonce: z.string().min(1),
  createdAt: z.number().optional(),
});

export type WorkerInfo = z.infer<typeof WorkerInfoSchema>;

export interface StatePaths {
  state: string;
  pid: string;
  startLock: string;
  stateLock: string;
  log: string;
  logArchive: string;
}

export function runtimeStateDir(
  stateRoot: string,
  socketPath: string | undefined,
): string {
  if (!socketPath) return stateRoot;
  const socketId = createHash("sha256")
    .update(socketPath)
    .digest("hex")
    .slice(0, 16);
  return path.join(stateRoot, "sessions", socketId);
}

export function statePaths(stateDir: string): StatePaths {
  return {
    state: path.join(stateDir, "state.json"),
    pid: path.join(stateDir, "worker.json"),
    startLock: path.join(stateDir, "start.lock"),
    stateLock: path.join(stateDir, "state.lock"),
    log: path.join(stateDir, "worker.log"),
    logArchive: path.join(stateDir, "worker.log.1"),
  };
}

export async function ensurePrivateDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`refusing non-directory state path: ${directory}`);
  }
  await chmod(directory, 0o700);
}

export async function loadState(
  file: string | null | undefined,
): Promise<SmartRenameState> {
  if (!file) return emptyState();
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return StateSchema.parse({ ...emptyState(), ...asRecord(value) });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(
  file: string,
  state: SmartRenameState,
): Promise<void> {
  const validated = StateSchema.parse(state);
  await ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function withStateTransaction<T>(
  stateFile: string,
  lockFile: string,
  operation: (
    state: SmartRenameState,
    persist: () => Promise<void>,
  ) => Promise<T> | T,
): Promise<T> {
  const release = await acquireLock(lockFile);
  try {
    const state = await loadState(stateFile);
    const persist = () => saveState(stateFile, state);
    const result = await operation(state, persist);
    await persist();
    return result;
  } finally {
    await release();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = UnknownRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

export function pidAlive(
  pid: number,
  signal: typeof process.kill = process.kill,
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

interface PidCommandProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

interface PidCommandDependencies {
  spawn?: (pid: number) => PidCommandProcess;
  timeoutMs?: number;
}

export async function commandForPid(
  pid: number,
  dependencies: PidCommandDependencies = {},
): Promise<string> {
  const child = (dependencies.spawn ?? ((targetPid) => Bun.spawn(
    ["ps", "-p", String(targetPid), "-o", "command="],
    {
      env: nonProviderSubprocessEnv(),
      stdout: "pipe",
      stderr: "ignore",
    },
  )))(pid);
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const operation = (async (): Promise<number> => {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 64 * 1024) {
          overflow = true;
          try { child.kill("SIGKILL"); } catch {}
          break;
        }
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return child.exited;
  })();

  try {
    const exitCode = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          void reader.cancel().catch(() => {});
          reject(new Error("ps inspection timed out"));
        }, dependencies.timeoutMs ?? 2_000);
      }),
    ]);
    if (overflow) throw new Error("ps output exceeded buffer");
    if (exitCode !== 0) throw new Error(`ps exited ${exitCode}`);
    return new TextDecoder().decode(Buffer.concat(chunks)).trim();
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export interface WorkerDependencies {
  isAlive?: (pid: number) => boolean;
  commandForPid?: (pid: number) => Promise<string>;
}

export type WorkerInspection =
  | { status: "missing" }
  | { status: "stale" | "running"; info: WorkerInfo }
  | { status: "conflict"; info?: WorkerInfo; reason: string };

export class WorkerRecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerRecordConflictError";
  }
}

export async function writeWorkerInfo(
  pidFile: string,
  info: WorkerInfo,
): Promise<void> {
  const validated = WorkerInfoSchema.parse(info);
  const temporary = `${pidFile}.${validated.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600 });
  await rename(temporary, pidFile);
  await chmod(pidFile, 0o600);
}

async function quarantineIfUnchanged(file: string, expectedText: string): Promise<boolean> {
  const quarantine = `${file}.${process.pid}.${randomUUID()}.remove`;
  try {
    await rename(file, quarantine);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  let unchanged = false;
  try {
    unchanged = (await readFile(quarantine, "utf8")) === expectedText;
    if (!unchanged) {
      try {
        await link(quarantine, file);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  } finally {
    await rm(quarantine, { force: true });
  }
  return unchanged;
}

export async function removeOwnedWorkerPid(
  pidFile: string,
  pid: number,
  expectedScript?: string,
): Promise<void> {
  try {
    const raw = await readFile(pidFile, "utf8");
    const info = WorkerInfoSchema.parse(JSON.parse(raw));
    if (info.pid === pid && (!expectedScript || info.script === expectedScript)) {
      await quarantineIfUnchanged(pidFile, raw);
    }
  } catch {
    // Missing, malformed, or replaced ownership is deliberately left untouched.
  }
}

export async function inspectWorker(
  pidFile: string,
  expectedScript: string,
  dependencies: WorkerDependencies = {},
): Promise<WorkerInspection> {
  let info: WorkerInfo;
  try {
    info = WorkerInfoSchema.parse(JSON.parse(await readFile(pidFile, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "conflict", reason: "worker ownership record is unreadable" };
  }

  const isAlive = dependencies.isAlive ?? pidAlive;
  if (!isAlive(info.pid)) return { status: "stale", info };
  if (info.script !== expectedScript) {
    return { status: "conflict", info, reason: "live worker uses a different script" };
  }
  const getCommand = dependencies.commandForPid ?? commandForPid;
  try {
    const command = await getCommand(info.pid);
    if (!command.includes(expectedScript)) {
      return { status: "conflict", info, reason: "live PID command does not match worker script" };
    }
  } catch {
    return { status: "conflict", info, reason: "could not verify live worker command" };
  }
  return { status: "running", info };
}

export async function workerInfo(
  pidFile: string,
  expectedScript: string,
  dependencies: WorkerDependencies = {},
): Promise<WorkerInfo | null> {
  const inspection = await inspectWorker(pidFile, expectedScript, dependencies);
  if (inspection.status === "running") return inspection.info;
  if (inspection.status === "conflict") {
    throw new WorkerRecordConflictError(inspection.reason);
  }
  return null;
}

async function staleLockSnapshot(
  lockFile: string,
  staleMs: number,
): Promise<string | null> {
  let age: number;
  try {
    age = Date.now() - (await stat(lockFile)).mtimeMs;
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(lockFile, "utf8");
    const owner = LockOwnerSchema.parse(JSON.parse(raw));
    // Age is diagnostic only while an owner is demonstrably alive.
    return pidAlive(owner.pid) ? null : raw;
  } catch {
    return age >= staleMs ? (await readFile(lockFile, "utf8").catch(() => "")) : null;
  }
}

interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

export async function acquireLock(
  lockFile: string,
  { timeoutMs = 130_000, staleMs = 5 * 60_000, retryMs = 50 }: LockOptions = {},
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();
  while (true) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() })}\n`,
      );
      await handle.close();
      await chmod(lockFile, 0o600);
      return async () => {
        try {
          const raw = await readFile(lockFile, "utf8");
          const owner = LockOwnerSchema.parse(JSON.parse(raw));
          if (owner.nonce === nonce) await quarantineIfUnchanged(lockFile, raw);
        } catch {
          // A stale or replaced lock is not ours to remove.
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const staleSnapshot = await staleLockSnapshot(lockFile, staleMs);
      if (staleSnapshot !== null && await quarantineIfUnchanged(lockFile, staleSnapshot)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock: ${lockFile}`);
      }
      await Bun.sleep(retryMs);
    }
  }
}

export class WorkerShutdownOwnership {
  readonly #startLock: string;
  readonly #pidFile: string;
  readonly #pid: number;
  readonly #script: string;
  #release: (() => Promise<void>) | null = null;

  constructor(options: {
    startLock: string;
    pidFile: string;
    pid: number;
    script: string;
  }) {
    this.#startLock = options.startLock;
    this.#pidFile = options.pidFile;
    this.#pid = options.pid;
    this.#script = options.script;
  }

  async begin(): Promise<void> {
    if (this.#release) return;
    this.#release = await acquireLock(this.#startLock, {
      timeoutMs: 20_000,
      staleMs: 60_000,
    });
  }

  async finish(): Promise<void> {
    const release = this.#release;
    if (!release) return;
    this.#release = null;
    try {
      await removeOwnedWorkerPid(this.#pidFile, this.#pid, this.#script);
    } finally {
      await release();
    }
  }
}
