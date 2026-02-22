#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { inferProvider, extractAccountId, updateFailure } = await import(
  pathToFileURL(join(__dirname, "lib", "qos-state.mjs")).href
);

const input = await new Promise((resolve) => {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  process.stdin.on("error", () => resolve(""));
});

let data = {};
try { data = JSON.parse(input || "{}"); } catch {}

const toolName = data.tool_name || data.toolName || "";
const errorText = String(data.error || "");
if (!errorText) {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

const command = String((data.tool_input || data.toolInput || {}).command || "");
const provider = inferProvider(command) || (String(toolName).toLowerCase().includes("gemini") ? "gemini" : null) || (String(toolName).toLowerCase().includes("codex") ? "codex" : null);
if (!provider) {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

const accountId = extractAccountId(command);
updateFailure(provider, accountId, errorText);

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
