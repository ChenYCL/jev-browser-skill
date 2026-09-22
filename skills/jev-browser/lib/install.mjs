// Install the skill into the places each agent looks, and register the MCP
// server for hosts without a shell (Claude Desktop). Every edit makes a backup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, ensureDir } from "./util.mjs";
import { saveUserConfig, userConfigPath } from "./config.mjs";

export const SKILL_NAME = "jev-browser";
export const DEFAULT_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function targetDefinitions({ home = os.homedir(), skillDir = DEFAULT_SKILL_DIR } = {}) {
  const bin = path.join(skillDir, "bin", "jev-browser.mjs");
  const desktopConfig =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
        : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  return [
    { id: "claude-code", kind: "skill-dir", label: "Claude Code personal skill", dest: path.join(home, ".claude", "skills", SKILL_NAME) },
    { id: "codex", kind: "skill-dir", label: "Codex CLI skill", dest: path.join(home, ".codex", "skills", SKILL_NAME) },
    { id: "agents", kind: "skill-dir", label: "skills.sh shared dir (Codex, opencode, Gemini CLI, …)", dest: path.join(home, ".agents", "skills", SKILL_NAME) },
    { id: "cursor", kind: "skill-dir", label: "Cursor skill", dest: path.join(home, ".cursor", "skills", SKILL_NAME) },
    { id: "claude-desktop", kind: "mcp-json", label: "Claude Desktop MCP server", dest: desktopConfig, bin },
    { id: "cursor-mcp", kind: "mcp-json", label: "Cursor MCP server", dest: path.join(home, ".cursor", "mcp.json"), bin },
    { id: "codex-mcp", kind: "mcp-toml", label: "Codex MCP server", dest: path.join(home, ".codex", "config.toml"), bin },
  ];
}

export const DEFAULT_TARGETS = ["claude-code", "codex", "agents", "cursor", "claude-desktop"];

async function pathState(dest) {
  try {
    const stat = await fs.lstat(dest);
    if (stat.isSymbolicLink()) return { exists: true, kind: "symlink", link: await fs.readlink(dest) };
    return { exists: true, kind: stat.isDirectory() ? "dir" : "file" };
  } catch {
    return { exists: false };
  }
}

async function backup(file) {
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  const copy = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(file, copy);
  return copy;
}

/** Remove a TOML table (header line through the line before the next header). */
export function removeTomlTable(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  lines.splice(start, end - start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function mcpServerEntry(bin) {
  return { command: process.execPath, args: [bin, "mcp"] };
}

/** Probe or apply installation for the given targets. */
export async function installTargets({ targets = DEFAULT_TARGETS, home = os.homedir(), skillDir = DEFAULT_SKILL_DIR, dryRun = false, copy = false, uninstall = false, probe = false, env = process.env } = {}) {
  const defs = targetDefinitions({ home, skillDir });
  const chosen = probe ? defs : defs.filter((d) => targets.includes(d.id));
  const unknown = targets.filter((t) => !defs.some((d) => d.id === t));
  if (!probe && unknown.length) throw new Error(`unknown install targets: ${unknown.join(", ")} (known: ${defs.map((d) => d.id).join(", ")})`);
  const results = [];
  for (const def of chosen) {
    const row = { id: def.id, label: def.label, dest: def.dest, action: "none", installed: false, detail: "" };
    try {
      if (def.kind === "skill-dir") {
        const state = await pathState(def.dest);
        const pointsHere = state.kind === "symlink" && path.resolve(path.dirname(def.dest), state.link) === path.resolve(skillDir);
        row.installed = state.exists && (pointsHere || state.kind === "dir");
        row.detail = state.exists ? `${state.kind}${pointsHere ? " → this skill" : state.kind === "symlink" ? ` → ${state.link}` : ""} at ${def.dest}` : `not installed (${def.dest})`;
        if (probe) {
          results.push(row);
          continue;
        }
        if (uninstall) {
          if (state.exists) {
            row.action = dryRun ? "would remove" : "removed";
            if (!dryRun) await fs.rm(def.dest, { recursive: true, force: true });
          }
          row.installed = false;
        } else if (pointsHere && !copy) {
          row.action = "already linked";
        } else {
          row.action = dryRun ? (copy ? "would copy" : "would link") : copy ? "copied" : "linked";
          if (!dryRun) {
            await ensureDir(path.dirname(def.dest));
            if (state.exists) await fs.rm(def.dest, { recursive: true, force: true });
            if (copy) await fs.cp(skillDir, def.dest, { recursive: true, filter: (src) => !src.includes("node_modules") });
            else await fs.symlink(skillDir, def.dest, "dir");
          }
          row.installed = !dryRun;
          row.detail = `${copy ? "copy" : "symlink"} at ${def.dest}`;
        }
      } else if (def.kind === "mcp-json") {
        const json = (await readJson(def.dest, null)) ?? {};
        const servers = json.mcpServers ?? {};
        const existing = servers[SKILL_NAME];
        row.installed = Boolean(existing);
        row.detail = existing ? `registered in ${def.dest}` : `not registered (${def.dest})`;
        if (probe) {
          results.push(row);
          continue;
        }
        if (uninstall) {
          if (existing) {
            row.action = dryRun ? "would unregister" : "unregistered";
            if (!dryRun) {
              row.backup = await backup(def.dest);
              delete servers[SKILL_NAME];
              await writeJson(def.dest, { ...json, mcpServers: servers });
            }
          }
          row.installed = false;
        } else {
          const entry = mcpServerEntry(def.bin);
          const same = existing && existing.command === entry.command && JSON.stringify(existing.args) === JSON.stringify(entry.args);
          row.action = same ? "already registered" : dryRun ? "would register" : "registered";
          if (!same && !dryRun) {
            row.backup = await backup(def.dest);
            await writeJson(def.dest, { ...json, mcpServers: { ...servers, [SKILL_NAME]: entry } });
          }
          row.installed = same || !dryRun;
          row.detail = `mcpServers.${SKILL_NAME} in ${def.dest}`;
        }
      } else if (def.kind === "mcp-toml") {
        let text = "";
        try {
          text = await fs.readFile(def.dest, "utf8");
        } catch {
          text = "";
        }
        const header = `[mcp_servers.${SKILL_NAME}]`;
        const has = text.includes(header);
        row.installed = has;
        row.detail = has ? `registered in ${def.dest}` : `not registered (${def.dest})`;
        if (probe) {
          results.push(row);
          continue;
        }
        if (uninstall) {
          if (has) {
            row.action = dryRun ? "would unregister" : "unregistered";
            if (!dryRun) {
              row.backup = await backup(def.dest);
              await fs.writeFile(def.dest, removeTomlTable(text, header));
            }
          }
          row.installed = false;
        } else if (has) {
          row.action = "already registered";
        } else {
          row.action = dryRun ? "would register" : "registered";
          if (!dryRun) {
            row.backup = await backup(def.dest);
            const entry = mcpServerEntry(def.bin);
            const block = `\n${header}\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nstartup_timeout_sec = 60\n`;
            await ensureDir(path.dirname(def.dest));
            await fs.writeFile(def.dest, `${text.replace(/\s*$/, "\n")}${block}`);
          }
          row.installed = !dryRun;
        }
      }
    } catch (error) {
      row.action = "error";
      row.error = error.message;
    }
    results.push(row);
  }

  // MCP hosts start the server without the shell environment: persist the key once.
  let keyNote = null;
  const wantsMcp = !probe && !uninstall && chosen.some((d) => d.kind !== "skill-dir");
  if (wantsMcp) {
    const cfgFile = userConfigPath(home);
    const cfg = (await readJson(cfgFile, null)) ?? {};
    if (cfg.apiKey) keyNote = `API key already stored in ${cfgFile}`;
    else if (env.TYPESAFE_API_KEY) {
      if (!dryRun) await saveUserConfig({ apiKey: env.TYPESAFE_API_KEY }, { home });
      keyNote = `${dryRun ? "would store" : "stored"} TYPESAFE_API_KEY from the environment in ${cfgFile} (mode 0600) so MCP hosts can use it`;
    } else keyNote = `no API key available for MCP hosts: export TYPESAFE_API_KEY and run "jev-browser config set-key --from-env"`;
  }
  return probe ? results : { results, keyNote, skillDir };
}

export function formatInstall({ results, keyNote, skillDir }) {
  const lines = [`skill source: ${skillDir}`, ""];
  for (const r of results) {
    lines.push(`${r.action === "error" ? "✘" : r.installed ? "✔" : "•"} ${r.id.padEnd(15)} ${r.action.padEnd(19)} ${r.detail}${r.backup ? ` (backup: ${r.backup})` : ""}${r.error ? ` — ${r.error}` : ""}`);
  }
  if (keyNote) lines.push("", keyNote);
  lines.push(
    "",
    "Claude Code plugin alternative: claude plugin marketplace add <path-or-github-repo> && claude plugin install jev-browser@jev-browser-skill",
    "Restart Claude Desktop / Cursor / Codex after registering the MCP server.",
  );
  return lines.join("\n");
}
