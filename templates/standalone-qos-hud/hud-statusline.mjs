#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function dim(t) { return `${DIM}${t}${RESET}`; }
function green(t) { return `${GREEN}${t}${RESET}`; }
function yellow(t) { return `${YELLOW}${t}${RESET}`; }
function red(t) { return `${RED}${t}${RESET}`; }

function colorPar(current, cap) {
  if (current >= cap) return green(`${current}/${cap}`);
  if (current > 1) return yellow(`${current}/${cap}`);
  return red(`${current}/${cap}`);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return fallback; }
}

const path = join(homedir(), ".qos-hud", "state", "cli_qos_profile.json");
const profile = readJson(path, { providers: {} });

const codex = profile.providers?.codex || {};
const gemini = profile.providers?.gemini || {};

const line1 = `x: ${dim("par:")}${colorPar(Number(codex.max_parallel || 1), Number(codex.max_parallel_cap || 1))} ${dim("429:")}${red(String(codex.recent_429 || 0))} ${dim("to:")}${yellow(String(codex.recent_timeout || 0))}`;
const line2 = `g: ${dim("par:")}${colorPar(Number(gemini.max_parallel || 1), Number(gemini.max_parallel_cap || 1))} ${dim("429:")}${red(String(gemini.recent_429 || 0))} ${dim("to:")}${yellow(String(gemini.recent_timeout || 0))}`;
process.stdout.write(`${line1}\n${line2}\n`);
