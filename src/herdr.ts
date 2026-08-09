import net, { type Socket } from "node:net";
import { z } from "zod";
import { type PaneContext } from "./domain.ts";
import {
  classifyHerdrFailure,
  CommandExecutionError,
  HerdrRuntimeError,
  isFatalHerdrFailure,
} from "./failure.ts";
import { nonProviderSubprocessEnv } from "./subprocess-env.ts";
import { sampledUserMessages } from "./pi-context.ts";
import { boundedText } from "./text.ts";

const WorkspaceSchema = z.looseObject({
  workspace_id: z.string(),
  label: z.string(),
  number: z.union([z.number(), z.string()]),
  active_tab_id: z.string().optional(),
  cwd: z.string().optional(),
  worktree: z.object({ repo_name: z.string().optional() }).nullable().optional(),
});

const TabSchema = z.looseObject({
  tab_id: z.string(),
  workspace_id: z.string(),
  label: z.string(),
  number: z.union([z.number(), z.string()]),
});

const PaneSchema = z.looseObject({
  pane_id: z.string(),
  tab_id: z.string(),
  workspace_id: z.string(),
  label: z.string().optional(),
  cwd: z.string().optional(),
  foreground_cwd: z.string().optional(),
  agent: z.string().optional(),
  agent_status: z.string().optional(),
  agent_session: z
    .object({ kind: z.string(), value: z.string() })
    .optional(),
});

const LayoutSchema = z.looseObject({
  tab_id: z.string(),
  focused_pane_id: z.string().optional(),
});

const SnapshotSchema = z.object({
  focused_workspace_id: z.string().optional(),
  focused_tab_id: z.string().optional(),
  focused_pane_id: z.string().optional(),
  workspaces: z.array(WorkspaceSchema),
  tabs: z.array(TabSchema),
  panes: z.array(PaneSchema),
  layouts: z.array(LayoutSchema),
});

const SnapshotResponseSchema = z.object({
  result: z.object({ snapshot: SnapshotSchema }),
});

const ProcessResponseSchema = z.object({
  result: z.object({
    process_info: z.object({
      foreground_processes: z
        .array(
          z.looseObject({
            argv0: z.string().optional(),
            name: z.string().optional(),
            cmdline: z.string().optional(),
            argv: z.array(z.string()).optional(),
            cwd: z.string().optional(),
          }),
        )
        .optional(),
    }),
  }),
});

const EventIdSchema = z.string().min(1).max(256);
const EventEnvelopeSchema = z.object({
  event: z.string().min(1).max(128),
  data: z.looseObject({
    type: z.string().max(128).optional(),
    workspace_id: EventIdSchema.optional(),
    tab_id: EventIdSchema.optional(),
    pane_id: EventIdSchema.optional(),
    label: z.string().max(256).optional(),
    workspace: z.object({ workspace_id: EventIdSchema.optional() }).optional(),
    tab: z.object({ tab_id: EventIdSchema.optional() }).optional(),
    pane: z.object({ tab_id: EventIdSchema.optional() }).optional(),
  }),
});

export type HerdrSnapshot = z.infer<typeof SnapshotSchema>;
export type HerdrWorkspace = z.infer<typeof WorkspaceSchema>;
export type HerdrTab = z.infer<typeof TabSchema>;
export type HerdrPane = z.infer<typeof PaneSchema>;
export type HerdrEvent = z.infer<typeof EventEnvelopeSchema>["data"] & {
  eventName: string;
  type: string;
};

const TAB_PROGRESS_MARKER = "\u2063";
const TAB_PROGRESS_FRAMES = ["◇", "◈", "◆", "◈"] as const;
const TAB_PROGRESS_INTERVAL_MS = 120;

export function tabProgressBase(label: string): string | null {
  if (!label.startsWith(TAB_PROGRESS_MARKER)) return null;
  const separator = label.indexOf(" ", TAB_PROGRESS_MARKER.length);
  if (separator < 0) return null;
  const frame = label.slice(TAB_PROGRESS_MARKER.length, separator);
  if (!(TAB_PROGRESS_FRAMES as readonly string[]).includes(frame)) return null;
  return label.slice(separator + 1);
}

function tabProgressLabel(base: string, frame: string): string {
  return `${TAB_PROGRESS_MARKER}${frame} ${base}`;
}

export const LIFECYCLE_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "tab.created",
  "tab.renamed",
  "tab.closed",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.focused",
] as const;

interface RunOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

interface BoundedStreamResult {
  text: string;
  overflow: boolean;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<BoundedStreamResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = Math.max(0, maxBytes - total);
      if (item.value.byteLength > remaining) {
        if (remaining) chunks.push(item.value.slice(0, remaining));
        total = maxBytes;
        overflow = true;
        onOverflow();
        break;
      }
      chunks.push(item.value);
      total += item.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), overflow };
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  const maxBytes = options.maxBuffer ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeout ?? 10_000;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [command, ...args],
      env: nonProviderSubprocessEnv(options.env ?? process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const spawnCode = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
    throw new CommandExecutionError(`${command} failed to spawn`, {
      command,
      spawnCode,
    }, { cause: error });
  }

  let timedOut = false;
  let overflowStream: "stdout" | "stderr" | undefined;
  const terminate = (stream?: "stdout" | "stderr"): void => {
    overflowStream ??= stream;
    try {
      child.kill();
    } catch {
      // The child may already have exited.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outputPromise = Promise.all([
      readBoundedStream(child.stdout, maxBytes, () => terminate("stdout")),
      readBoundedStream(child.stderr, maxBytes, () => terminate("stderr")),
    ]);
    const [stdoutResult, stderrResult] = await Promise.race([
      outputPromise,
      new Promise<never>((_, reject) => {
        hardTimer = setTimeout(
          () => reject(new Error(`${command} did not terminate after kill`)),
          timeoutMs + 1_500,
        );
      }),
    ]);
    let exitCode = await Promise.race([
      child.exited,
      Bun.sleep(750).then(() => {
        try { child.kill("SIGKILL"); } catch {}
        return -1;
      }),
    ]);
    if (exitCode === -1) {
      exitCode = await Promise.race([child.exited, Bun.sleep(750).then(() => -1)]);
    }
    const stdout = stdoutResult.text.trim();
    const stderr = stderrResult.text.trim();
    const metadata = {
      command,
      exitCode,
      stdout,
      stderr,
      timedOut,
      overflowStream,
    };
    if (timedOut) throw new CommandExecutionError(`${command} timed out`, metadata);
    if (stdoutResult.overflow || stderrResult.overflow) {
      throw new CommandExecutionError(
        `${command} ${overflowStream ?? "output"} exceeded buffer`,
        metadata,
      );
    }
    if (exitCode !== 0) {
      throw new CommandExecutionError(
        stderr || stdout || `${command} exited ${exitCode}`,
        metadata,
      );
    }
    return stdout;
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    try { child.kill("SIGKILL"); } catch {}
    throw new CommandExecutionError(
      timedOut
        ? `${command} timed out`
        : overflowStream
          ? `${command} ${overflowStream} exceeded buffer`
          : `${command} failed while reading output`,
      { command, timedOut, overflowStream },
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}

export async function herdrRun(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    return await run(env.HERDR_BIN_PATH || "herdr", args, { env });
  } catch (error) {
    throw classifyHerdrFailure(error);
  }
}

async function herdrJson(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const output = await herdrRun(args, env);
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      throw classifyHerdrFailure(JSON.stringify(parsed));
    }
    return parsed;
  } catch (error) {
    throw classifyHerdrFailure(error);
  }
}

export async function snapshotPreflight(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await snapshot(env);
}

export async function snapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrSnapshot> {
  return SnapshotResponseSchema.parse(await herdrJson(["api", "snapshot"], env))
    .result.snapshot;
}

export async function rename(
  kind: "workspace" | "tab",
  id: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await herdrRun([kind, "rename", id, label], env);
}

export async function beginTabProgress(
  tab: HerdrTab,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const base = tab.label;
  let expected = base;
  let frame = 0;
  let stopped = false;
  let work = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const update = (nextFrame: number): Promise<void> => {
    work = work
      .then(async () => {
        if (stopped) return;
        const current = (await snapshot(env)).tabs.find(
          (item) => item.tab_id === tab.tab_id,
        )?.label;
        if (stopped || current !== expected) {
          stopped = true;
          return;
        }
        const next = tabProgressLabel(base, TAB_PROGRESS_FRAMES[nextFrame]!);
        await rename("tab", tab.tab_id, next, env);
        expected = next;
        frame = nextFrame;
      })
      .catch(() => {
        stopped = true;
      });
    return work;
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      void update((frame + 1) % TAB_PROGRESS_FRAMES.length).then(() => {
        if (!stopped) schedule();
      });
    }, TAB_PROGRESS_INTERVAL_MS);
  };

  await update(0);
  if (!stopped) schedule();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await work;
    if (expected === base) return;
    try {
      const current = (await snapshot(env)).tabs.find(
        (item) => item.tab_id === tab.tab_id,
      )?.label;
      if (current === expected) await rename("tab", tab.tab_id, base, env);
    } catch {
      // Progress cleanup must not hide the naming result.
    }
  };
}

export async function gitRoot(cwd?: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    return await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

async function paneRecent(
  paneId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    return boundedText(
      await herdrRun(
        ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "12"],
        env,
      ),
      1_000,
    );
  } catch (error) {
    if (isFatalHerdrFailure(error)) throw error;
    return "";
  }
}

async function paneProcess(
  paneId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneContext["process"]> {
  try {
    const data = ProcessResponseSchema.parse(
      await herdrJson(["pane", "process-info", "--pane", paneId], env),
    );
    const item = data.result.process_info.foreground_processes?.[0];
    if (!item) return null;
    return {
      name: boundedText(item.argv0 ?? item.name, 80),
      command: boundedText(item.cmdline ?? item.argv?.join(" ") ?? "", 500),
      cwd: boundedText(item.cwd, 200),
    };
  } catch (error) {
    if (isFatalHerdrFailure(error)) throw error;
    return null;
  }
}

export async function focusedPaneContext(
  pane: HerdrPane,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneContext> {
  const sessionPath =
    pane.agent === "pi" && pane.agent_session?.kind === "path"
      ? pane.agent_session.value
      : null;
  const [process, recentOutput, sessionMessages] = await Promise.all([
    paneProcess(pane.pane_id, env),
    paneRecent(pane.pane_id, env),
    sampledUserMessages(sessionPath, env),
  ]);
  return {
    focused: true,
    label: boundedText(pane.label, 80),
    process,
    recentOutput,
    sessionMessages,
    userMessages: [
      ...sessionMessages.origin,
      ...sessionMessages.middle,
      ...sessionMessages.recent,
    ],
  };
}

export async function siblingPaneContext(
  pane: HerdrPane,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaneContext> {
  return {
    focused: false,
    label: boundedText(pane.label, 80),
    process: await paneProcess(pane.pane_id, env),
    recentOutput: "",
    userMessages: [],
  };
}

export function normalizeHerdrEvent(message: unknown): HerdrEvent | null {
  const envelope = EventEnvelopeSchema.safeParse(message);
  if (!envelope.success) return null;
  return {
    ...envelope.data.data,
    eventName: envelope.data.event,
    type:
      envelope.data.data.type ?? envelope.data.event.replaceAll(".", "_"),
  };
}

export const MAX_EVENT_LINE_BYTES = 64 * 1024;

export class HerdrEventFramer {
  #buffer = "";

  push(chunk: string): { events: HerdrEvent[]; failure?: HerdrRuntimeError } {
    this.#buffer += chunk;
    const events: HerdrEvent[] = [];
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const rawLine = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (Buffer.byteLength(rawLine) > MAX_EVENT_LINE_BYTES) {
        this.#buffer = "";
        return {
          events,
          failure: new HerdrRuntimeError("transient", "Herdr event frame exceeded byte limit"),
        };
      }
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      try {
        const message: unknown = JSON.parse(line);
        if (message && typeof message === "object" && "error" in message) {
          this.#buffer = "";
          return { events, failure: classifyHerdrFailure(JSON.stringify(message)) };
        }
        const event = normalizeHerdrEvent(message);
        if (event) events.push(event);
      } catch {
        // Malformed complete frames are ignored; close/reconnect handles stream damage.
      }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_EVENT_LINE_BYTES) {
      this.#buffer = "";
      return {
        events,
        failure: new HerdrRuntimeError("transient", "Herdr partial event frame exceeded byte limit"),
      };
    }
    return { events };
  }
}

export function subscribe(
  socketPath: string,
  onEvent: (event: HerdrEvent) => void,
  onFailure: (error: HerdrRuntimeError) => void = () => {},
): Socket {
  const socket = net.createConnection(socketPath);
  const framer = new HerdrEventFramer();
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        id: "tab-smart-rename-subscribe",
        method: "events.subscribe",
        params: {
          subscriptions: LIFECYCLE_SUBSCRIPTIONS.map((type) => ({ type })),
        },
      })}\n`,
    );
  });
  socket.on("data", (chunk: string) => {
    const result = framer.push(chunk);
    for (const event of result.events) onEvent(event);
    if (result.failure) {
      onFailure(result.failure);
      socket.destroy();
    }
  });
  return socket;
}
