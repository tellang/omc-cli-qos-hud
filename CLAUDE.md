# omc-cli-qos-hud

<context>
<language>한국어로 응답. 코드 주석도 한국어.</language>
<stack>Node.js (ESM), 순수 node:* 내장 모듈만 사용 (외부 의존성 없음)</stack>
<description>OMC CLI QoS/AIMD 상태 + Claude/Codex/Gemini 쿼터를 HUD 형태로 출력하는 status line 스크립트</description>
</context>

## 구조

```
omc-cli-qos-hud/
├── hud-qos-status.mjs          # 메인 HUD 스크립트 (소스)
├── templates/
│   └── standalone-qos-hud/
│       ├── hud-statusline.mjs   # 경량 standalone HUD
│       └── hooks/
│           ├── lib/qos-state.mjs # QoS 상태 관리 (AIMD 로직)
│           ├── pre-tool-use.mjs
│           ├── post-tool-use.mjs
│           └── post-tool-use-failure.mjs
├── README.md
├── REPORT.md
└── CLAUDE.md                    # 이 파일
```

## 핵심 파일 역할

| 파일 | 역할 |
|------|------|
| `hud-qos-status.mjs` | 메인 HUD — Claude OAuth API 실측, Codex JSONL 파싱, Gemini 쿼터 API 호출 |
| `templates/.../qos-state.mjs` | AIMD 기반 QoS 상태 관리 (병렬도 조절, 쿨다운, 실패 분류) |
| `~/.claude/hud/omc-hud.mjs` | **실제 Claude Code가 실행하는 설치본** (소스와 별도 동기화 필요) |

## 설치 경로 (중요)

- **소스**: `hud-qos-status.mjs` (이 프로젝트)
- **설치본**: `~/.claude/hud/omc-hud.mjs` (Claude Code statusLine이 실행하는 파일)
- **설정**: `~/.claude/settings.json` → `statusLine.command`
- 소스 수정 후 **설치본에도 반영 필수** (수동 복사 또는 동기화 스크립트)

## 컴팩트 모드 설정

Claude Code hook 서브프로세스에서는 TTY가 없어 터미널 크기 자동 감지 불가.
설정 파일로 오버라이드 필요.

### 우선순위 (높은 순)

1. **CLI 플래그**: `--compact` / `--no-compact`
2. **환경변수**: `TERMUX_VERSION`, `OMC_HUD_COMPACT=1|0`
3. **설정 파일**: `~/.omc/config/hud.json`
4. **터미널 폭 자동 감지**: < 80열 시 자동 전환 (TTY 있을 때만)

### 설정 파일 예시 (`~/.omc/config/hud.json`)

```json
{"compact": true}
```

| 값 | 동작 |
|----|------|
| `true` / `"always"` | 항상 컴팩트 |
| `false` / `"never"` | 항상 풀 모드 |
| 파일 없음 | 자동 감지 (TTY 폭 기반) |
| `{"compactThreshold": 120}` | 자동 감지 임계값 변경 |

### 컴팩트 모드 출력 차이

```
# 컴팩트 (시간/바/계정 생략, 퍼센트만)
c: 5h:40% wk:12% ctx:0%
x: 5h:3% wk:41%
g: 1d:0% rpm:0/60

# 풀 모드 (시간 셀 + QoS + 계정)
c: 5h:  40% (00h28m) wk:  12% ( 6d10h) | ctx:0%
x: 5h:   3% (04h40m) wk:  41% (    5h) | par:5/5 | account
g: 1d:   0% (10h55m) 1m:  0/60 rate:0  | par:5/5 | account
```

## 데이터 소스

| 경로 | 용도 |
|------|------|
| `~/.omc/state/cli_qos_profile.json` | QoS AIMD 상태 |
| `~/.omc/router/accounts.json` | 계정 설정 |
| `~/.omc/state/cli_accounts_state.json` | 계정 전환 상태 |
| `~/.omc/state/claude_usage_cache.json` | Claude OAuth 사용량 캐시 |
| `~/.omc/state/codex_rate_limits_cache.json` | Codex rate limits 캐시 |
| `~/.omc/state/gemini_quota_cache.json` | Gemini 쿼터 캐시 |
| `~/.omc/config/hud.json` | HUD 표시 설정 |
| `~/.claude/.credentials.json` | Claude OAuth 토큰 |
| `~/.codex/auth.json` | Codex 인증 |
| `~/.gemini/oauth_creds.json` | Gemini OAuth |

## 주의사항

- 외부 의존성 없음 — `node:fs`, `node:https`, `node:child_process` 등 내장 모듈만 사용
- HUD 렌더링 지연 최소화 — 캐시 우선 읽기 + 백그라운드 비동기 갱신
- `mode con` (Windows) / `tput cols` (Unix) 폴백은 ~16ms 오버헤드
- stdin JSON은 Claude Code가 전달하는 context_window 정보
