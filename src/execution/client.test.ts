import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ExecdClient } from "./client.js";

test("aborting a command closes its HTTP stream", async (t) => {
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the command */ }
    res.on("close", disconnected);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: stdout\ndata: {"chunk":"started"}\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new ExecdClient({ port: 8765, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const controller = new AbortController();
  await assert.rejects(client.run("long-running", {
    signal: controller.signal,
    onEvent: () => controller.abort(),
  }), /abort/i);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("stream stayed open")), 2000); timer.unref(); })]);
});

test("a truncated command stream is an error, never a successful result", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: stdout\ndata: {"chunk":"partial output"}\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new ExecdClient({ port: 8765, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  await assert.rejects(client.run("unfinished"), /without an exit event/);
});
