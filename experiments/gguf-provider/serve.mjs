#!/usr/bin/env node
// EXPERIMENTAL — not part of the jev-browser skill.
// Serves the TypeSafe/Jev `/v1/systemone` contract from a local llama.cpp server, so the
// real skill can be pointed at it with TYPESAFE_BASE_URL (zero Python, zero npm deps).
//
//   node experiments/gguf-provider/serve.mjs --port 8092 --url http://127.0.0.1:8090
//   TYPESAFE_API_KEY=local TYPESAFE_BASE_URL=http://127.0.0.1:8092 \
//     node skills/jev-browser/bin/jev-browser.mjs judge --state-file s.json --questions-file q.json --json
import { createServer } from "node:http";
import { validateQuestions } from "../../skills/jev-browser/lib/typesafe.mjs";
import { GgufProvider } from "./lib/provider.mjs";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);

const port = Number(arg("--port", 8092));
const provider = new GgufProvider({
  url: arg("--url", "http://127.0.0.1:8090"),
  model: arg("--model", "gguf-local"),
  ending: arg("--ending", "answer"),
  nProbs: Number(arg("--n-probs", 512)),
  verbose: process.argv.includes("--verbose"),
});

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) reject(new Error("body too large"));
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const server = createServer(async (req, res) => {
  const started = performance.now();
  try {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/health/live")) {
      return json(res, 200, { status: (await provider.health()) ? "ok" : "backend-down" });
    }
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      return json(res, 200, {
        object: "list",
        data: [{ id: provider.model, object: "model", created: 0, owned_by: "local-llama.cpp", typesafe: { name: provider.model, modalities: ["text"] } }],
      });
    }
    if (req.method !== "POST" || !req.url.startsWith("/v1/systemone")) return json(res, 404, { error: { message: "not found" } });

    const body = JSON.parse(await readBody(req));
    validateQuestions(body.questions); // same check the real client runs client-side
    const response = await provider.systemOne({ state: body.state, questions: body.questions, model: body.model ?? provider.model });
    const ms = Math.round(performance.now() - started);
    process.stderr.write(`[serve] systemone ${Object.keys(body.questions).length} questions -> ${ms}ms\n`);
    return json(res, 200, { ...response, usage: { ...response.usage, ms_wall: ms } });
  } catch (error) {
    const status = error.code === "INVALID_QUESTIONS" ? 422 : 500;
    process.stderr.write(`[serve] error: ${error.message}\n`);
    return json(res, status, { error: { message: error.message, code: error.code ?? "PROVIDER_ERROR" } });
  }
});

server.listen(port, "127.0.0.1", async () => {
  const ok = await provider.health();
  process.stderr.write(`[serve] listening on http://127.0.0.1:${port} (llama-server ${ok ? "ok" : "NOT reachable"})\n`);
});
