import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../plugins/pstack/skills/show-me-your-work/scripts/capture.mjs", import.meta.url));
const node = Bun.which("node");
const runtimes = [["Node", node], ["Bun", process.execPath]];
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const pause = () => new Promise((done) => setTimeout(done, 10));

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture readiness");
    await pause();
  }
}

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "pstack-capture-"));
  try {
    await run(root, join(root, "attempt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, runtime] of runtimes) {
  test(`${name} preserves literal streams, argv, cwd and completed failure status`, () => fixture((root, dest) => {
    const source = 'process.stdout.write(Buffer.from([0,255,13,10,37,92])); process.stderr.write(Buffer.from([254,0,10])); process.exitCode=7';
    const argv = [node, "-e", source, "literal $() ; *"];
    const outcome = spawnSync(runtime, [script, dest, "--", ...argv], { cwd: root });
    expect(outcome.status).toBe(7);
    expect(readFileSync(join(dest, "stdout.bin"))).toEqual(Buffer.from([0, 255, 13, 10, 37, 92]));
    expect(readFileSync(join(dest, "stderr.bin"))).toEqual(Buffer.from([254, 0, 10]));
    expect(json(join(dest, "command.json"))).toMatchObject({ argv, cwd: realpathSync(root) });
    expect(json(join(dest, "result.json"))).toMatchObject({ kind: "exited", code: 7 });
    const before = Object.fromEntries(readdirSync(dest).map((file) => [file, readFileSync(join(dest, file))]));
    const marker = join(root, "should-not-exist");
    const collision = spawnSync(runtime, [script, dest, "--", node, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'spawned')`]);
    expect(collision.status).toBe(125);
    expect(existsSync(marker)).toBe(false);
    expect(Object.fromEntries(readdirSync(dest).map((file) => [file, readFileSync(join(dest, file))]))).toEqual(before);
  }));

  test(`${name} drains output larger than pipe and file buffers`, () => fixture((root, dest) => {
    const source = "process.stdout.write(Buffer.alloc(700000, 255)); process.stderr.write(Buffer.alloc(600000, 0))";
    const outcome = spawnSync(runtime, [script, dest, "--", node, "-e", source]);
    expect(outcome.status).toBe(0);
    expect(readFileSync(join(dest, "stdout.bin"))).toEqual(Buffer.alloc(700000, 255));
    expect(readFileSync(join(dest, "stderr.bin"))).toEqual(Buffer.alloc(600000, 0));
    expect(json(join(dest, "result.json"))).toMatchObject({ kind: "exited", code: 0 });
  }));

  test(`${name} records spawn failure as incomplete`, () => fixture((root, dest) => {
    const outcome = spawnSync(runtime, [script, dest, "--", join(root, "missing-command")]);
    expect(outcome.status).toBe(125);
    expect(json(join(dest, "result.json"))).toMatchObject({ kind: "incomplete", reason: "spawn-error" });
    expect(readFileSync(join(dest, "stdout.bin")).length).toBe(0);
  }));

  test(`${name} records a signalled command as incomplete`, () => fixture((root, dest) => {
    const outcome = spawnSync(runtime, [script, dest, "--", node, "-e", "process.stdout.write('before signal'); process.kill(process.pid,'SIGTERM')"]);
    expect(outcome.status).toBe(125);
    expect(readFileSync(join(dest, "stdout.bin"), "utf8")).toBe("before signal");
    expect(json(join(dest, "result.json"))).toMatchObject({ kind: "incomplete", reason: "command-signal", signal: "SIGTERM" });
  }));

  test(`${name} allows exactly one concurrent destination claim`, () => fixture(async (root, dest) => {
    const workers = Array.from({ length: 8 }, () => spawn(runtime, [script, dest, "--", node, "-e", "process.stdout.write('winner')"]));
    const statuses = await Promise.all(workers.map(async (worker) => (await once(worker, "close"))[0]));
    expect(statuses.filter((code) => code === 0)).toHaveLength(1);
    expect(statuses.filter((code) => code === 125)).toHaveLength(7);
    expect(readFileSync(join(dest, "stdout.bin"), "utf8")).toBe("winner");
    expect(json(join(dest, "result.json"))).toMatchObject({ kind: "exited", code: 0 });
  }));

  test(`${name} refuses a symlink destination before spawning`, () => fixture((root, dest) => {
    symlinkSync(root, dest);
    const outcome = spawnSync(runtime, [script, dest, "--", "touch", join(root, "spawned")]);
    expect(outcome.status).toBe(125);
    expect(existsSync(join(root, "spawned"))).toBe(false);
    expect(existsSync(join(root, "command.json"))).toBe(false);
  }));

  test(`${name} interrupts an owned shell and its TERM-resistant child without hanging`, () => fixture(async (root, dest) => {
    const ready = join(root, "ready");
    const source = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); process.stdout.write('ready'); setInterval(()=>{},1000)`;
    const childFile = join(root, "child.cjs");
    writeFileSync(childFile, source);
    const wrapper = spawn(runtime, [script, dest, "--", "sh", "-c", 'trap "" TERM; "$1" "$2" & wait', "sh", node, childFile]);
    const done = once(wrapper, "close");
    try {
      await waitFor(() => existsSync(ready) && existsSync(join(dest, "stdout.bin")) && readFileSync(join(dest, "stdout.bin"), "utf8") === "ready");
      wrapper.kill("SIGTERM");
      expect((await done)[0]).toBe(125);
      expect(json(join(dest, "result.json"))).toMatchObject({ kind: "incomplete", reason: "interrupted", signal: "SIGTERM" });
      expect(alive(Number(readFileSync(ready, "utf8")))).toBe(false);
    } finally {
      wrapper.kill("SIGKILL");
      if (existsSync(ready)) kill(Number(readFileSync(ready, "utf8")));
    }
  }), 8000);
}

function alive(pid) {
  const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return status.status === 0 && !status.stdout.trim().startsWith("Z");
}

function kill(pid) {
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

test("Node hard kill at the intercepted publication syscall leaves incomplete evidence", () => fixture(async (root, dest) => {
  const barrier = join(root, "publication-intercepted");
  const preload = join(root, "publication.cjs");
  writeFileSync(preload, `const fs=require('node:fs'); const original=fs.linkSync; fs.linkSync=function(from,to){ if(to.endsWith('/result.json')) { fs.writeFileSync(${JSON.stringify(barrier)},JSON.stringify({from,to})); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); } return original.apply(this,arguments); }; require('node:module').syncBuiltinESMExports();`);
  const wrapper = spawn(node, ["--require", preload, script, dest, "--", node, "-e", "process.stdout.write('completed command')"]);
  const done = once(wrapper, "close");
  try {
    await waitFor(() => existsSync(barrier));
    expect(json(barrier).to).toBe(join(dest, "result.json"));
    expect(json(json(barrier).from)).toMatchObject({ kind: "exited", code: 0 });
    expect(existsSync(join(dest, "result.json"))).toBe(false);
    wrapper.kill("SIGKILL");
    expect((await done)[1]).toBe("SIGKILL");
    expect(existsSync(join(dest, "result.json"))).toBe(false);
    expect(readFileSync(join(dest, "stdout.bin"), "utf8")).toBe("completed command");
  } finally {
    wrapper.kill("SIGKILL");
  }
}), 8000);

test("Node output write failure kills and reaps its command and leaves incomplete evidence", () => fixture(async (root, dest) => {
  const ready = join(root, "ready");
  const preload = join(root, "write-error.cjs");
  writeFileSync(preload, `const fs=require('node:fs'); const original=fs.createWriteStream; fs.createWriteStream=function(path,options){ const stream=original.call(this,path,options); if(path.endsWith('/stdout.bin')) stream._write=(_chunk,_encoding,done)=>done(new Error('fixture write failure')); return stream; }; require('node:module').syncBuiltinESMExports();`);
  const source = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); process.stdout.write('trigger'); setInterval(()=>{},1000)`;
  const childFile = join(root, "child.cjs");
  writeFileSync(childFile, source);
  const wrapper = spawn(node, ["--require", preload, script, dest, "--", "sh", "-c", 'trap "" TERM; "$1" "$2" & wait', "sh", node, childFile]);
  const done = once(wrapper, "close");
  try {
    expect((await done)[0]).toBe(125);
    expect(json(join(dest, "result.json"))).toMatchObject({ kind: "incomplete", reason: "capture-error", error: "fixture write failure" });
    expect(alive(Number(readFileSync(ready, "utf8")))).toBe(false);
  } finally {
    wrapper.kill("SIGKILL");
    if (existsSync(ready)) kill(Number(readFileSync(ready, "utf8")));
  }
}), 8000);

test("Node refuses to replace a result created before final publication", () => fixture((root, dest) => {
  const preload = join(root, "collision.cjs");
  const signals = join(root, "signals.jsonl");
  writeFileSync(preload, `const fs=require('node:fs'); process.kill=(pid,signal)=>fs.appendFileSync(${JSON.stringify(signals)},JSON.stringify({pid,signal})+'\\n'); const original=fs.linkSync; fs.linkSync=function(from,to){ fs.writeFileSync(to,'existing final result',{flag:'wx'}); return original.apply(this,arguments); }; require('node:module').syncBuiltinESMExports();`);
  const outcome = spawnSync(node, ["--require", preload, script, dest, "--", node, "-e", "process.stdout.write('saved bytes')"]);
  expect(outcome.status).toBe(125);
  expect(readFileSync(join(dest, "result.json"), "utf8")).toBe("existing final result");
  expect(readFileSync(join(dest, "stdout.bin"), "utf8")).toBe("saved bytes");
  expect(existsSync(signals) ? readFileSync(signals, "utf8") : "").toBe("");
}));
