import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { sanitizeText } from "./text.ts";

export interface WorkerLogger {
  log(message: string): Promise<void>;
  flush(): Promise<void>;
}

interface LoggerOptions {
  file: string;
  archive?: string;
  maxBytes?: number;
  dedupeWindowMs?: number;
  maxLineChars?: number;
  now?: () => number;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

async function regularFileSize(file: string): Promise<number | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`refusing non-regular worker log: ${file}`);
    }
    return info.size;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function createWorkerLogger({
  file,
  archive = `${file}.1`,
  maxBytes = 5 * 1024 * 1024,
  dedupeWindowMs = 60_000,
  maxLineChars = 800,
  now = Date.now,
}: LoggerOptions): WorkerLogger {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be positive");
  let lastMessage: string | null = null;
  let lastWrittenAt = 0;
  let repeats = 0;
  let work = Promise.resolve();

  const safeLine = (message: string): string =>
    sanitizeText(message).replaceAll(/\s+/g, " ").slice(0, maxLineChars) || "worker event";

  const removeArchive = async (): Promise<void> => {
    await regularFileSize(archive);
    await rm(archive, { force: true });
  };

  const writeNew = async (target: string, content: string): Promise<void> => {
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`refusing non-regular worker log: ${target}`);
      await handle.chmod(0o600);
      await handle.writeFile(truncateUtf8(content, maxBytes));
    } finally {
      await handle.close();
    }
  };

  const rotate = async (): Promise<void> => {
    const size = await regularFileSize(file);
    if (size === null) return;
    await removeArchive();
    await rename(file, archive);
    const archiveHandle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const archiveInfo = await archiveHandle.stat();
      if (!archiveInfo.isFile()) throw new Error(`refusing non-regular worker log: ${archive}`);
      await archiveHandle.chmod(0o600);
    } finally {
      await archiveHandle.close();
    }
    const archivedSize = await regularFileSize(archive);
    if (archivedSize !== null && archivedSize > maxBytes) {
      await rm(archive);
      await writeNew(
        archive,
        `${new Date(now()).toISOString()} previous log exceeded limit and was truncated\n`,
      );
    }
  };

  const append = async (message: string): Promise<void> => {
    const raw = `${new Date(now()).toISOString()} ${safeLine(message)}\n`;
    const line = truncateUtf8(raw, maxBytes);
    let size = await regularFileSize(file);
    if (size !== null && (size > maxBytes || size + Buffer.byteLength(line) > maxBytes)) {
      await rotate();
      size = null;
    }
    if (size === null) {
      await writeNew(file, line);
      return;
    }

    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`refusing non-regular worker log: ${file}`);
      if (info.size + Buffer.byteLength(line) > maxBytes) {
        await handle.close();
        await rotate();
        await writeNew(file, line);
        return;
      }
      await handle.chmod(0o600);
      await handle.writeFile(line);
    } finally {
      await handle.close().catch(() => {});
    }
  };

  const flushRepeats = async (): Promise<void> => {
    if (repeats === 0 || lastMessage === null) return;
    const count = repeats;
    repeats = 0;
    await append(`${lastMessage} (repeated ${count} times)`);
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    work = work.then(operation, operation);
    return work;
  };

  return {
    log(message: string): Promise<void> {
      const safe = safeLine(message);
      return enqueue(async () => {
        const timestamp = now();
        if (safe === lastMessage && timestamp - lastWrittenAt < dedupeWindowMs) {
          repeats += 1;
          return;
        }
        await flushRepeats();
        await append(safe);
        lastMessage = safe;
        lastWrittenAt = timestamp;
      });
    },
    flush(): Promise<void> {
      return enqueue(flushRepeats);
    },
  };
}
