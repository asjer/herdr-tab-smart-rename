import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerLogger } from "../src/worker-log.ts";

test("worker logger deduplicates repeated failures and keeps private files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-log-"));
  const file = path.join(dir, "worker.log");
  try {
    let now = 1_000;
    const logger = createWorkerLogger({ file, now: () => now });
    for (let index = 0; index < 100; index += 1) await logger.log("same protocol failure");
    await logger.flush();
    const text = await readFile(file, "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 2);
    assert.match(text, /same protocol failure/);
    assert.match(text, /repeated 99 times/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker logger hard-caps an oversized legacy log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-log-cap-"));
  const file = path.join(dir, "worker.log");
  const archive = `${file}.1`;
  try {
    await writeFile(file, "x".repeat(2_000), { mode: 0o600 });
    const logger = createWorkerLogger({ file, archive, maxBytes: 180, maxLineChars: 80 });
    await logger.log("new bounded entry");
    await logger.flush();
    assert.ok((await stat(file)).size <= 180);
    assert.ok((await stat(archive)).size <= 180);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker logger rejects symlinks and preserves their targets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-log-link-"));
  const target = path.join(dir, "target");
  const file = path.join(dir, "worker.log");
  try {
    await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, file);
    const logger = createWorkerLogger({ file, maxBytes: 128 });
    await assert.rejects(logger.log("must not follow"), /non-regular worker log/);
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker logger rotates to one bounded private archive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-rotate-"));
  const file = path.join(dir, "worker.log");
  const archive = `${file}.1`;
  try {
    let now = 2_000;
    const logger = createWorkerLogger({
      file,
      archive,
      maxBytes: 180,
      maxLineChars: 80,
      now: () => now++,
    });
    for (let index = 0; index < 20; index += 1) {
      await logger.log(`distinct failure ${index} ${"é".repeat(40)}`);
    }
    await logger.flush();
    assert.ok((await stat(file)).size <= 180);
    assert.ok((await stat(archive)).size <= 180);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(archive)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
