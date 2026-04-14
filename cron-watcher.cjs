#!/usr/bin/env node
// Watches cron run logs and posts summaries to the Railway webhook for Telegram delivery.
// Runs alongside the OpenClaw gateway inside the sandbox.

const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } = require("fs");
const { join } = require("path");

const RUNS_DIR = "/home/user/.openclaw/cron/runs";
const STATE_FILE = "/home/user/.openclaw/cron/.delivered";
const WEBHOOK_URL = process.env.CRON_WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error("CRON_WEBHOOK_URL not set — cron delivery disabled");
  process.exit(0);
}

mkdirSync(RUNS_DIR, { recursive: true });

let delivered = new Set();
if (existsSync(STATE_FILE)) {
  try {
    delivered = new Set(readFileSync(STATE_FILE, "utf-8").split("\n").filter(Boolean));
  } catch {}
}

function saveDelivered() {
  writeFileSync(STATE_FILE, [...delivered].join("\n"), "utf-8");
}

async function checkAndDeliver() {
  let files;
  try { files = readdirSync(RUNS_DIR); } catch { return; }

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(RUNS_DIR, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const run = JSON.parse(line);
        const runKey = `${run.jobId}:${run.ts}`;
        if (delivered.has(runKey) || run.action !== "finished" || !run.summary) continue;

        const res = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.CRON_WEBHOOK_SECRET || ""}`,
          },
          body: JSON.stringify({ summary: run.summary }),
        });
        if (res.ok) {
          delivered.add(runKey);
          saveDelivered();
          console.log(`Delivered: ${run.summary.slice(0, 80)}`);
        } else {
          console.error(`Webhook failed: ${res.status}`);
        }
      } catch (err) {
        console.error(`Delivery error: ${err.message}`);
      }
    }
  }
}

setInterval(checkAndDeliver, 5000);
checkAndDeliver();
console.log("Cron delivery watcher started");
