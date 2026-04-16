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

import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

import {
  destroyKeySession,
  recoverKeySessionFromRows,
  unlockKeySessionFromRows,
  unlockKeySessionFromDEK,
  fromHex,
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

// ── DEK persistence helpers ──
// Encrypt DEK with SANDBOX_AUTH_SECRET before storing in Supabase
function getDekEncryptionKey() {
  return createHash("sha256").update(AUTH_SECRET).digest(); // 32 bytes
}

function encryptDekForStorage(dekBytes) {
  const key = getDekEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(dekBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(nonce + ciphertext + tag)
  return Buffer.concat([nonce, encrypted, tag]).toString("base64");
}

function decryptDekFromStorage(storedBase64) {
  const key = getDekEncryptionKey();
  const data = Buffer.from(storedBase64, "base64");
  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

// Container owner — set via env var, identifies which user this sandbox belongs to
const SANDBOX_USER_ID = process.env.SANDBOX_USER_ID || "";

async function persistDek(userId, dekBytes) {
  const encrypted = encryptDekForStorage(dekBytes);
  const ok = await supabaseUpsert("sandbox_dek_grants", {
    user_id: userId,
    encrypted_dek: encrypted,
    updated_at: new Date().toISOString(),
  });
  return ok;
}

async function loadPersistedDek(userId) {
  const rows = await supabaseSelectAgents("sandbox_dek_grants", "*",
    { user_id: `eq.${userId}` }, { limit: 1 });
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (!row.encrypted_dek) return null;
  return decryptDekFromStorage(row.encrypted_dek);
}

async function supabaseSelectAgents(table, select, filters = {}, options = {}) {
  return queryRows(table, { select, filters, ...options, schema: "agents" });
}

async function queryRows(table, { select = "*", filters = {}, order, limit, schema } = {}) {
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
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
  if (schema && schema !== "public") {
    headers["Accept-Profile"] = schema;
  }
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function supabaseUpsert(table, data) {
  ensureSupabaseConfig();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "agents",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`[dek-persist] Upsert failed: ${response.status} ${text.slice(0, 200)}`);
    return false;
  }
  return true;
}

// Auto-unlock on boot: restore ONLY this container's user's DEK
async function autoUnlockFromPersistedDek() {
  if (!SANDBOX_USER_ID) {
    console.log("[auto-unlock] No SANDBOX_USER_ID set — skipping auto-unlock");
    return;
  }
  try {
    const rows = await supabaseSelectAgents("sandbox_dek_grants", "*",
      { user_id: `eq.${SANDBOX_USER_ID}` }, { limit: 1 });
    if (!rows || rows.length === 0) {
      console.log(`[auto-unlock] No persisted DEK grant for user ${SANDBOX_USER_ID.slice(0, 8)}`);
      return;
    }
    for (const row of rows) {
      try {
        const userDEK = decryptDekFromStorage(row.encrypted_dek);
        const categoryRows = await supabaseSelectAgents("user_category_keys", "*",
          { user_id: `eq.${row.user_id}` });
        const session = await unlockKeySessionFromDEK({ userDEK, categoryRows });
        keySessions.set(row.user_id, session);
        console.log(`[auto-unlock] Restored session for user ${row.user_id.slice(0, 8)}`);
      } catch (err) {
        console.warn(`[auto-unlock] Failed for user ${row.user_id.slice(0, 8)}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[auto-unlock] Error: ${err.message}`);
  }
}

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

/**
 * POST /unlock-session — accepts raw userDEK directly from VitaApp.
 * VitaApp sends the DEK via EHBP (browser → enclave, encrypted in transit).
 * The DEK is persisted (encrypted) in Supabase so the sandbox can auto-unlock on restart.
 */
async function handleUnlockSession(req, res) {
  const body = await readBody(req);
  const { user_id, user_dek } = body;

  if (!user_id || !user_dek) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "user_id and user_dek (base64) required" }));
    return;
  }

  try {
    // Decode the DEK from base64
    const dekBytes = new Uint8Array(Buffer.from(user_dek, "base64"));
    if (dekBytes.length !== 32) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "user_dek must be 32 bytes (base64 encoded)" }));
      return;
    }

    // Destroy existing session if any
    const existing = keySessions.get(user_id);
    if (existing) {
      await destroyKeySession(existing);
      keySessions.delete(user_id);
    }

    // Fetch category keys from Supabase and unwrap with the DEK
    const categoryRows = await supabaseSelect("user_category_keys", "*",
      { user_id: `eq.${user_id}` });

    const session = await unlockKeySessionFromDEK({ userDEK: dekBytes, categoryRows });
    keySessions.set(user_id, session);

    // Persist the DEK (encrypted) for auto-unlock on restart
    const persisted = await persistDek(user_id, dekBytes);

    console.log(`[unlock-session] User ${user_id.slice(0, 8)} unlocked (${[...session.categoryDEKs.keys()].join(", ")}) persisted=${persisted}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      user_id,
      categories: [...session.categoryDEKs.keys()],
      persisted,
    }));
  } catch (err) {
    console.error("[unlock-session] Error:", err);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "unlock_session_failed" }));
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
      if (req.url === "/unlock-session") return await handleUnlockSession(req, res);
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

server.listen(PORT, async () => {
  console.log(`[server] vita-sandbox listening on :${PORT}`);
  // Auto-unlock from persisted DEK grants (survives container restart)
  await autoUnlockFromPersistedDek();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await wipeAllKeySessions();
    process.exit(0);
  });
}
