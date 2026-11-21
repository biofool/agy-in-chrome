// Shared harness for ownership.test.mjs: fake extension, fake MCP client,
// bridge probe and a tiny sequential test registry. Split out of the test
// file to keep both under the 250-line lint limit.
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOST = path.join(HERE, "..", "native-host.js");
export const SESSION = path.join(HERE, "runtime-client.mjs");

export let seq = 0;
let PIPE = "";

export const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-test-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-test-${process.pid}-${n}.sock`);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Fake extension: drives native-host.js exactly as Chrome would ---

export function fakeExtension(pipe = PIPE) {
  const proc = spawn(process.execPath, [HOST], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const handlers = [];
  const stderr = [];
  let buf = Buffer.alloc(0);

  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
      buf = buf.subarray(4 + len);
      for (const h of handlers) h(msg);
    }
  });
  proc.stderr.on("data", (c) => stderr.push(c.toString()));

  return {
    proc,
    stderrText: () => stderr.join(""),
    onMessage: (cb) => handlers.push(cb),
    send(msg) {
      const body = Buffer.from(JSON.stringify(msg), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      proc.stdin.write(Buffer.concat([header, body]));
    },
    // Answer every tool_request with a result derived from the request, so a
    // client can prove it got back its OWN response and not someone else's.
    autoRespond(transform = (m) => ({ echo: m.tool, args: m.args })) {
      handlers.push((msg) => {
        if (msg.type === "tool_request") {
          this.send({ id: msg.id, result: transform(msg) });
        }
      });
    },
    kill: () => proc.kill(),
    // Close stdin the way Chrome does when the extension disconnects.
    disconnect: () => proc.stdin.end()
  };
}

// --- Fake MCP client: the wire role tool-runtime.js plays ---

export function fakeClient(pipe, name) {
  const socket = net.createConnection(pipe);
  const pending = new Map();
  const received = [];
  let idc = 0;
  let buf = Buffer.alloc(0);
  let closed = false;

  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
  });
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(10)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf-8").trim();
      buf = buf.subarray(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      received.push(msg);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const ready = new Promise((resolve) => {
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "client_hello" }) + "\n");
      resolve();
    });
  });

  return {
    name,
    ready,
    isClosed: () => closed,
    received,
    call(tool, args = {}, timeoutMs = 3000) {
      const id = String(++idc);
      socket.write(
        JSON.stringify({ id, type: "tool_request", tool, args }) + "\n"
      );
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${name}: ${tool} timed out`));
          }
        }, timeoutMs);
      });
    },
    // Vanish without a FIN, the way a force-killed session's socket does.
    hardKill: () => socket.destroy(),
    close: () => socket.end()
  };
}

// Is anyone serving the bridge? Only a live listener accepts, so this cannot be
// fooled by a leftover socket path.
export function bridgeIsHeld(pipe) {
  return new Promise((resolve) => {
    const probe = net.createConnection(pipe);
    const done = (v) => {
      probe.destroy();
      resolve(v);
    };
    probe.on("connect", () => done(true));
    probe.on("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}

export async function waitFor(fn, timeoutMs = 5000, label = "condition") {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(50);
  }
}

// --- Test registry ---

export const results = [];
export async function test(name, fn) {
  PIPE = pipeFor(++seq); // every test gets its own address
  const started = Date.now();
  try {
    await fn(PIPE);
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}  (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}  — ${err.message}`);
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
