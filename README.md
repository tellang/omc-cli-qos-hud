# omc-cli-qos-hud

OMC 전역 라우팅 QoS/AIMD 상태와 계정 failover 상태를 HUD 형태로 출력하는 프로젝트입니다.

## 실행

```bash
node C:/Users/SSAFY/projects/omc-cli-qos-hud/hud-qos-status.mjs
```

statusline stdin(JSON)이 전달되면 Claude context 값을 반영하고, 없으면 파일 기반 fallback만 사용합니다.

## 데이터 소스

- `~/.omc/state/session-token-stats.json`
- `~/.omc/state/cli_qos_profile.json`
- `~/.omc/router/accounts.json`
- `~/.omc/state/cli_accounts_state.json`
