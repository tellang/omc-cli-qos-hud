#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// ============================================================================
// ANSI 색상 (OMC colors.js 스키마 일치)
// ============================================================================
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const CLAUDE_ORANGE = "\x1b[38;5;208m";
const CODEX_WHITE = "\x1b[37m";
const GEMINI_BLUE = "\x1b[38;5;39m";

function green(t) { return `${GREEN}${t}${RESET}`; }
function yellow(t) { return `${YELLOW}${t}${RESET}`; }
function red(t) { return `${RED}${t}${RESET}`; }
function cyan(t) { return `${CYAN}${t}${RESET}`; }
function dim(t) { return `${DIM}${t}${RESET}`; }
function bold(t) { return `${BOLD}${t}${RESET}`; }
function claudeOrange(t) { return `${CLAUDE_ORANGE}${t}${RESET}`; }
function codexWhite(t) { return `${CODEX_WHITE}${t}${RESET}`; }
function geminiBlue(t) { return `${GEMINI_BLUE}${t}${RESET}`; }

function colorByPercent(value, text) {
  if (value >= 85) return red(text);
  if (value >= 70) return yellow(text);
  if (value >= 50) return cyan(text);
  return green(text);
}

function colorCooldown(seconds, text) {
  if (seconds > 120) return red(text);
  if (seconds > 0) return yellow(text);
  return dim(text);
}

function colorParallel(current, cap) {
  if (current >= cap) return green(`${current}/${cap}`);
  if (current > 1) return yellow(`${current}/${cap}`);
  return red(`${current}/${cap}`);
}

function coloredBar(percent, width = 8) {
  const safePercent = Math.min(100, Math.max(0, percent));
  const filled = Math.round((safePercent / 100) * width);
  const empty = width - filled;
  let barColor;
  if (safePercent >= 85) barColor = RED;
  else if (safePercent >= 70) barColor = YELLOW;
  else barColor = GREEN;
  return `${barColor}${"█".repeat(filled)}${DIM}${"░".repeat(empty)}${RESET}`;
}

// ============================================================================
// 상수 / 경로
// ============================================================================
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const CLAUDE_FIVE_HOUR_TOKEN_CAP = 2_000_000;
const CLAUDE_WEEK_TOKEN_CAP = 20_000_000;

const QOS_PATH = join(homedir(), ".omc", "state", "cli_qos_profile.json");
const ACCOUNTS_CONFIG_PATH = join(homedir(), ".omc", "router", "accounts.json");
const ACCOUNTS_STATE_PATH = join(homedir(), ".omc", "state", "cli_accounts_state.json");
const CLAUDE_SNAPSHOT_PATH = join(homedir(), ".omc", "state", "session-token-stats.json");
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_QUOTA_CACHE_PATH = join(homedir(), ".omc", "state", "codex_rate_limits_cache.json");
const CODEX_QUOTA_STALE_MS = 15 * 1000; // 15초

// Gemini 쿼터 API 관련
const GEMINI_OAUTH_PATH = join(homedir(), ".gemini", "oauth_creds.json");
const GEMINI_QUOTA_CACHE_PATH = join(homedir(), ".omc", "state", "gemini_quota_cache.json");
const GEMINI_PROJECT_CACHE_PATH = join(homedir(), ".omc", "state", "gemini_project_id.json");
const GEMINI_SESSION_CACHE_PATH = join(homedir(), ".omc", "state", "gemini_session_tokens_cache.json");
const GEMINI_RPM_TRACKER_PATH = join(homedir(), ".omc", "state", "gemini_rpm_tracker.json");
const GEMINI_RPM_LIMIT = 60; // oauth-personal RPM 한도
const GEMINI_RPM_WINDOW_MS = 60 * 1000; // 60초 슬라이딩 윈도우
const GEMINI_QUOTA_STALE_MS = 5 * 60 * 1000; // 5분
const GEMINI_SESSION_STALE_MS = 15 * 1000; // 15초
const GEMINI_API_TIMEOUT_MS = 3000; // 3초
const ACCOUNT_LABEL_WIDTH = 10;
const PROVIDER_PREFIX_WIDTH = 2;
const PERCENT_CELL_WIDTH = 4;
const TIME_CELL_INNER_WIDTH = 6;
const CODEX_REFRESH_FLAG = "--refresh-codex-rate-limits";
const GEMINI_REFRESH_FLAG = "--refresh-gemini-quota";
const GEMINI_SESSION_REFRESH_FLAG = "--refresh-gemini-session";
const CONTEXT_ALERT_SPLIT_THRESHOLD = 95;

// ============================================================================
// 모바일/Termux 컴팩트 모드 감지
// ============================================================================
const COMPACT_MODE = !!(process.env.TERMUX_VERSION || process.argv.includes("--compact"));

// ============================================================================
// 유틸
// ============================================================================
async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join("").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try { return JSON.parse(readFileSync(filePath, "utf-8")); } catch { return fallback; }
}

function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data));
  } catch { /* 쓰기 실패 무시 */ }
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function padAnsiRight(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

function padAnsiLeft(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return " ".repeat(width - len) + text;
}

function fitText(text, width) {
  const t = String(text || "");
  if (t.length <= width) return t;
  if (width <= 1) return "…";
  return `${t.slice(0, width - 1)}…`;
}

function makeHash(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

function getProviderAccountId(provider, accountsConfig, accountsState) {
  const providerState = accountsState?.providers?.[provider] || {};
  const selectedId = providerState.last_selected_id;
  if (selectedId) return selectedId;
  const providerConfig = accountsConfig?.providers?.[provider] || [];
  return providerConfig[0]?.id || `${provider}-main`;
}

function renderAlignedRows(rows) {
  const rightRows = rows.filter((row) => stripAnsi(String(row.right || "")).trim().length > 0);
  const rawLeftWidth = rightRows.reduce((max, row) => Math.max(max, stripAnsi(row.left).length), 0);
  return rows.map((row) => {
    const prefix = padAnsiRight(row.prefix, PROVIDER_PREFIX_WIDTH);
    const hasRight = stripAnsi(String(row.right || "")).trim().length > 0;
    if (!hasRight) {
      return `${prefix} ${row.left}`;
    }
    // 자기 left 대비 패딩 상한: 최대 2칸까지만 패딩 (과도한 공백 방지)
    const ownLen = stripAnsi(row.left).length;
    const effectiveWidth = Math.min(rawLeftWidth, ownLen + 2);
    const left = padAnsiRight(row.left, effectiveWidth);
    return `${prefix} ${left} ${dim("|")} ${row.right}`;
  });
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function formatPercentCell(value) {
  return `${clampPercent(value)}%`.padStart(PERCENT_CELL_WIDTH, " ");
}

function formatPlaceholderPercentCell() {
  return "--%".padStart(PERCENT_CELL_WIDTH, " ");
}

function normalizeTimeToken(value) {
  const text = String(value || "n/a");
  const hourMinute = text.match(/^(\d+)h(\d+)m$/);
  if (hourMinute) {
    const hours = String(Number(hourMinute[1])).padStart(2, "0");
    const minutes = String(Number(hourMinute[2])).padStart(2, "0");
    return `${hours}h${minutes}m`;
  }
  const dayHour = text.match(/^(\d+)d(\d+)h$/);
  if (dayHour) {
    const days = String(Number(dayHour[1]));
    const hours = String(Number(dayHour[2])).padStart(2, "0");
    return `${days}d${hours}h`;
  }
  return text;
}

function formatTimeCell(value) {
  const text = normalizeTimeToken(value);
  return `(${text.padStart(TIME_CELL_INNER_WIDTH, " ")})`;
}

function getCliArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

function buildGeminiAuthContext(accountId) {
  const oauth = readJson(GEMINI_OAUTH_PATH, null);
  const tokenSource = oauth?.refresh_token || oauth?.id_token || oauth?.access_token || "";
  const tokenFingerprint = tokenSource ? makeHash(tokenSource) : "none";
  const cacheKey = `${accountId || "gemini-main"}::${tokenFingerprint}`;
  return { oauth, tokenFingerprint, cacheKey };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function estimateWindowUsage(totalTokens, capTokens, elapsedMs, windowMs) {
  const usedPercent = clampPercent((totalTokens / capTokens) * 100);
  if (usedPercent < 1 || elapsedMs <= 0) {
    return { percent: usedPercent, remaining: usedPercent < 1 ? ">window" : "n/a" };
  }
  const projectedTotalMs = elapsedMs * (100 / usedPercent);
  const remainingMs = Math.max(0, Math.min(windowMs, projectedTotalMs - elapsedMs));
  return { percent: usedPercent, remaining: formatDuration(remainingMs) };
}

function getContextPercent(stdin) {
  const nativePercent = stdin?.context_window?.used_percentage;
  if (typeof nativePercent === "number" && Number.isFinite(nativePercent)) return clampPercent(nativePercent);
  const usage = stdin?.context_window?.current_usage || {};
  const totalTokens = Number(usage.input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0);
  const capacity = Number(stdin?.context_window?.context_window_size || 0);
  if (!capacity || capacity <= 0) return 0;
  return clampPercent((totalTokens / capacity) * 100);
}

function formatResetRemaining(isoOrUnix) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(totalHours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}m`;
}

function formatResetRemainingDayHour(isoOrUnix) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  if (days > 0) return `${days}d${hours}h`;
  return `${hours}h`;
}

function calcCooldownLeftSeconds(isoDatetime) {
  if (!isoDatetime) return 0;
  const cooldownMs = new Date(isoDatetime).getTime() - Date.now();
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return 0;
  return Math.ceil(cooldownMs / 1000);
}

// ============================================================================
// HTTPS POST (타임아웃 포함)
// ============================================================================
function httpsPost(url, body, accessToken) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: GEMINI_API_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

// ============================================================================
// Codex JWT에서 이메일 추출
// ============================================================================
function getCodexEmail() {
  try {
    const auth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8"));
    const idToken = auth?.tokens?.id_token;
    if (!idToken) return null;
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded.email || null;
  } catch { return null; }
}

// ============================================================================
// Codex 세션 JSONL에서 실제 rate limits 추출
// ============================================================================
function getCodexRateLimits() {
  const now = new Date();
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const d = new Date(now.getTime() - dayOffset * 86_400_000);
    const sessDir = join(
      homedir(), ".codex", "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    if (!existsSync(sessDir)) continue;
    let files;
    try { files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")).sort().reverse(); }
    catch { continue; }
    for (const file of files) {
      try {
        const content = readFileSync(join(sessDir, file), "utf-8");
        const lines = content.trim().split("\n").reverse();
        const buckets = {};
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            const rl = evt?.payload?.rate_limits;
            if (rl?.limit_id && !buckets[rl.limit_id]) {
              buckets[rl.limit_id] = {
                limitId: rl.limit_id, limitName: rl.limit_name,
                primary: rl.primary, secondary: rl.secondary,
                credits: rl.credits,
                tokens: evt.payload?.info?.total_token_usage,
                contextWindow: evt.payload?.info?.model_context_window,
                timestamp: evt.timestamp,
              };
            }
          } catch { /* 라인 파싱 실패 무시 */ }
          if (Object.keys(buckets).length >= 2) break;
        }
        if (Object.keys(buckets).length > 0) return buckets;
      } catch { /* 파일 읽기 실패 무시 */ }
    }
  }
  return null;
}

// ============================================================================
// Gemini 쿼터 API 호출 (5분 캐시)
// ============================================================================
async function fetchGeminiQuota(accountId, options = {}) {
  const authContext = options.authContext || buildGeminiAuthContext(accountId);
  const { oauth, tokenFingerprint, cacheKey } = authContext;
  const forceRefresh = options.forceRefresh === true;

  // 1. 캐시 확인 (계정/토큰별)
  const cache = readJson(GEMINI_QUOTA_CACHE_PATH, null);
  if (!forceRefresh
    && cache?.cacheKey === cacheKey
    && cache?.timestamp
    && (Date.now() - cache.timestamp < GEMINI_QUOTA_STALE_MS)) {
    return cache;
  }

  if (!oauth?.access_token) return cache;
  if (oauth.expiry_date && oauth.expiry_date < Date.now()) return cache; // 만료 시 stale 캐시

  // 3. projectId (캐시 or API)
  const fetchProjectId = async () => {
    const loadRes = await httpsPost(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      { metadata: { pluginType: "GEMINI" } },
      oauth.access_token,
    );
    const id = loadRes?.cloudaicompanionProject;
    if (id) writeJsonSafe(GEMINI_PROJECT_CACHE_PATH, { cacheKey, projectId: id, timestamp: Date.now() });
    return id || null;
  };

  const projCache = readJson(GEMINI_PROJECT_CACHE_PATH, null);
  let projectId = projCache?.cacheKey === cacheKey ? projCache?.projectId : null;
  if (!projectId) projectId = await fetchProjectId();
  if (!projectId) return cache;

  // 4. retrieveUserQuota 호출
  let quotaRes = await httpsPost(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    { project: projectId },
    oauth.access_token,
  );

  // projectId 캐시가 만료/변경된 경우 1회 재시도
  if (!quotaRes?.buckets && projCache?.projectId) {
    projectId = await fetchProjectId();
    if (!projectId) return cache;
    quotaRes = await httpsPost(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      { project: projectId },
      oauth.access_token,
    );
  }

  if (!quotaRes?.buckets) return cache;

  // 5. 캐시 저장
  const result = {
    timestamp: Date.now(),
    cacheKey,
    accountId: accountId || "gemini-main",
    tokenFingerprint,
    buckets: quotaRes.buckets,
  };
  writeJsonSafe(GEMINI_QUOTA_CACHE_PATH, result);
  return result;
}

/**
 * Gemini RPM 트래커에서 최근 60초 내 요청 수를 읽는다.
 * @returns {{ count: number, percent: number, remainingSec: number }}
 */
function readGeminiRpm() {
  try {
    if (!existsSync(GEMINI_RPM_TRACKER_PATH)) return { count: 0, percent: 0, remainingSec: 60 };
    const raw = readFileSync(GEMINI_RPM_TRACKER_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const timestamps = Array.isArray(parsed.timestamps) ? parsed.timestamps : [];
    const now = Date.now();
    const recent = timestamps.filter((t) => now - t < GEMINI_RPM_WINDOW_MS);
    const count = recent.length;
    const percent = clampPercent(Math.round((count / GEMINI_RPM_LIMIT) * 100));
    // 가장 오래된 엔트리가 윈도우에서 빠지기까지 남은 초
    // 가장 오래된 엔트리가 윈도우에서 빠지기까지 남은 초 (0건이면 0s)
    // 5초 단위 반올림으로 HUD 깜빡임 감소
    const rawRemainingSec = recent.length > 0
      ? Math.max(0, Math.ceil((GEMINI_RPM_WINDOW_MS - (now - Math.min(...recent))) / 1000))
      : 0;
    const remainingSec = Math.ceil(rawRemainingSec / 5) * 5;
    return { count, percent, remainingSec };
  } catch {
    return { count: 0, percent: 0, remainingSec: 60 };
  }
}

function readGeminiQuotaSnapshot(accountId, authContext) {
  const cache = readJson(GEMINI_QUOTA_CACHE_PATH, null);
  if (!cache?.buckets) {
    return { quota: null, shouldRefresh: true };
  }

  const cacheKey = authContext.cacheKey;
  const isLegacyCache = !cache.cacheKey;
  const keyMatched = cache.cacheKey === cacheKey;
  const cacheTs = Number(cache.timestamp);
  const ageMs = Number.isFinite(cacheTs) ? Date.now() - cacheTs : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < GEMINI_QUOTA_STALE_MS;

  if (keyMatched) {
    return { quota: cache, shouldRefresh: !isFresh };
  }
  if (isLegacyCache) {
    return { quota: cache, shouldRefresh: true };
  }
  return { quota: null, shouldRefresh: true };
}

function scheduleGeminiQuotaRefresh(accountId) {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;
  try {
    const child = spawn(
      process.execPath,
      [scriptPath, GEMINI_REFRESH_FLAG, "--account", accountId || "gemini-main"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  } catch { /* 백그라운드 실행 실패 무시 */ }
}

function readCodexRateLimitSnapshot() {
  const cache = readJson(CODEX_QUOTA_CACHE_PATH, null);
  if (!cache?.buckets) {
    return { buckets: null, shouldRefresh: true };
  }
  const ts = Number(cache.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < CODEX_QUOTA_STALE_MS;
  return { buckets: cache.buckets, shouldRefresh: !isFresh };
}

function refreshCodexRateLimitsCache() {
  const buckets = getCodexRateLimits();
  if (!buckets) return null;
  writeJsonSafe(CODEX_QUOTA_CACHE_PATH, { timestamp: Date.now(), buckets });
  return buckets;
}

function scheduleCodexRateLimitRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;
  try {
    const child = spawn(process.execPath, [scriptPath, CODEX_REFRESH_FLAG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch { /* 백그라운드 실행 실패 무시 */ }
}

function readGeminiSessionSnapshot() {
  const cache = readJson(GEMINI_SESSION_CACHE_PATH, null);
  if (!cache?.session) {
    return { session: null, shouldRefresh: true };
  }
  const ts = Number(cache.timestamp);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : Number.MAX_SAFE_INTEGER;
  const isFresh = ageMs < GEMINI_SESSION_STALE_MS;
  return { session: cache.session, shouldRefresh: !isFresh };
}

function refreshGeminiSessionCache() {
  const session = scanGeminiSessionTokens();
  if (!session) return null;
  writeJsonSafe(GEMINI_SESSION_CACHE_PATH, { timestamp: Date.now(), session });
  return session;
}

function scheduleGeminiSessionRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return;
  try {
    const child = spawn(process.execPath, [scriptPath, GEMINI_SESSION_REFRESH_FLAG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch { /* 백그라운드 실행 실패 무시 */ }
}

// ============================================================================
// Gemini 세션 JSON에서 토큰 사용량 추출
// ============================================================================
function scanGeminiSessionTokens() {
  const tmpDir = join(homedir(), ".gemini", "tmp");
  if (!existsSync(tmpDir)) return null;
  let best = null;
  let bestTime = 0;
  try {
    const dirs = readdirSync(tmpDir).filter((d) => existsSync(join(tmpDir, d, "chats")));
    for (const dir of dirs) {
      const chatsDir = join(tmpDir, dir, "chats");
      let files;
      try { files = readdirSync(chatsDir).filter((f) => f.endsWith(".json")); } catch { continue; }
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(chatsDir, file), "utf-8"));
          const updatedAt = new Date(data.lastUpdated || 0).getTime();
          if (updatedAt <= bestTime) continue;
          let input = 0, output = 0;
          let model = "unknown";
          for (const msg of data.messages || []) {
            if (msg.tokens) { input += msg.tokens.input || 0; output += msg.tokens.output || 0; }
            if (msg.model) model = msg.model;
          }
          bestTime = updatedAt;
          best = { input, output, total: input + output, model, lastUpdated: data.lastUpdated };
        } catch { /* 무시 */ }
      }
    }
  } catch { /* 무시 */ }
  return best;
}

// ============================================================================
// 라인 렌더러
// ============================================================================
function getClaudeRows(stdin, snapshot) {
  const totalTokens = Number(snapshot.totalInputTokens || 0)
    + Number(snapshot.totalCacheCreation || 0)
    + Math.round(Number(snapshot.totalCacheRead || 0) * 0.1);
  const startTime = snapshot.startTime ? new Date(snapshot.startTime).getTime() : Date.now();
  const elapsedMs = Math.max(0, Date.now() - startTime);
  const fiveHour = estimateWindowUsage(totalTokens, CLAUDE_FIVE_HOUR_TOKEN_CAP, elapsedMs, FIVE_HOUR_MS);
  const weekly = estimateWindowUsage(totalTokens, CLAUDE_WEEK_TOKEN_CAP, elapsedMs, SEVEN_DAY_MS);
  const contextPercent = getContextPercent(stdin);
  const prefix = `${bold(claudeOrange("c"))}:`;

  if (COMPACT_MODE) {
    // 컴팩트: 바 없이 퍼센트+시간만
    const quotaSection = `${dim("5h:")}${colorByPercent(fiveHour.percent, `${fiveHour.percent}%`)} ` +
      `${dim("wk:")}${colorByPercent(weekly.percent, `${weekly.percent}%`)} ` +
      `${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  const fiveHourBar = coloredBar(fiveHour.percent, 6);
  const weeklyBar = coloredBar(weekly.percent, 6);
  const ctxBar = coloredBar(contextPercent, 6);
  const fiveHourPercentCell = formatPercentCell(fiveHour.percent);
  const weeklyPercentCell = formatPercentCell(weekly.percent);
  const fiveHourTimeCell = formatTimeCell(fiveHour.remaining);
  const weeklyTimeCell = formatTimeCell(weekly.remaining);
  const quotaSection = `${dim("5h:")}${fiveHourBar} ${colorByPercent(fiveHour.percent, fiveHourPercentCell)} ` +
    `${dim(fiveHourTimeCell)} ` +
    `${dim("wk:")}${weeklyBar} ${colorByPercent(weekly.percent, weeklyPercentCell)} ` +
    `${dim(weeklyTimeCell)}`;
  const contextSection = `${dim("ctx:")}${ctxBar} ${colorByPercent(contextPercent, `${contextPercent}%`)}`;
  if (contextPercent >= CONTEXT_ALERT_SPLIT_THRESHOLD) {
    return [
      {
        prefix,
        left: contextSection,
        right: "",
      },
      {
        prefix: `${bold(claudeOrange("c"))}:`,
        left: quotaSection,
        right: "",
      },
    ];
  }
  return [{ prefix, left: quotaSection, right: contextSection }];
}

function getAccountLabel(provider, accountsConfig, accountsState, codexEmail) {
  const providerConfig = accountsConfig?.providers?.[provider] || [];
  const providerState = accountsState?.providers?.[provider] || {};
  const lastId = providerState.last_selected_id;
  const picked = providerConfig.find((a) => a.id === lastId) || providerConfig[0]
    || { id: `${provider}-main`, label: `${provider}-main` };
  let label = picked.label || picked.id;
  if (provider === "codex" && codexEmail) label = codexEmail;
  if (label.includes("@")) label = label.split("@")[0];
  return label;
}

function getProviderRow(provider, marker, markerColor, qosProfile, accountsConfig, accountsState, realQuota, codexEmail) {
  const qos = qosProfile?.providers?.[provider] || {};
  const maxParallel = Number(qos.max_parallel || 1);
  const capParallel = Number(qos.max_parallel_cap || maxParallel);
  const recent429 = Number(qos.recent_429 || 0);
  const recentTimeout = Number(qos.recent_timeout || 0);
  const ewmaLatency = Number(qos.ewma_latency_ms || 0);
  const cooldownSeconds = calcCooldownLeftSeconds(qos.cooldown_until);

  const accountLabel = fitText(getAccountLabel(provider, accountsConfig, accountsState, codexEmail), ACCOUNT_LABEL_WIDTH);

  // QoS 섹션 (컴팩트)
  const qosParts = [`${dim("par:")}${colorParallel(maxParallel, capParallel)}`];
  if (cooldownSeconds > 0) qosParts.push(colorCooldown(cooldownSeconds, `cd:${cooldownSeconds}s`));
  if (provider !== "gemini" && recent429 > 0) qosParts.push(red(`429:${recent429}`));
  if (recentTimeout > 0) qosParts.push(yellow(`to:${recentTimeout}`));
  const qosSection = qosParts.join(" ");

  // ── 쿼터 섹션 ──
  let quotaSection;
  let extraRightSection = "";

  if (COMPACT_MODE) {
    // 컴팩트 모드: 바 없이 퍼센트만, right 섹션 생략
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP = clampPercent(main.primary?.used_percent ?? 0);
        const weekP = clampPercent(main.secondary?.used_percent ?? 0);
        quotaSection = `${dim("5h:")}${colorByPercent(fiveP, `${fiveP}%`)} ` +
          `${dim("wk:")}${colorByPercent(weekP, `${weekP}%`)}`;
      }
    }
    if (realQuota?.type === "gemini") {
      const bucket = realQuota.quotaBucket;
      const rpm = readGeminiRpm();
      if (bucket) {
        const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
        quotaSection = `${dim("1d:")}${colorByPercent(usedP, `${usedP}%`)} ` +
          `${dim("rpm:")}${colorByPercent(rpm.percent, `${rpm.count}/${GEMINI_RPM_LIMIT}`)}`;
      } else {
        quotaSection = `${dim("1d:")}${dim("--%")} ` +
          `${dim("rpm:")}${colorByPercent(rpm.percent, `${rpm.count}/${GEMINI_RPM_LIMIT}`)}`;
      }
    }
    if (!quotaSection) {
      quotaSection = `${dim("5h:")}${green("0%")} ${dim("wk:")}${green("0%")}`;
    }
    const prefix = `${bold(markerColor(`${marker}`))}:`;
    return { prefix, left: quotaSection, right: "" };
  }

  if (realQuota?.type === "codex") {
    const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
    if (main) {
      const fiveP = clampPercent(main.primary?.used_percent ?? 0);
      const weekP = clampPercent(main.secondary?.used_percent ?? 0);
      const fiveReset = formatResetRemaining(main.primary?.resets_at) || "n/a";
      const weekReset = formatResetRemainingDayHour(main.secondary?.resets_at) || "n/a";
      quotaSection = `${dim("5h:")}${coloredBar(fiveP, 6)} ${colorByPercent(fiveP, formatPercentCell(fiveP))} ` +
        `${dim(formatTimeCell(fiveReset))} ` +
        `${dim("wk:")}${coloredBar(weekP, 6)} ${colorByPercent(weekP, formatPercentCell(weekP))} ` +
        `${dim(formatTimeCell(weekReset))}`;
    }
  }

  if (realQuota?.type === "gemini") {
    const bucket = realQuota.quotaBucket;
    const rpm = readGeminiRpm();
    // rate 섹션을 left(1m 바 뒤)에 배치해서 | 정렬 갭 채우기
    const rateLimitSection = recent429 > 0
      ? `${dim("rate:")}${red(`${recent429}(429)`)}`
      : `${dim("rate:")}${dim("0")}`;
    // 1m: RPM 바 (로컬 카운팅 기반, 카운트 표시로 깜빡임 방지)
    // "5/60" → " 5/60" (5자 고정폭, 최대 "60/60")
    const rpmCountRaw = `${rpm.count}/${GEMINI_RPM_LIMIT}`;
    const rpmCountStr = rpmCountRaw.padStart(5);
    const rpmBar = `${dim("1m:")}${coloredBar(rpm.percent, 6)} ` +
      `${colorByPercent(rpm.percent, rpmCountStr)} ${rateLimitSection}`;
    if (bucket) {
      // API에서 가져온 실측 쿼터
      const usedP = clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
      const rstRemaining = formatResetRemaining(bucket.resetTime) || "n/a";
      quotaSection = `${dim("1d:")}${coloredBar(usedP, 6)} ` +
        `${colorByPercent(usedP, formatPercentCell(usedP))} ${dim(formatTimeCell(rstRemaining))} ` +
        rpmBar;
    } else {
      // 비동기 갱신 전 플레이스홀더 (회색)
      quotaSection = `${dim("1d:")}${dim("░░░░░░")} ${dim(formatPlaceholderPercentCell())} ` +
        `${dim(formatTimeCell("--h--m"))} ` +
        rpmBar;
    }
  }

  // EST 폴백
  if (!quotaSection) {
    const fiveHourEst = clampPercent(
      (ewmaLatency / 1000) * 0.8 + (recent429 * 20) + (recentTimeout * 12) + (maxParallel * 7),
    );
    const weekEst = clampPercent((fiveHourEst * 0.8) + (recent429 * 10) + (recentTimeout * 5));
    quotaSection = `${dim("5h:")}${colorByPercent(fiveHourEst, `${fiveHourEst}%`)} ` +
      `${dim("wk:")}${colorByPercent(weekEst, `${weekEst}%`)}`;
  }

  const prefix = `${bold(markerColor(`${marker}`))}:`;
  const accountSection = `${markerColor(accountLabel)}`;
  return {
    prefix,
    left: quotaSection,
    right: `${qosSection} ${dim("|")} ${accountSection}${extraRightSection ? ` ${extraRightSection}` : ""}`,
  };
}

// ============================================================================
// 메인
// ============================================================================
async function main() {
  if (process.argv.includes(CODEX_REFRESH_FLAG)) {
    refreshCodexRateLimitsCache();
    return;
  }

  if (process.argv.includes(GEMINI_SESSION_REFRESH_FLAG)) {
    refreshGeminiSessionCache();
    return;
  }

  // 백그라운드 Gemini 쿼터 리프레시 전용 실행 모드
  if (process.argv.includes(GEMINI_REFRESH_FLAG)) {
    const accountId = getCliArgValue("--account") || "gemini-main";
    const authContext = buildGeminiAuthContext(accountId);
    await fetchGeminiQuota(accountId, { authContext, forceRefresh: true });
    return;
  }

  // 메인 HUD 경로: 즉시 렌더 우선
  const stdinPromise = readStdinJson();

  const qosProfile = readJson(QOS_PATH, { providers: {} });
  const accountsConfig = readJson(ACCOUNTS_CONFIG_PATH, { providers: {} });
  const accountsState = readJson(ACCOUNTS_STATE_PATH, { providers: {} });
  const claudeSnapshot = readJson(CLAUDE_SNAPSHOT_PATH, {});
  const geminiAccountId = getProviderAccountId("gemini", accountsConfig, accountsState);
  const codexSnapshot = readCodexRateLimitSnapshot();
  const geminiSessionSnapshot = readGeminiSessionSnapshot();
  const geminiAuthContext = buildGeminiAuthContext(geminiAccountId);
  const geminiQuotaSnapshot = readGeminiQuotaSnapshot(geminiAccountId, geminiAuthContext);
  if (codexSnapshot.shouldRefresh) {
    scheduleCodexRateLimitRefresh();
  }
  if (geminiSessionSnapshot.shouldRefresh) {
    scheduleGeminiSessionRefresh();
  }
  if (geminiQuotaSnapshot.shouldRefresh) {
    scheduleGeminiQuotaRefresh(geminiAccountId);
  }

  // 실측 데이터 추출
  const stdin = await stdinPromise;
  const codexEmail = getCodexEmail();
  const codexBuckets = codexSnapshot.buckets;
  const geminiSession = geminiSessionSnapshot.session;
  const geminiQuota = geminiQuotaSnapshot.quota;

  // Gemini: 사용 중인 모델의 쿼터 버킷 찾기
  const geminiModel = geminiSession?.model || "gemini-3-flash-preview";
  const geminiBucket = geminiQuota?.buckets?.find((b) => b.modelId === geminiModel)
    || geminiQuota?.buckets?.find((b) => b.modelId === "gemini-3-flash-preview")
    || null;

  if (COMPACT_MODE) {
    // ── 컴팩트: 한 줄로 전체 프로바이더 요약 ──
    const contextPercent = getContextPercent(stdin);
    const totalTokens = Number(claudeSnapshot.totalInputTokens || 0)
      + Number(claudeSnapshot.totalCacheCreation || 0)
      + Math.round(Number(claudeSnapshot.totalCacheRead || 0) * 0.1);
    const startTime = claudeSnapshot.startTime ? new Date(claudeSnapshot.startTime).getTime() : Date.now();
    const elapsedMs = Math.max(0, Date.now() - startTime);
    const fiveHour = estimateWindowUsage(totalTokens, CLAUDE_FIVE_HOUR_TOKEN_CAP, elapsedMs, FIVE_HOUR_MS);

    // Codex
    let xPart = "";
    if (codexBuckets) {
      const main = codexBuckets.codex || codexBuckets[Object.keys(codexBuckets)[0]];
      if (main) {
        const fiveP = clampPercent(main.primary?.used_percent ?? 0);
        xPart = `${bold(codexWhite("x"))}${colorByPercent(fiveP, `${fiveP}%`)}`;
      }
    }
    if (!xPart) xPart = `${bold(codexWhite("x"))}${green("0%")}`;

    // Gemini
    let gPart = "";
    if (geminiBucket) {
      const usedP = clampPercent((1 - (geminiBucket.remainingFraction ?? 1)) * 100);
      gPart = `${bold(geminiBlue("g"))}${colorByPercent(usedP, `${usedP}%`)}`;
    } else {
      gPart = `${bold(geminiBlue("g"))}${dim("--%")}`;
    }

    const line = `${bold(claudeOrange("c"))}${colorByPercent(fiveHour.percent, `${fiveHour.percent}%`)} ` +
      `${xPart} ${gPart} ` +
      `${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    process.stdout.write(`${line}\n`);
    return;
  }

  const rows = [
    ...getClaudeRows(stdin, claudeSnapshot),
    getProviderRow("codex", "x", codexWhite, qosProfile, accountsConfig, accountsState,
      codexBuckets ? { type: "codex", buckets: codexBuckets } : null, codexEmail),
    getProviderRow("gemini", "g", geminiBlue, qosProfile, accountsConfig, accountsState,
      { type: "gemini", quotaBucket: geminiBucket, session: geminiSession }, null),
  ];
  const lines = renderAlignedRows(rows);

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch(() => {
  process.stdout.write(`${bold(claudeOrange("c"))}: ${dim("5h:")}${green("0%")} ${dim("(n/a)")} ${dim("wk:")}${green("0%")} ${dim("(n/a)")} ${dim("|")} ${dim("ctx:")}${green("0%")}\n`);
});
