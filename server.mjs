/**
 * vita-sandbox HTTP server — receives requests from the control plane.
 *
 * Endpoints:
 *   POST /ingest  — write workspace files (USER.md, etc.)
 *   POST /unlock  — derive + hold decrypted user keys in enclave memory
 *   POST /invoke  — run the agent with a message, return response
 *   GET  /health  — liveness check
 *
 * Auth: all POST endpoints require Authorization: Bearer $SANDBOX_AUTH_SECRET
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  destroyKeySession,
  recoverKeySessionFromRows,
  unlockKeySessionFromRows,
} from "./decrypt.mjs";
import { buildAndWriteUserMarkdown } from "./fetch-health-data.mjs";

const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKSPACE = "/home/user/.openclaw/workspace";
const AUTH_SECRET = process.env.SANDBOX_AUTH_SECRET || "";
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB limit

// QMD URL from env only — never accept from request body (prevents SSRF)
const QMD_URL = process.env.QMD_GPU_URL || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const keySessions = new Map();

mkdirSync(WORKSPACE, { recursive: true });

function checkAuth(req) {
  if (!AUTH_SECRET) return true; // no secret configured = skip auth (dev only)
  const header = req.headers["authorization"] || "";
  return header === `Bearer ${AUTH_SECRET}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function workspacePath(name) {
  return resolve(join(WORKSPACE, name));
}

function writeWorkspaceFile(name, content) {
  const filePath = workspacePath(name);
  if (!filePath.startsWith(WORKSPACE)) {
    throw new Error("invalid workspace path");
  }
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content || "", "utf-8");
}

function ensureSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for encrypted health data access.");
  }
}

async function supabaseSelect(table, select, filters = {}, { order, limit } = {}) {
  ensureSupabaseConfig();

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  if (order) url.searchParams.set("order", order);
  if (limit) url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(`Supabase query failed for ${table}: ${response.status} ${text.slice(0, 240)}`);
  }

  return Array.isArray(payload) ? payload : [];
}

async function handleIngest(req, res) {
  const { files } = await readBody(req);
  if (!files || !Array.isArray(files)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "files[] required" }));
    return;
  }
  for (const f of files) {
    if (!f.name) continue;
    // Path traversal protection
    if (f.name.includes("..") || f.name.startsWith("/") || f.name.includes("\\")) continue;
    writeWorkspaceFile(f.name, f.content || "");
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, files: files.length }));
}

async function handleUnlock(req, res) {
  const body = await readBody(req);
  const { user_id, passphrase, recovery_key } = body;

  if (!user_id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "user_id required" }));
    return;
  }

  if (!passphrase && !recovery_key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "passphrase or recovery_key required" }));
    return;
  }

  try {
    const [existingSession, keyRows, categoryRows, recoveryRows] = await Promise.all([
      Promise.resolve(keySessions.get(user_id)),
      supabaseSelect("user_keys", "*", { user_id: `eq.${user_id}` }, { order: "key_version.desc", limit: 1 }),
      supabaseSelect("user_category_keys", "*", { user_id: `eq.${user_id}` }),
      recovery_key
        ? supabaseSelect("user_recovery_keys", "*", { user_id: `eq.${user_id}` }, { limit: 1 })
        : Promise.resolve([]),
    ]);

    if (existingSession) {
      await destroyKeySession(existingSession);
      keySessions.delete(user_id);
    }

    let session;
    if (passphrase) {
      session = await unlockKeySessionFromRows({
        passphrase,
        keyRow: keyRows[0],
        categoryRows,
      });
    } else {
      session = await recoverKeySessionFromRows({
        recoveryKey: recovery_key,
        recoveryRow: recoveryRows[0],
        categoryRows,
      });
    }

    keySessions.set(user_id, session);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      user_id,
      categories: [...session.categoryDEKs.keys()],
    }));
  } catch (err) {
    console.error("[unlock] Error:", err);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "unlock_failed" }));
  }
}

async function handleInvoke(req, res) {
  const body = await readBody(req);
  const { message, session_id, user_id, supermemory } = body;

  if (!message || !user_id) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message and user_id required" }));
    return;
  }

  const keySession = keySessions.get(user_id);
  if (!keySession) {
    res.writeHead(423, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "unlock_required",
      message: "Health data vault is locked. Call /unlock before invoking the agent.",
    }));
    return;
  }

  try {
    await buildAndWriteUserMarkdown({
      userId: user_id,
      keySession,
      supermemory,
    });
  } catch (err) {
    console.error("[invoke] Failed to build USER.md:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "context_build_failed", message: err.message }));
    return;
  }

  // QMD URL from env only (not from request body — prevents SSRF)
  const input = JSON.stringify({ message, session_id, user_id, qmd_url: QMD_URL });
  const result = spawnSync("node", ["/app/run-agent.mjs"], {
    env: { ...process.env, AGENT_INPUT: input, HOME: "/home/user" },
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = result.stdout?.toString() || "";
  const stderr = result.stderr?.toString() || "";

  if (stderr) console.error("[invoke] stderr:", stderr.slice(0, 1000));

  let output;
  try { output = JSON.parse(stdout); }
  catch { output = { raw: stdout }; }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(output));
}

function handleHealth(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    uptime: process.uptime(),
    unlockedUsers: keySessions.size,
  }));
}

async function wipeAllKeySessions() {
  const sessions = [...keySessions.entries()];
  for (const [userId, session] of sessions) {
    try {
      await destroyKeySession(session);
    } catch (err) {
      console.error("[server] Failed to destroy session:", userId, err);
    }
    keySessions.delete(userId);
  }
}

const server = createServer(async (req, res) => {
  try {
    // Health is unauthenticated
    if (req.method === "GET" && req.url === "/health") return handleHealth(req, res);

    // All POST endpoints require auth
    if (req.method === "POST") {
      if (!checkAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.url === "/ingest") return await handleIngest(req, res);
      if (req.url === "/unlock") return await handleUnlock(req, res);
      if (req.url === "/invoke") return await handleInvoke(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    console.error("[server] Error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`[server] vita-sandbox listening on :${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await wipeAllKeySessions();
    process.exit(0);
  });
}
