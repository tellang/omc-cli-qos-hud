import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_PATH = join(homedir(), ".qos-hud", "state", "cli_qos_profile.json");
const SUCCESS_STREAK_STEP_UP = 3;
const SUCCESS_EWMA_THRESHOLD_MS = 45_000;
const CAP_GROWTH_STREAK_THRESHOLD = {
  codex: 12,
  gemini: 10,
};
const CAP_HARD_LIMIT = {
  codex: 30,
  gemini: 30,
};

const DEFAULT_PROFILE = {
  version: 1,
  updated_at: "",
  providers: {
    codex: {
      max_parallel: 3,
      min_parallel: 2,
      max_parallel_cap: 4,
      success_streak: 0,
      cap_growth_streak: 0,
      recent_429: 0,
      recent_timeout: 0,
      ewma_latency_ms: 0,
      cooldown_until: null,
      last_success_at: null,
      updated_at: "",
      last_account_id: "",
      accounts: {},
    },
    gemini: {
      max_parallel: 1,
      min_parallel: 1,
      max_parallel_cap: 2,
      success_streak: 0,
      cap_growth_streak: 0,
      recent_429: 0,
      recent_timeout: 0,
      ewma_latency_ms: 0,
      cooldown_until: null,
      last_success_at: null,
      updated_at: "",
      last_account_id: "",
      accounts: {},
    },
  },
};

function nowIso() {
  return new Date().toISOString();
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return fallback; }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

function cloneDefaultProvider(provider) {
  return JSON.parse(JSON.stringify(DEFAULT_PROFILE.providers[provider]));
}

function normalizeProfile(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const providers = source.providers && typeof source.providers === "object" ? source.providers : {};

  const normalized = {
    version: 1,
    updated_at: nowIso(),
    providers: {
      codex: { ...cloneDefaultProvider("codex"), ...(providers.codex || {}) },
      gemini: { ...cloneDefaultProvider("gemini"), ...(providers.gemini || {}) },
    },
  };

  normalized.providers.codex.updated_at = nowIso();
  normalized.providers.gemini.updated_at = nowIso();
  return normalized;
}

function ensureAccountState(providerState, accountId) {
  const id = accountId || "default";
  if (!providerState.accounts || typeof providerState.accounts !== "object") {
    providerState.accounts = {};
  }
  if (!providerState.accounts[id]) {
    providerState.accounts[id] = {
      max_parallel: providerState.max_parallel,
      min_parallel: providerState.min_parallel,
      max_parallel_cap: providerState.max_parallel_cap,
      success_streak: 0,
      cap_growth_streak: 0,
      recent_429: 0,
      recent_timeout: 0,
      ewma_latency_ms: 0,
      cooldown_until: null,
      last_success_at: null,
      updated_at: nowIso(),
    };
  }
  if (!Number.isFinite(Number(providerState.accounts[id].cap_growth_streak))) {
    providerState.accounts[id].cap_growth_streak = 0;
  }
  providerState.last_account_id = id;
  return providerState.accounts[id];
}

function syncProvider(providerState, accountState) {
  providerState.max_parallel = accountState.max_parallel;
  providerState.min_parallel = accountState.min_parallel;
  providerState.max_parallel_cap = accountState.max_parallel_cap;
  providerState.success_streak = accountState.success_streak;
  providerState.cap_growth_streak = accountState.cap_growth_streak;
  providerState.recent_429 = accountState.recent_429;
  providerState.recent_timeout = accountState.recent_timeout;
  providerState.ewma_latency_ms = accountState.ewma_latency_ms;
  providerState.cooldown_until = accountState.cooldown_until;
  providerState.last_success_at = accountState.last_success_at;
  providerState.updated_at = nowIso();
}

export function classifyFailure(errorText) {
  const text = String(errorText || "");
  // 429와 job id=1429 구분 등을 위해 \b 또는 명확한 매칭 필요
  if (/(?:rate.?limit|\b429\b|too many requests|request throttled|quota)/i.test(text)) return "rate_limit";
  if (/(?:timeout|timed out|etimedout|econnreset|deadline exceeded|gateway timeout)/i.test(text)) return "timeout";
  if (/(?:\b401\b|auth|unauthori|forbidden|403|login|credential|token expired|permission denied)/i.test(text)) return "auth";
  return "default";
}

export function inferProvider(command) {
  const cmd = String(command || "");
  // codex.exe, gemini.exe 및 다양한 플래그 순서 대응
  if (/\bcodex(?:\.exe)?\s+(?:--\w+\s+\w+\s+)*exec\b/i.test(cmd)) return "codex";
  if (/\bgemini(?:\.exe)?\s+(?:.*?-y|.*?--yes)\s+-p\b/i.test(cmd)) return "gemini";
  if (/\bgemini(?:\.exe)?\s+-p\s+.*?(?:-y|--yes)\b/i.test(cmd)) return "gemini";
  // cli-route.sh 경유 감지 (bteam)
  const cliRouteMatch = cmd.match(/cli-route\.sh\s+([\w-]+)/);
  if (cliRouteMatch) {
    const agent = cliRouteMatch[1];
    if (/^(executor|build-fixer|debugger|deep-executor|architect|planner|critic|analyst|code-reviewer|security-reviewer|quality-reviewer|scientist|document-specialist|spark)$/.test(agent)) return "codex";
    if (/^(designer|writer)$/.test(agent)) return "gemini";
  }
  return null;
}

export function hasStdoutRedirect(command) {
  const cmd = String(command || "");
  // 프롬프트 내부의 리다이렉션 문자열과 실제 쉘 리다이렉션 구분은 어렵지만, 기본적인 감지 시도
  return /(?:\s|^)(?:1?>|>>)\s*[^&]/.test(cmd);
}

export function hasStderrRedirect(command) {
  const cmd = String(command || "");
  // 2> 감지, 2>&1은 stderr가 stdout으로 병합되는 것이므로 별도 stderr 리다이렉션 파일로 보지 않음
  return /(?:\s|^)2>\s*[^&]/.test(cmd);
}

export function isAllowedPath(filePath) {
  const path = String(filePath || "").replace(/\\/g, "/");
  const basename = path.split("/").pop();
  
  // 필수 허용 패턴들
  if (path.includes(".omc/state/")) return true;
  if (path.includes(".claude/settings.json")) return true;
  if (path.includes(".claude/hooks/")) return true;
  if (["CLAUDE.md", "AGENTS.md", "README.md"].includes(basename)) {
    // docs/NOT_CLAUDE.md 처럼 basename만 일치하는 경우 방지 (완전 일치 또는 최상위 가정)
    return !path.includes("/") || path.split("/").length === 1;
  }
  
  return false;
}

export function extractAccountId(command) {
  const cmd = String(command || "");
  const patterns = [
    /(?:QOS_HUD_ACCOUNT|OMC_ACCOUNT|CODEX_PROFILE|GEMINI_PROFILE)=([A-Za-z0-9_.@-]+)/,
    /--account(?:=|\s+)([A-Za-z0-9_.@-]+)/,
    /--profile(?:=|\s+)([A-Za-z0-9_.@-]+)/,
  ];
  for (const pattern of patterns) {
    const match = cmd.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function readProfile() {
  const raw = readJson(STATE_PATH, null);
  const normalized = normalizeProfile(raw);
  if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
    writeJson(STATE_PATH, normalized);
  }
  return normalized;
}

export function updateSuccess(provider, accountId, latencyMs = 0) {
  const profile = readProfile();
  const state = profile.providers?.[provider];
  if (!state) return;

  const accountState = ensureAccountState(state, accountId);
  const hadRecentErrors = Number(accountState.recent_429 || 0) > 0
    || Number(accountState.recent_timeout || 0) > 0;
  const latency = Number(latencyMs);
  if (Number.isFinite(latency) && latency > 0) {
    accountState.ewma_latency_ms = accountState.ewma_latency_ms > 0
      ? Math.round((0.3 * latency) + (0.7 * accountState.ewma_latency_ms))
      : Math.round(latency);
  }

  accountState.success_streak += 1;
  const stableSuccess = !hadRecentErrors && accountState.ewma_latency_ms <= SUCCESS_EWMA_THRESHOLD_MS;
  accountState.cap_growth_streak = stableSuccess
    ? Number(accountState.cap_growth_streak || 0) + 1
    : 0;
  accountState.recent_429 = 0;
  accountState.recent_timeout = 0;
  accountState.cooldown_until = null;
  accountState.last_success_at = nowIso();

  if (accountState.success_streak >= SUCCESS_STREAK_STEP_UP
    && accountState.ewma_latency_ms <= SUCCESS_EWMA_THRESHOLD_MS) {
    accountState.max_parallel = Math.min(accountState.max_parallel_cap, accountState.max_parallel + 1);
    accountState.success_streak = 0;
  }

  const providerHardCap = CAP_HARD_LIMIT[provider] || accountState.max_parallel_cap;
  accountState.max_parallel_cap = Math.min(Number(accountState.max_parallel_cap || 1), providerHardCap);
  const growThreshold = CAP_GROWTH_STREAK_THRESHOLD[provider] || 12;
  if (accountState.cap_growth_streak >= growThreshold && accountState.max_parallel_cap < providerHardCap) {
    accountState.max_parallel_cap += 1;
    accountState.cap_growth_streak = 0;
  }

  accountState.updated_at = nowIso();
  syncProvider(state, accountState);
  profile.updated_at = nowIso();
  writeJson(STATE_PATH, profile);
}

export function updateFailure(provider, accountId, errorText) {
  const profile = readProfile();
  const state = profile.providers?.[provider];
  if (!state) return;

  const accountState = ensureAccountState(state, accountId);
  const kind = classifyFailure(errorText);
  accountState.max_parallel = Math.max(accountState.min_parallel, Math.floor(accountState.max_parallel * 0.5));
  accountState.success_streak = 0;
  accountState.cap_growth_streak = 0;
  if (kind === "rate_limit") accountState.recent_429 += 1;
  if (kind === "timeout") accountState.recent_timeout += 1;

  const cooldownMs = kind === "rate_limit" ? 180_000 : kind === "timeout" ? 120_000 : 60_000;
  accountState.cooldown_until = new Date(Date.now() + cooldownMs).toISOString();
  accountState.updated_at = nowIso();

  syncProvider(state, accountState);
  profile.updated_at = nowIso();
  writeJson(STATE_PATH, profile);
}

export function buildHint(provider, accountId) {
  const profile = readProfile();
  const state = profile.providers?.[provider];
  if (!state) return null;
  const account = accountId && state.accounts?.[accountId] ? state.accounts[accountId] : state;
  return `[QOS-HUD] ${provider} account=${accountId || state.last_account_id || "default"} ` +
    `par=${account.max_parallel}/${account.max_parallel_cap} ewma=${Math.round(account.ewma_latency_ms || 0)}ms ` +
    `429=${account.recent_429 || 0} to=${account.recent_timeout || 0}`;
}

export function getStatePath() {
  return STATE_PATH;
}
