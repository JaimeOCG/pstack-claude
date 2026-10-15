#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const [destination, separator, executable, ...args] = process.argv.slice(2);
if (!destination || separator !== "--" || !executable || process.platform === "win32") {
  console.error("Usage: node capture.mjs DEST -- COMMAND [ARGS...] (POSIX host required)");
  process.exitCode = 125;
} else {
  process.exitCode = await capture(resolve(destination), [executable, ...args]);
}

async function capture(directory, argv) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    console.error(`capture: cannot reserve ${directory}: ${error.message}`);
    return 125;
  }

  let child;
  let closed;
  let incomplete;
  let termination;
  let settled = false;
  const fail = (result) => {
    incomplete ??= result;
    if (settled || !child?.pid || termination) return;
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") console.error(`capture: ${error.message}`);
      }
    };
    killGroup("SIGTERM");
    termination = new Promise((done) => {
      setTimeout(() => {
        killGroup("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        done();
      }, 500);
    });
  };
  const interrupted = (signal) => fail({ kind: "incomplete", reason: "interrupted", signal });
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].map((signal) => {
    const handler = () => interrupted(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  const captureError = (error) => fail({ kind: "incomplete", reason: "capture-error", error: error.message });
  const outputs = [];
  try {
    writeFileSync(join(directory, "command.json"), `${JSON.stringify({ argv, cwd: process.cwd(), startedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    for (const name of ["stdout.bin", "stderr.bin"]) {
      const fd = openSync(join(directory, name), "wx", 0o600);
      const output = createWriteStream(join(directory, name), { fd });
      output.on("error", captureError);
      outputs.push(output);
    }
    child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["inherit", "pipe", "pipe"] });
    closed = new Promise((done) => {
      child.on("error", (error) => fail({ kind: "incomplete", reason: "spawn-error", error: error.message }));
      child.on("exit", (code, signal) => {
        if (signal) fail({ kind: "incomplete", reason: "command-signal", signal });
      });
      child.on("close", (code, signal) => done({ code, signal }));
    });
    const drains = [child.stdout, child.stderr].map((input, index) => pipeline(input, outputs[index]).catch(captureError));
    const { code, signal } = await closed;
    await Promise.all(drains);
    if (signal) fail({ kind: "incomplete", reason: "command-signal", signal });
    await termination;
    settled = true;
    const result = incomplete ?? { kind: "exited", code };
    publish(directory, result);
    return result.kind === "exited" ? code : 125;
  } catch (error) {
    captureError(error);
    await termination;
    for (const output of outputs) output.destroy();
    await closed;
    try {
      publish(directory, incomplete);
    } catch (publicationError) {
      console.error(`capture: cannot publish result: ${publicationError.message}`);
    }
    console.error(`capture: ${error.message}`);
    return 125;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

function publish(directory, result) {
  const temporary = join(directory, ".result.tmp");
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ ...result, finishedAt: new Date().toISOString() })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  linkSync(temporary, join(directory, "result.json"));
  try {
    unlinkSync(temporary);
  } catch (error) {
    console.error(`capture: cannot remove temporary result: ${error.message}`);
  }
}
