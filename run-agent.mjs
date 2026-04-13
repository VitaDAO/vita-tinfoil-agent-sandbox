/**
 * VITA Agent Runner — one-shot script inside E2B sandbox
 *
 * Called by the bot via: sandbox.commands.run("node /app/run-agent.mjs")
 *
 * Input: JSON from AGENT_INPUT env var { message, session_id, user_id, qmd_url }
 * Output: JSON on stdout (OpenClaw's --json output + timings)
 *
 * Flow:
 *   1. Ingest workspace files + daily logs to QMD (index for search)
 *   2. Search QMD with user's message → append results to USER.md (bootstrap file)
 *   3. Run OpenClaw agent (reads bootstrap files including USER.md with health data + QMD context)
 *   4. Sync daily logs back to QMD (post-agent)
 *   5. Output JSON result
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_DIR = "/home/user/.openclaw/workspace";
const MEMORY_DIR = join(WORKSPACE_DIR, "memory");

// Parse input from env var (preferred) or CLI arg (legacy)
const input = JSON.parse(process.env.AGENT_INPUT || process.argv[2] || "{}");
const { message, session_id, user_id, qmd_url } = input;

if (!message) {
  process.stdout.write(JSON.stringify({ error: true, message: "No message provided" }));
  process.exit(1);
}

const timings = {};
const startTime = Date.now();

// Step 0: Ensure workspace directories exist
mkdirSync(WORKSPACE_DIR, { recursive: true });
mkdirSync(MEMORY_DIR, { recursive: true });

// Step 1: Collect memory files for QMD ingestion + search
// Per-message: only ingest MEMORY.md + memory/*.md (matches OpenClaw's native memorySearch scope).
// All other workspace files are bootstrap files already in the agent's system prompt — ingesting
// them would be duplication. Full workspace sync happens during flush (pre-rebuild) and nightly
// consolidation (4 AM) via the bot.
function collectFiles() {
  const files = [];

  // MEMORY.md — agent-owned learned facts
  try {
    const memoryPath = join(WORKSPACE_DIR, "MEMORY.md");
    if (existsSync(memoryPath)) {
      const content = readFileSync(memoryPath, "utf-8");
      files.push({ name: "MEMORY.md", content });
    }
  } catch (err) {
    console.error("Failed to read MEMORY.md:", err.message);
  }

  // memory/*.md — daily logs
  try {
    if (existsSync(MEMORY_DIR)) {
      for (const name of readdirSync(MEMORY_DIR)) {
        if (name.endsWith(".md")) {
          const content = readFileSync(join(MEMORY_DIR, name), "utf-8");
          files.push({ name: `memory/${name}`, content });
        }
      }
    }
  } catch (err) {
    console.error("Failed to read memory files:", err.message);
  }

  return files;
}

const workspaceFiles = collectFiles();

// Step 2: Call external QMD GPU for indexing + search
const qmdHeaders = { "Content-Type": "application/json" };
if (process.env.QMD_API_SECRET) qmdHeaders["x-api-secret"] = process.env.QMD_API_SECRET;

let qmdResults = [];
if (qmd_url && user_id && workspaceFiles.length > 0) {
  // Ingest (index workspace + daily logs for search)
  const ingestStart = Date.now();
  try {
    const ingestRes = await fetch(qmd_url + "/ingest", {
      method: "POST",
      headers: qmdHeaders,
      body: JSON.stringify({ user_id, files: workspaceFiles }),
    });
    if (!ingestRes.ok) console.error("QMD ingest failed:", ingestRes.status);
  } catch (err) {
    console.error("QMD ingest error:", err.message);
  }
  timings.qmdIngest = Date.now() - ingestStart;

  // Search
  const searchStart = Date.now();
  try {
    const searchRes = await fetch(qmd_url + "/predict", {
      method: "POST",
      headers: qmdHeaders,
      body: JSON.stringify({ user_id, query: message, limit: 5 }),
    });
    if (searchRes.ok) {
      const data = await searchRes.json();
      qmdResults = data.results || [];
    }
  } catch (err) {
    console.error("QMD search error:", err.message);
  }
  timings.qmdSearch = Date.now() - searchStart;
} else {
  timings.qmdIngest = 0;
  timings.qmdSearch = 0;
}

// Step 3: Append QMD results to USER.md (bootstrap file — always in agent system prompt)
// Appending to USER.md avoids session transcript bloat that --message injection causes.
// USER.md is rewritten fresh by the bot every message, so QMD results don't accumulate.
if (qmdResults.length > 0) {
  const userMdPath = join(WORKSPACE_DIR, "USER.md");
  if (existsSync(userMdPath)) {
    let ctx = "\n\n# Relevant Context from Memory\n\n";
    for (const r of qmdResults) {
      ctx += `## ${r.title || r.displayPath || "Context"}\n`;
      ctx += `${r.bestChunk || r.body}\n\n`;
    }
    const existing = readFileSync(userMdPath, "utf-8");
    writeFileSync(userMdPath, existing + ctx, "utf-8");
  }
}
timings.qmdTotal = timings.qmdIngest + timings.qmdSearch;

// Step 4: Start OpenClaw gateway (needed for tools like cron, hooks, memory)
const sid = session_id || "vita-" + Date.now();
const agentEnv = { ...process.env, HOME: "/home/user" };

// Check if gateway is already running (sandbox may have been resumed)
let gwReady = false;
try {
  execSync("openclaw gateway health", { env: agentEnv, timeout: 3000, stdio: "pipe" });
  gwReady = true;
} catch { /* not running */ }

if (!gwReady) {
  const { spawn } = await import("node:child_process");
  const gw = spawn("openclaw", ["gateway", "run"], {
    env: agentEnv,
    detached: true,
    stdio: "ignore",
  });
  gw.unref();

  // Start cron delivery watcher (posts cron results to Railway webhook)
  const watcher = spawn("node", ["/app/cron-watcher.js"], {
    env: agentEnv,
    detached: true,
    stdio: "ignore",
  });
  watcher.unref();

  // Wait for gateway to be ready
  for (let i = 0; i < 10; i++) {
    try {
      execSync("openclaw gateway health", { env: agentEnv, timeout: 3000, stdio: "pipe" });
      gwReady = true;
      break;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
}
if (!gwReady) console.error("Gateway failed to start — tools may not work");

// Step 5: Run OpenClaw agent
const agentStart = Date.now();

try {
  const { spawnSync } = await import("node:child_process");
  const agentResult = spawnSync(
    "openclaw",
    ["agent", "--thinking", "low", "--session-id", sid, "--message", message, "--json"],
    {
      timeout: 90000,
      maxBuffer: 10 * 1024 * 1024,
      env: agentEnv,
    }
  );
  const result = agentResult.stdout;
  if (agentResult.stderr && agentResult.stderr.length > 0) {
    console.error(agentResult.stderr.toString());
  }
  timings.agent = Date.now() - agentStart;

  // Step 5: Post-agent sync — send updated daily logs back to QMD
  const postSyncStart = Date.now();
  if (qmd_url && user_id) {
    const postFiles = [];
    // Sync MEMORY.md (agent may have written to it during this turn)
    try {
      const memoryPath = join(WORKSPACE_DIR, "MEMORY.md");
      if (existsSync(memoryPath)) {
        const content = readFileSync(memoryPath, "utf-8");
        postFiles.push({ name: "MEMORY.md", content });
      }
    } catch (err) {
      console.error("Failed to read MEMORY.md for post-sync:", err.message);
    }
    // Sync daily logs (memory/*.md)
    try {
      if (existsSync(MEMORY_DIR)) {
        for (const name of readdirSync(MEMORY_DIR)) {
          if (name.endsWith(".md")) {
            const content = readFileSync(join(MEMORY_DIR, name), "utf-8");
            postFiles.push({ name: `memory/${name}`, content });
          }
        }
      }
    } catch (err) {
      console.error("Failed to read post-agent memory files:", err.message);
    }

    if (postFiles.length > 0) {
      try {
        const syncRes = await fetch(qmd_url + "/ingest", {
          method: "POST",
          headers: qmdHeaders,
          body: JSON.stringify({ user_id, files: postFiles }),
        });
        if (!syncRes.ok) console.error("QMD post-sync failed:", syncRes.status);
      } catch (err) {
        console.error("QMD post-sync error:", err.message, err.cause ? `cause: ${err.cause.message || err.cause}` : "");
      }
    }
  }
  timings.postSync = Date.now() - postSyncStart;
  timings.total = Date.now() - startTime;

  let agentOutput;
  try {
    const parsed = JSON.parse(result.toString());
    // Gateway mode wraps in { runId, status, result: { payloads, meta } }
    // Local mode returns { payloads, meta } directly
    agentOutput = parsed.result || parsed;
  } catch {
    agentOutput = { raw: result.toString() };
  }

  process.stdout.write(JSON.stringify({
    ...agentOutput,
    timings,
    qmdResults: qmdResults.length,
  }));
} catch (err) {
  timings.agent = Date.now() - agentStart;
  timings.total = Date.now() - startTime;

  process.stdout.write(JSON.stringify({
    error: true,
    message: "Agent failed: " + (err.stderr ? err.stderr.toString() : err.message),
    timings,
  }));
  process.exit(1);
}
