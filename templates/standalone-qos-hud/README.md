# Standalone QoS HUD Template

OMC 의존 없이 동작하도록 분리하는 템플릿입니다.

## 포함 파일
- `hooks/pre-tool-use.mjs`
- `hooks/post-tool-use.mjs`
- `hooks/post-tool-use-failure.mjs`
- `hooks/lib/qos-state.mjs`
- `hud-statusline.mjs`

## 상태 파일
- `~/.qos-hud/state/cli_qos_profile.json`

## 적용 절차
1. 이 템플릿 폴더를 원하는 위치로 복사
2. `~/.claude/settings.json`에 훅 경로를 템플릿 경로로 지정
3. `statusLine.command`를 `node <템플릿경로>/hud-statusline.mjs`로 지정

## settings.json 예시 스니펫
```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "node C:/path/to/hooks/pre-tool-use.mjs" } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "node C:/path/to/hooks/post-tool-use.mjs" } ] }
    ],
    "PostToolUseFailure": [
      { "hooks": [ { "type": "command", "command": "node C:/path/to/hooks/post-tool-use-failure.mjs" } ] }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "node C:/path/to/hud-statusline.mjs"
  }
}
```

## 주의
- 이 템플릿은 시작점입니다. 계정 선택 로직, 쿼터 API 연동, 라우팅 정책은 환경에 맞게 확장해야 합니다.
