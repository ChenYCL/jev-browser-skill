#!/usr/bin/env node
// jev-webui — the local WebUI for jev-browser: the three judging tiers, the effective config,
// doctor, the local model registry, a judge playground and a run launcher in one browser page.
//
// It is a view over the existing lib/, not a second implementation: the page is served by Node's
// own http server, bound to 127.0.0.1 only (never 0.0.0.0, so nothing here is on the LAN), and it
// reads and writes the same ~/.config/jev-browser/config.json the CLI uses.
//
//   node skills/jev-browser/bin/jev-webui.mjs
//   node skills/jev-browser/bin/jev-webui.mjs --port 9000 --open
//
// The URL is the only thing on stdout, so it can be piped; everything else goes to stderr.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { userConfigPath } from "../lib/config.mjs";
import { DEFAULT_WEBUI_PORT, WebUiError, createWebUiServer, listenWebUi, openBrowser, parsePort } from "../lib/webui.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `jev-webui ${VERSION} — local WebUI for jev-browser (tiers, config, doctor, models, judge, run)

Usage:
  jev-webui [--port ${DEFAULT_WEBUI_PORT}] [--open] [-q]

  Serves one page on 127.0.0.1 and does everything the CLI does, from a browser:
    Tiers    the three judging tiers, what a run would use right now, and start/stop for the two
             local servers (their output is streamed into the page, so a download is visible)
    Config   the effective configuration with its sources; edits go to ~/.config/jev-browser/config.json
    Doctor   the same checks as \`jev-browser doctor\`, live or offline
    Models   the local registry (lib/local-models.json): what is downloaded, what is serving
    Judge    one System One request against the configured endpoint, with the answers rendered
    Run      a real run (\`jev-browser run --json\`), with live progress and the per-step journal

  Loopback only. The page never receives your API key, and every command is spawned with an argv
  array — the WebUI cannot be talked into running something else.

options:
  --port N        bind 127.0.0.1:N (default ${DEFAULT_WEBUI_PORT}; 1024..65535)
  --open          open the page in your default browser (best effort)
  -q, --quiet     no banner on stderr; the URL is still printed
  -h, --help      this text
  -v, --version   print the version

Exit codes: 0 ok, 2 bad usage or the port is taken.
`;

const OPTIONS = {
  port: { type: "string" },
  open: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

function banner(url, skillDir) {
  return [
    `jev-webui ${VERSION} — local WebUI for jev-browser`,
    `  url      ${url}`,
    "  bind     127.0.0.1 only — not reachable from your network, no LAN exposure",
    `  config   ${userConfigPath()} (the same file the CLI reads and writes)`,
    `  scripts  ${skillDir}/bin/{jev-browser,jev-local,jev-kev}.mjs, spawned with an argv array`,
    "  Ctrl-C stops the page and any local model server it started.",
  ].join("\n");
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let port;
  try {
    port = values.port === undefined ? DEFAULT_WEBUI_PORT : parsePort(values.port, { name: "--port", min: 1024, max: 65535 });
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }

  const log = values.quiet ? () => {} : (message) => process.stderr.write(`${message}\n`);
  const ui = createWebUiServer({ log });
  let address;
  try {
    address = await listenWebUi(ui.server, { port });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(`error: port ${port} is already in use — start it with another one: jev-webui --port <other>\n`);
      return 2;
    }
    if (error.code === "EACCES") {
      process.stderr.write(`error: port ${port} needs root — pick a port above 1023\n`);
      return 2;
    }
    throw error;
  }

  const url = ui.url(address.port);
  process.stdout.write(`${url}\n`);
  if (!values.quiet) process.stderr.write(`${banner(url, SKILL_DIR)}\n`);
  if (values.open) openBrowser(url);

  let stopping = false;
  await new Promise((resolve) => {
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (!values.quiet) process.stderr.write("\nstopping…\n");
      ui.close().then(() => resolve(), () => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = error instanceof WebUiError ? 2 : 1;
}
