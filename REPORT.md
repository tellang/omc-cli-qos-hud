# OMC 전역 라우팅 + QoS + HUD 구현 리포트

작성일: 2026-02-22

## 1) 변경 파일 목록

- `C:/Users/SSAFY/.claude/hooks/lib/cli-qos.mjs`
- `C:/Users/SSAFY/.claude/hooks/lib/cli-accounts.mjs`
- `C:/Users/SSAFY/.claude/hooks/pre-tool-use.mjs`
- `C:/Users/SSAFY/.claude/hooks/post-tool-use.mjs`
- `C:/Users/SSAFY/.claude/hooks/post-tool-use-failure.mjs`
- `C:/Users/SSAFY/.claude/hooks/keyword-detector.mjs`
- `C:/Users/SSAFY/.claude/hud/omc-hud.mjs`
- `C:/Users/SSAFY/.claude/settings.json`
- `C:/Users/SSAFY/.claude/CLAUDE.md`
- `C:/Users/SSAFY/projects/ai-scaffold/CLAUDE.md`
- `C:/Users/SSAFY/projects/working/templates/cli-starter/CLAUDE.md`
- `C:/Users/SSAFY/projects/omc-cli-qos-hud/hud-qos-status.mjs`
- `C:/Users/SSAFY/projects/omc-cli-qos-hud/README.md`
- `C:/Users/SSAFY/projects/omc-cli-qos-hud/REPORT.md`

## 2) 상태 파일 스키마

### QoS 상태: `~/.omc/state/cli_qos_profile.json`

```json
{
  "version": 1,
  "updated_at": "ISO8601",
  "providers": {
    "codex": {
      "max_parallel": 3,
      "min_parallel": 2,
      "max_parallel_cap": 4,
      "success_streak": 0,
      "recent_429": 0,
      "recent_timeout": 0,
      "ewma_latency_ms": 0,
      "cooldown_until": null,
      "last_success_at": null,
      "updated_at": "ISO8601"
    },
    "gemini": {
      "max_parallel": 1,
      "min_parallel": 1,
      "max_parallel_cap": 2,
      "success_streak": 0,
      "recent_429": 0,
      "recent_timeout": 0,
      "ewma_latency_ms": 0,
      "cooldown_until": null,
      "last_success_at": null,
      "updated_at": "ISO8601"
    }
  }
}
```

### 계정 설정: `~/.omc/router/accounts.json`

```json
{
  "version": 1,
  "providers": {
    "codex": [
      { "id": "codex-main", "label": "main@example.com", "weight": 2, "enabled": true },
      { "id": "codex-backup", "label": "backup@example.com", "weight": 1, "enabled": true }
    ],
    "gemini": [
      { "id": "gemini-main", "label": "gemini@example.com", "weight": 1, "enabled": true }
    ]
  }
}
```

### 계정 상태: `~/.omc/state/cli_accounts_state.json`

```json
{
  "version": 1,
  "updated_at": "ISO8601",
  "providers": {
    "codex": {
      "rr_cursor": 0,
      "last_selected_id": "codex-main",
      "accounts": {
        "codex-main": {
          "success_count": 0,
          "failure_count": 0,
          "recent_error": "",
          "cooldown_until": null,
          "last_selected_at": null,
          "last_success_at": null,
          "last_failure_at": null
        }
      }
    }
  }
}
```

## 3) 라우팅 규칙/우선순위

- 기본 라우팅
  - 코딩/구현/리팩터링/분석/리뷰/계획: Codex Bash 우선
  - 문서/UI/대용량 읽기: Gemini Bash 우선
  - 서버 실행/실측 디버깅/git 복구: Claude 로컬 도구 루프
- 비단순 작업: 태스크 분해 후 병렬 실행 기본
- 출력 위생 강제
  - Codex/Gemini CLI 명령에서 `stdout/stderr` 미분리 시 `PreToolUse` 차단
  - 결과 파일 전문 로딩 시 `PreToolUse` 차단
- 메모리 파일 정책
  - `.omc/project-memory.json`, `.omc/notepad.md`는 외부 CLI(Codex/Gemini) 전달 금지
  - 예외 시 `OMC_ALLOW_MEMORY_FILE_FOR_EXTERNAL_CLI=1`
- MCP fallback
  - CLI 실패 시에만 `ask_codex`/`ask_gemini` 사용

## 4) 실패/복구 시나리오

### 429 / timeout 발생

1. `post-tool-use-failure.mjs`가 provider를 판별
2. `cli-qos.mjs`에서 AIMD 감소 적용
   - `max_parallel = max(min_parallel, floor(max_parallel * 0.5))`
   - `cooldown_until` 설정
3. `cli-accounts.mjs`에서 실패 계정 cooldown 적용
4. 가능한 다음 계정으로 failover (`last_selected_id` 갱신)
5. `pre-tool-use.mjs`는 라우팅 힌트에서 현재 parallel/cooldown/account를 노출

### 성공 복구

1. `post-tool-use.mjs` 성공 이벤트에서 `success_streak` 증가
2. EWMA 지연 갱신
3. 성공 누적 + 지연 안정 시 `max_parallel += 1` (cap 상한)
4. 계정 성공 카운트 및 최근 성공 시각 갱신

## 5) 검증 로그 요약

### 문법 체크

- `node --check` 실행 대상 8개 파일 전부 통과
  - 훅 6개 + HUD wrapper + `hud-qos-status.mjs`

### 샘플 입력 검증

- 키워드 라우팅
  - 입력: `use codex to implement this`
  - 결과: `keyword-detector`에서 Bash-first 지시 + QoS/계정 상태 출력 확인
- stderr 미분리 차단
  - 입력: `codex exec --full-auto "테스트"`
  - 결과: `decision: "block"` 반환 확인
- 메모리 파일 차단
  - 입력: `gemini ... cat .omc/project-memory.json`
  - 결과: `MEMORY POLICY BLOCK` 확인
- QoS 성공 증가
  - 이벤트: gemini 성공 3회
  - 결과: `gemini.max_parallel 1 -> 2` 상승 확인
- QoS 실패 감소 + cooldown
  - 이벤트: codex 429/timeout 실패
  - 결과: `codex.max_parallel 3 -> 2`, `cooldown_until` 설정 확인
- 계정 failover
  - 설정: codex 계정 2개(main/backup)
  - 결과: main 실패 후 `last_selected_id = codex-backup` 확인

## 6) 운영 가이드 (튜닝 파라미터, 위험/한계)

### 튜닝 파라미터

- `cli-qos.mjs`
  - `SUCCESS_STREAK_THRESHOLD` (기본 3)
  - `STABLE_LATENCY_MS` (기본 45000)
  - `COOLDOWN_MS` (rate_limit/timeout/auth/default)
- `accounts.json`
  - provider별 `weight`, `enabled`
- 예외 플래그
  - `OMC_ALLOW_MEMORY_FILE_FOR_EXTERNAL_CLI=1`
  - `OMC_DISABLE_QOS_HUD=1`

### 위험/한계

- Codex/Gemini 사용량은 공식 API 부재로 HUD에서 `EST` 표기 기반
- PreToolUse 차단은 규칙 우선이므로, 예외적 실험 명령도 차단될 수 있음
- 계정 failover는 로컬 상태 기반이며 실제 로그인 상태/세션 만료를 직접 확인하지 않음
- QoS는 훅 이벤트 기반이라, 훅을 우회한 수동 실행은 상태 반영이 누락될 수 있음
