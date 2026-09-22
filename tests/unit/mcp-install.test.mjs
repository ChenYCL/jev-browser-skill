import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { handleMessage, TOOLS } from "../../skills/jev-browser/lib/mcp.mjs";
import { installTargets, targetDefinitions } from "../../skills/jev-browser/lib/install.mjs";
import { createMockTypeSafe } from "../helpers/mock-typesafe.mjs";
import { BIN, ROOT } from "../helpers/env.mjs";

test("MCP handshake, tool listing and error shapes", async () => {
  const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "jev-browser");
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.ok(TOOLS.every((t) => t.inputSchema.type === "object"));
  const unknown = await handleMessage({ jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(unknown.error.code, -32601);
  const badTool = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
  assert.equal(badTool.error.code, -32602);
});

test("MCP server over stdio answers jev_judge and jev_pick through a mock TypeSafe", async (t) => {
  const mock = createMockTypeSafe();
  await mock.listen();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-mcp-home-"));
  const child = spawn(process.execPath, [BIN, "mcp"], { env: { ...process.env, HOME: home, TYPESAFE_API_KEY: "mock-key-1234567890", TYPESAFE_BASE_URL: mock.baseUrl }, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await mock.close().catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  });
  const responses = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) responses.push(JSON.parse(line));
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const waitFor = (id) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const tick = () => {
      const hit = responses.find((r) => r.id === id);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error(`no response for ${id}`));
      setTimeout(tick, 25);
    };
    tick();
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal((await waitFor(1)).result.protocolVersion, "2024-11-05");
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_judge", arguments: { state: "Please refund me", questions: { urgent: { type: "noul", instructions: "Is it urgent?" }, team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", tech: "bugs" } } } } } });
  const judged = await waitFor(2);
  assert.equal(judged.result.isError, false);
  assert.equal(judged.result.structuredContent.answers.urgent.type, "noul");
  assert.equal(judged.result.structuredContent.model, "jev-mock-1.0");
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "jev_pick", arguments: { question: "Which page shows plans and prices?", candidates: { pricing: "link 'Pricing' → /pricing", docs: "link 'Docs' → /docs" }, context: "goal: see pricing" } } });
  const picked = await waitFor(3);
  assert.equal(picked.result.isError, false);
  assert.ok(["pricing", "docs", "none"].includes(picked.result.structuredContent.choice));
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "jev_config", arguments: {} } });
  const cfg = await waitFor(4);
  assert.equal(cfg.result.structuredContent.config.baseUrl, mock.baseUrl);
  assert.equal(cfg.result.structuredContent.config.apiKey.includes("mock-key-1234567890"), false, "key masked");
  send({ jsonrpc: "2.0", id: 5, method: "ping" });
  assert.deepEqual((await waitFor(5)).result, {});
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
});

test("installer links skill dirs, registers MCP hosts, backs up and uninstalls (fake HOME)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jev-install-home-"));
  const skillDir = path.join(ROOT, "skills", "jev-browser");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "config.toml"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n');
  await fs.mkdir(path.join(home, "Library", "Application Support", "Claude"), { recursive: true });
  await fs.writeFile(path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), JSON.stringify({ mcpServers: { existing: { command: "z" } }, preferences: { a: 1 } }));

  const dry = await installTargets({ targets: ["claude-code", "claude-desktop", "codex-mcp"], home, skillDir, dryRun: true, env: { TYPESAFE_API_KEY: "k" } });
  assert.deepEqual(dry.results.map((r) => r.action), ["would link", "would register", "would register"]);
  assert.match(dry.keyNote, /would store/);

  const all = targetDefinitions({ home, skillDir }).map((d) => d.id);
  const applied = await installTargets({ targets: all, home, skillDir, env: { TYPESAFE_API_KEY: "k" } });
  for (const r of applied.results) assert.notEqual(r.action, "error", `${r.id}: ${r.error}`);
  assert.equal(await fs.readlink(path.join(home, ".claude", "skills", "jev-browser")), skillDir);
  assert.equal(await fs.readlink(path.join(home, ".codex", "skills", "jev-browser")), skillDir);
  const desktop = JSON.parse(await fs.readFile(path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "utf8"));
  assert.deepEqual(desktop.mcpServers["jev-browser"].args, [path.join(skillDir, "bin", "jev-browser.mjs"), "mcp"]);
  assert.deepEqual(desktop.mcpServers.existing, { command: "z" });
  assert.deepEqual(desktop.preferences, { a: 1 });
  const toml = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.jev-browser\]/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  const cursor = JSON.parse(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers["jev-browser"]);
  const userCfg = JSON.parse(await fs.readFile(path.join(home, ".config", "jev-browser", "config.json"), "utf8"));
  assert.equal(userCfg.apiKey, "k");
  const backups = (await fs.readdir(path.join(home, ".codex"))).filter((f) => f.startsWith("config.toml.bak."));
  assert.equal(backups.length, 1);

  const again = await installTargets({ targets: all, home, skillDir, env: {} });
  assert.ok(again.results.every((r) => /already/.test(r.action)), JSON.stringify(again.results.map((r) => r.action)));

  const probe = await installTargets({ home, skillDir, probe: true });
  assert.ok(probe.every((r) => r.installed));

  const removed = await installTargets({ targets: all, home, skillDir, uninstall: true });
  assert.ok(removed.results.every((r) => /removed|unregistered/.test(r.action)), JSON.stringify(removed.results.map((r) => r.action)));
  await assert.rejects(fs.lstat(path.join(home, ".claude", "skills", "jev-browser")));
  const tomlAfter = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(tomlAfter, /jev-browser/);
  assert.match(tomlAfter, /\[mcp_servers\.other\]/);
  await fs.rm(home, { recursive: true, force: true });
});
