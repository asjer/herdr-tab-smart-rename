import { sanitizeText } from "./text.ts";

export type HerdrFailureKind =
  | "protocol_mismatch"
  | "herdr_missing"
  | "transient"
  | "command_failed";

export interface CommandFailureMetadata {
  command: string;
  exitCode?: number | undefined;
  spawnCode?: string | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  timedOut?: boolean | undefined;
  overflowStream?: "stdout" | "stderr" | undefined;
}

export class CommandExecutionError extends Error {
  readonly metadata: CommandFailureMetadata;

  constructor(message: string, metadata: CommandFailureMetadata, options: { cause?: unknown } = {}) {
    super(boundedFailureMessage(message), options);
    this.name = "CommandExecutionError";
    this.metadata = {
      ...metadata,
      command: boundedFailureMessage(metadata.command),
      stdout: metadata.stdout ? boundedFailureMessage(metadata.stdout) : undefined,
      stderr: metadata.stderr ? boundedFailureMessage(metadata.stderr) : undefined,
    };
  }
}

export class HerdrRuntimeError extends Error {
  readonly kind: HerdrFailureKind;
  readonly fatal: boolean;
  readonly code: string | undefined;
  readonly metadata: CommandFailureMetadata | undefined;

  constructor(
    kind: HerdrFailureKind,
    message: string,
    options: {
      cause?: unknown;
      code?: string | undefined;
      metadata?: CommandFailureMetadata | undefined;
    } = {},
  ) {
    super(boundedFailureMessage(message), { cause: options.cause });
    this.name = "HerdrRuntimeError";
    this.kind = kind;
    this.fatal = kind === "protocol_mismatch" || kind === "herdr_missing";
    this.code = options.code;
    this.metadata = options.metadata;
  }
}

function nestedErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  return nestedErrorCode(record.error);
}

function parsedErrorCode(message: string): string | undefined {
  try {
    return nestedErrorCode(JSON.parse(message));
  } catch {
    return undefined;
  }
}

function rawErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return String((error as { code?: unknown }).code ?? "");
}

export function boundedFailureMessage(value: unknown): string {
  const text = sanitizeText(value instanceof Error ? value.message : String(value ?? ""));
  return text.slice(0, 500) || "Herdr command failed";
}

function kindForStructuredCode(code: string): HerdrFailureKind {
  if (code === "protocol_mismatch") return "protocol_mismatch";
  if (code === "ENOENT") return "herdr_missing";
  if (code === "server_not_running") return "transient";
  return "command_failed";
}

export function classifyHerdrFailure(error: unknown): HerdrRuntimeError {
  if (error instanceof HerdrRuntimeError) return error;
  const metadata = error instanceof CommandExecutionError ? error.metadata : undefined;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const structuredCode =
    parsedErrorCode(metadata?.stdout ?? "") ??
    parsedErrorCode(metadata?.stderr ?? "") ??
    parsedErrorCode(message);
  const spawnCode = metadata?.spawnCode ?? rawErrorCode(error);

  // A Herdr JSON code is authoritative even when its prose contains misleading text.
  if (structuredCode) {
    return new HerdrRuntimeError(kindForStructuredCode(structuredCode), message, {
      cause: error,
      code: structuredCode,
      metadata,
    });
  }
  if (spawnCode === "protocol_mismatch" || spawnCode === "server_not_running") {
    return new HerdrRuntimeError(kindForStructuredCode(spawnCode), message, {
      cause: error,
      code: spawnCode,
      metadata,
    });
  }
  if (spawnCode === "ENOENT") {
    return new HerdrRuntimeError("herdr_missing", message, {
      cause: error,
      code: spawnCode,
      metadata,
    });
  }
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(spawnCode ?? "")) {
    return new HerdrRuntimeError("transient", message, {
      cause: error,
      code: spawnCode,
      metadata,
    });
  }
  if (/\bprotocol_mismatch\b|client protocol \d+ is newer than server protocol \d+/i.test(message)) {
    return new HerdrRuntimeError("protocol_mismatch", message, { cause: error, metadata });
  }
  if (/\bENOENT\b|posix_spawn[^\n]*herdr|Herdr binary[^\n]*missing/i.test(message)) {
    return new HerdrRuntimeError("herdr_missing", message, { cause: error, metadata });
  }
  if (/\b(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT)\b|timed out|server_not_running|connection refused|socket (?:closed|unavailable)|output exceeded buffer/i.test(message)) {
    return new HerdrRuntimeError("transient", message, { cause: error, metadata });
  }
  return new HerdrRuntimeError("command_failed", message, { cause: error, metadata });
}

export function isFatalHerdrFailure(error: unknown): boolean {
  return classifyHerdrFailure(error).fatal;
}
