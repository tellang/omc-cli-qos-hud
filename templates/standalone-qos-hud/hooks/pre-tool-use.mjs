#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { inferProvider, extractAccountId, buildHint, getStatePath } = await import(
  pathToFileURL(join(__dirname, "lib", "qos-state.mjs")).href
);

async function main() {
  try {
    const input = await new Promise((resolve) => {
      const chunks = [];
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      process.stdin.on("error", () => resolve(""));
    });

    let data = {};
    try { 
      data = JSON.parse(input || "{}"); 
    } catch (e) {
      throw new Error(`Invalid JSON input: ${e.message}`);
    }

    const toolName = data.tool_name || data.toolName || "";
    if (!/^(Bash|bash)$/.test(String(toolName))) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const command = String((data.tool_input || data.toolInput || {}).command || "");
    const provider = inferProvider(command);
    if (!provider) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const accountId = extractAccountId(command);
    const hint = buildHint(provider, accountId);
    if (!hint) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `${hint}\n[STATE] ${getStatePath()}`,
      },
    }));
  } catch (err) {
    const failOpen = process.env.OMC_HOOK_FAIL_OPEN === "1";
    if (failOpen) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    } else {
      console.error(`[OMC-QOS-ERROR] ${err.message}`);
      process.exit(1);
    }
  }
}

main();
