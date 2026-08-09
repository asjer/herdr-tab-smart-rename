import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyHerdrFailure, CommandExecutionError } from "../src/failure.ts";
import { nonProviderSubprocessEnv } from "../src/subprocess-env.ts";
import {
  HerdrEventFramer,
  MAX_EVENT_LINE_BYTES,
  normalizeHerdrEvent,
  run,
  snapshotPreflight,
} from "../src/herdr.ts";

const protocolFixture = JSON.stringify({
  id: "cli:api:snapshot",
  error: {
    code: "protocol_mismatch",
    message: "client protocol 19 is newer than server protocol 17; restart the Herdr server before using this command.",
  },
});

test("production protocol mismatch and missing binary classify as fatal", () => {
  const protocol = classifyHerdrFailure(new Error(protocolFixture));
  assert.equal(protocol.kind, "protocol_mismatch");
  assert.equal(protocol.fatal, true);

  const missing = Object.assign(
    new Error("ENOENT: no such file or directory, posix_spawn '/opt/homebrew/bin/herdr'"),
    { code: "ENOENT" },
  );
  const classified = classifyHerdrFailure(missing);
  assert.equal(classified.kind, "herdr_missing");
  assert.equal(classified.fatal, true);

  assert.equal(classifyHerdrFailure(new Error("herdr timed out")).kind, "transient");
});

test("structured Herdr code wins over conflicting prose and preserves bounded metadata", () => {
  const error = new CommandExecutionError("snapshot failed", {
    command: "/secret/path/herdr",
    exitCode: 17,
    stderr: JSON.stringify({
      error: {
        code: "server_not_running",
        message: "client protocol 19 is newer than server protocol 17",
      },
    }),
  });
  const failure = classifyHerdrFailure(error);
  assert.equal(failure.kind, "transient");
  assert.equal(failure.code, "server_not_running");
  assert.equal(failure.metadata?.exitCode, 17);
  assert.ok((failure.metadata?.stderr?.length ?? 0) <= 500);
  const coded = classifyHerdrFailure(Object.assign(
    new Error("client protocol 19 is newer than server protocol 17"),
    { code: "server_not_running" },
  ));
  assert.equal(coded.kind, "transient");
});

test("non-provider subprocess environment removes every supported provider secret", () => {
  assert.deepEqual(nonProviderSubprocessEnv({
    SMART_RENAME_API_KEY: "a",
    OPENAI_API_KEY: "b",
    KIMI_API_KEY: "c",
    HERDR_SOCKET_PATH: "/safe/socket",
  }), { HERDR_SOCKET_PATH: "/safe/socket" });
});

test("command streaming caps stdout and stderr and strips provider secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-output-"));
  const fake = path.join(dir, "child");
  try {
    await writeFile(fake, `#!/bin/sh
case "$1" in
stdout) head -c 10000 /dev/zero | tr '\\0' x ;;
stderr) head -c 10000 /dev/zero | tr '\\0' y >&2; exit 7 ;;
env) [ -z "$SMART_RENAME_API_KEY$OPENAI_API_KEY$KIMI_API_KEY" ] || exit 9; printf ok ;;
esac
`);
    await chmod(fake, 0o700);
    for (const mode of ["stdout", "stderr"] as const) {
      const started = Date.now();
      await assert.rejects(
        run(fake, [mode], { maxBuffer: 512, timeout: 2_000 }),
        (error: unknown) => {
          assert.ok(error instanceof CommandExecutionError);
          assert.equal(error.metadata.overflowStream, mode);
          assert.ok(Buffer.byteLength(error.metadata[mode] ?? "") <= 500);
          return true;
        },
      );
      assert.ok(Date.now() - started < 3_000);
    }
    assert.equal(await run(fake, ["env"], {
      env: {
        PATH: process.env.PATH,
        SMART_RENAME_API_KEY: "secret-a",
        OPENAI_API_KEY: "secret-b",
        KIMI_API_KEY: "secret-c",
      },
    }), "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("event framing rejects large partial lines and bounds event fields", () => {
  const framer = new HerdrEventFramer();
  const overflow = framer.push("x".repeat(MAX_EVENT_LINE_BYTES + 1));
  assert.equal(overflow.failure?.kind, "transient");
  assert.ok(overflow.failure!.message.length <= 500);

  assert.equal(normalizeHerdrEvent({
    event: "tab.renamed",
    data: { tab_id: "x".repeat(257), label: "safe" },
  }), null);
  const valid = new HerdrEventFramer().push(`${JSON.stringify({
    event: "tab.renamed",
    data: { tab_id: "t1", label: "Latest" },
  })}\n`);
  assert.equal(valid.events[0]?.tab_id, "t1");
});

test("snapshot preflight refuses protocol skew without a live Herdr socket", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "smart-rename-herdr-"));
  const fake = path.join(dir, "herdr");
  try {
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' '${protocolFixture}' >&2\nexit 1\n`);
    await chmod(fake, 0o700);
    await assert.rejects(
      snapshotPreflight({ HERDR_BIN_PATH: fake }),
      (error: unknown) => {
        const failure = classifyHerdrFailure(error);
        assert.equal(failure.kind, "protocol_mismatch");
        assert.equal(failure.fatal, true);
        return true;
      },
    );

    await assert.rejects(
      snapshotPreflight({ HERDR_BIN_PATH: path.join(dir, "missing-herdr") }),
      (error: unknown) => {
        assert.equal(classifyHerdrFailure(error).kind, "herdr_missing");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
