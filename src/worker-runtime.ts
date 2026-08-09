import { classifyHerdrFailure } from "./failure.ts";
import { type WorkerLogger } from "./worker-log.ts";

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
export const TRANSIENT_RETRY_MS = 60_000;
export const MAX_PENDING_ITEMS = 256;
export const SHUTDOWN_DEADLINE_MS = 4_000;

export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(0, Math.min(30, Math.floor(attempt)));
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** boundedAttempt);
  return Math.floor(ceiling / 2 + Math.max(0, Math.min(1, random())) * ceiling / 2);
}

export interface PendingAcknowledgement {
  kind: "workspace" | "tab";
  id: string;
  label: string;
}

interface SchedulerOptions {
  scan(): Promise<string[]>;
  evaluate(tabId: string): Promise<void>;
  acknowledge(item: PendingAcknowledgement): Promise<void>;
  onError(error: unknown): Promise<void> | void;
  onFatal(error: unknown): Promise<void> | void;
  retryMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  maxPending?: number;
}

export class CoalescingScheduler {
  readonly #scan: SchedulerOptions["scan"];
  readonly #evaluate: SchedulerOptions["evaluate"];
  readonly #acknowledge: SchedulerOptions["acknowledge"];
  readonly #onError: SchedulerOptions["onError"];
  readonly #onFatal: SchedulerOptions["onFatal"];
  readonly #retryMs: number;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #maxPending: number;
  readonly #tabs = new Set<string>();
  readonly #acks = new Map<string, PendingAcknowledgement>();
  #rescan = false;
  #draining = false;
  #stopped = false;
  #kickTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #active: Promise<void> = Promise.resolve();

  constructor(options: SchedulerOptions) {
    this.#scan = options.scan;
    this.#evaluate = options.evaluate;
    this.#acknowledge = options.acknowledge;
    this.#onError = options.onError;
    this.#onFatal = options.onFatal;
    this.#retryMs = options.retryMs ?? TRANSIENT_RETRY_MS;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#maxPending = options.maxPending ?? MAX_PENDING_ITEMS;
  }

  requestTab(tabId: string | undefined): void {
    if (!tabId || this.#stopped) return;
    if (tabId.length > 256 || (!this.#tabs.has(tabId) && this.#tabs.size >= this.#maxPending)) {
      this.#tabs.clear();
      this.#rescan = true;
    } else {
      this.#tabs.add(tabId);
    }
    this.#kick();
  }

  requestRescan(): void {
    if (this.#stopped) return;
    this.#rescan = true;
    this.#kick();
  }

  requestAcknowledgement(item: PendingAcknowledgement): void {
    if (this.#stopped) return;
    this.#mergeAcknowledgements([item], true);
    this.#kick();
  }

  pendingCounts(): { tabs: number; acknowledgements: number; rescan: boolean } {
    return { tabs: this.#tabs.size, acknowledgements: this.#acks.size, rescan: this.#rescan };
  }

  async stop(timeoutMs = 2_000): Promise<void> {
    this.#stopped = true;
    if (this.#kickTimer) this.#clearTimer(this.#kickTimer);
    if (this.#retryTimer) this.#clearTimer(this.#retryTimer);
    this.#tabs.clear();
    this.#acks.clear();
    this.#rescan = false;
    await Promise.race([
      this.#active.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async drainForTest(): Promise<void> {
    if (this.#kickTimer) {
      this.#clearTimer(this.#kickTimer);
      this.#kickTimer = undefined;
    }
    await this.#drain();
  }

  #mergeAcknowledgements(
    items: PendingAcknowledgement[],
    replaceSameKey: boolean,
  ): void {
    for (const item of items) {
      const key = `${item.kind}:${item.id}`;
      if (!replaceSameKey && this.#acks.has(key)) continue;
      if (item.id.length > 256 || item.label.length > 256 ||
          (!this.#acks.has(key) && this.#acks.size >= this.#maxPending)) {
        this.#acks.clear();
        this.#rescan = true;
        return;
      }
      this.#acks.set(key, item);
    }
  }

  #kick(): void {
    if (this.#stopped || this.#draining || this.#kickTimer || this.#retryTimer) return;
    this.#kickTimer = this.#setTimer(() => {
      this.#kickTimer = undefined;
      this.#active = this.#drain();
    }, 0);
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#retryTimer) return;
    this.#retryTimer = this.#setTimer(() => {
      this.#retryTimer = undefined;
      this.#kick();
    }, this.#retryMs);
  }

  async #handleFailure(error: unknown): Promise<"fatal" | "retry"> {
    const failure = classifyHerdrFailure(error);
    if (failure.fatal) {
      this.#stopped = true;
      await this.#onFatal(failure);
      return "fatal";
    }
    await this.#onError(failure);
    this.#scheduleRetry();
    return "retry";
  }

  async #drain(): Promise<void> {
    if (this.#stopped || this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#stopped && (this.#rescan || this.#tabs.size || this.#acks.size)) {
        const acks = [...this.#acks.values()];
        this.#acks.clear();
        for (let index = 0; index < acks.length; index += 1) {
          const item = acks[index]!;
          try {
            await this.#acknowledge(item);
          } catch (error) {
            this.#mergeAcknowledgements(acks.slice(index), false);
            await this.#handleFailure(error);
            return;
          }
        }

        if (this.#rescan) {
          this.#rescan = false;
          try {
            for (const tabId of await this.#scan()) {
              if (tabId.length > 256) continue;
              if (!this.#tabs.has(tabId) && this.#tabs.size >= this.#maxPending) break;
              this.#tabs.add(tabId);
            }
          } catch (error) {
            this.#rescan = true;
            await this.#handleFailure(error);
            return;
          }
        }

        const tabs = [...this.#tabs];
        this.#tabs.clear();
        for (let index = 0; index < tabs.length; index += 1) {
          const tabId = tabs[index]!;
          try {
            await this.#evaluate(tabId);
          } catch (error) {
            for (const pending of tabs.slice(index)) this.#tabs.add(pending);
            await this.#handleFailure(error);
            return;
          }
        }
      }
    } finally {
      this.#draining = false;
      if (!this.#retryTimer && !this.#stopped && (this.#rescan || this.#tabs.size || this.#acks.size)) {
        this.#kick();
      }
    }
  }
}

interface ReconnectOptions {
  connect(): void;
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class ReconnectController {
  readonly #connect: ReconnectOptions["connect"];
  readonly #random: () => number;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: ReconnectOptions) {
    this.#connect = options.connect;
    this.#random = options.random ?? Math.random;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  closed(): void {
    if (this.#stopped || this.#timer) return;
    const delay = reconnectDelay(this.#attempt++, this.#random);
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      if (!this.#stopped) this.#connect();
    }, delay);
  }

  validEvent(): void {
    this.#attempt = 0;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  stateForTest(): { attempt: number; timerPending: boolean; stopped: boolean } {
    return { attempt: this.#attempt, timerPending: Boolean(this.#timer), stopped: this.#stopped };
  }
}

interface ShutdownOptions {
  logger: WorkerLogger;
  stopResources(): Promise<void> | void;
  removeOwnership(): Promise<void>;
  exit(code: number): void;
  deadlineMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class WorkerShutdown {
  readonly #logger: WorkerLogger;
  readonly #stopResources: ShutdownOptions["stopResources"];
  readonly #removeOwnership: ShutdownOptions["removeOwnership"];
  readonly #exit: ShutdownOptions["exit"];
  readonly #deadlineMs: number;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  #closing: Promise<void> | null = null;

  constructor(options: ShutdownOptions) {
    this.#logger = options.logger;
    this.#stopResources = options.stopResources;
    this.#removeOwnership = options.removeOwnership;
    this.#exit = options.exit;
    this.#deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  fatal(error: unknown): Promise<void> {
    const failure = classifyHerdrFailure(error);
    return this.#close(`fatal ${failure.kind}: ${failure.message}`, 1);
  }

  signal(signal: string): Promise<void> {
    return this.#close(`stopped by ${signal}`, 0);
  }

  #close(message: string, code: number): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = new Promise<void>((resolve) => {
      let exited = false;
      const exitOnce = (): void => {
        if (exited) return;
        exited = true;
        try {
          this.#exit(code);
        } finally {
          resolve();
        }
      };
      const deadline = this.#setTimer(exitOnce, this.#deadlineMs);
      if (deadline && typeof deadline === "object" && "unref" in deadline) deadline.unref();

      // Ownership remains published until resource shutdown has quiesced.
      // If shutdown hangs, the hard exit leaves a stale (safe) record for the
      // next start to clean under the same per-socket lock.
      const quiesceThenRemove = Promise.resolve()
        .then(() => this.#stopResources())
        .then(() => this.#removeOwnership());
      const cleanup = Promise.allSettled([
        quiesceThenRemove,
        Promise.resolve()
          .then(() => this.#logger.log(message))
          .then(() => this.#logger.flush()),
      ]);
      void cleanup.finally(() => {
        this.#clearTimer(deadline);
        exitOnce();
      });
    });
    return this.#closing;
  }
}
