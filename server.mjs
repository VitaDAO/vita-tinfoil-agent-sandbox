/**
 * vita-sandbox HTTP server — receives requests from the control plane.
 *
 * Endpoints:
 *   POST /ingest  — write workspace files (USER.md, etc.)
 *   POST /invoke  — run the agent with a message, return response
 *   GET  /health  — liveness check
 *
 * Auth: all POST endpoints require Authorization: Bearer $SANDBOX_AUTH_SECRET
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKSPACE = "/home/user/.openclaw/workspace";
const AUTH_SECRET = process.env.SANDBOX_AUTH_SECRET || "";
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB limit

// QMD URL from env only — never accept from request body (prevents SSRF)
const QMD_URL = process.env.QMD_GPU_URL || "";

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
    const filePath = resolve(join(WORKSPACE, f.name));
    if (!filePath.startsWith(WORKSPACE)) continue; // resolved path must stay inside workspace
    mkdirSync(join(filePath, ".."), { recursive: true });
    // Allow empty content (clears the file)
    writeFileSync(filePath, f.content || "", "utf-8");
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, files: files.length }));
}

async function handleInvoke(req, res) {
  const body = await readBody(req);
  const { message, session_id, user_id } = body;

  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message required" }));
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
  res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
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
