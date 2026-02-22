---
title: pre-tool-use.mjs 보안 감사 보고서
created: 2026-02-22
author: tellang
category: research
tags: [security-audit, hooks, pre-tool-use, regex]
---

# pre-tool-use.mjs 보안 감사 보고서

## 요약
- 감사 대상: pre-tool-use.mjs + lib/cli-accounts.mjs + lib/cli-qos.mjs
- 감사 방법: Codex CLI 3건 병렬 분석 (정규식, 로직, 보안)
- 발견: CRITICAL 7건, HIGH 6건, WARNING 10건

## CRITICAL 발견사항 (7건)
1. **bypassPattern 우회**: 특정 문자열 조합을 통해 보안 필터를 우회할 수 있는 패턴 발견. (pre-tool-use.mjs, 정규식 설계 결함, 화이트리스트 기반 필터링으로 수정 필요)
2. **hasStderrRedirect(2>&1) 탐지 실패**: 표준 에러 리다이렉션 패턴이 불완전하여 쉘 환경에 따라 탐지되지 않음. (pre-tool-use.mjs, 로깅 우회 위험, 정규식 강화)
3. **hasStdoutRedirect 프롬프트 내 오탐**: 명령어 실행 결과가 아닌 프롬프트 텍스트 내의 기호를 리다이렉션으로 오인. (pre-tool-use.mjs, 로직 오작동, 문맥 기반 파싱 도입)
4. **memoryPathPattern 절대경로 취약점**: 메모리 경로 탐지 시 절대경로 처리가 미흡하여 시스템 파일 접근 가능. (pre-tool-use.mjs, 경로 탐색 공격 위험, 경로 정규화 로직 적용)
5. **inferProviderFromCommand 파싱 한계**: 실행 파일(.exe) 유무나 옵션 순서에 따라 프로바이더를 잘못 판별함. (pre-tool-use.mjs, 정책 적용 오류, 명령어 토큰화 분석 필요)
6. **safeImport 실패 시 보안 무력화**: 의존 모듈 로드 실패(`safeImport` 에러) 시 예외 처리 미비로 보안 체크를 건너뜀. (lib/cli-qos.mjs, 의존성 결함, Fail-Closed 메커니즘 적용)
7. **Fail-Open 설계 결함**: 보안 검사 로직에서 에러 발생 시 기본적으로 '허용'하는 구조적 취약점. (공통, 보안 원칙 위반, 예외 발생 시 기본 차단으로 변경)

## HIGH 발견사항 (6건)
1. **상태 파일 동시 접근(Race Condition)**: 다중 프로세스에서 `hud-state.json`에 동시 접근 시 데이터 파손 위험.
2. **Read 경로 자동 Write 승격**: 읽기 전용 경로가 특정 조건에서 쓰기 권한으로 오인되어 보안 경계가 무너짐.
3. **updated_at Dirty Check 우회**: 타임스탬프만 비교하는 방식의 한계로 내용 변경을 완벽히 추적하지 못함.
4. **Command 내 민감 정보 노출**: 실행 명령어에 포함된 API 키나 자격 증명이 로그에 평문으로 노출됨.
5. **accountId 프로토타입 오염**: 외부 입력값인 accountId 처리 과정에서 객체 프로토타입 변조 가능성.
6. **JSON 파싱 Fail-Open**: 설정 파일 파싱 에러 시 기본 설정을 과도하게 허용하는 방식으로 동작.

## WARNING 발견사항 (10건)
1. **ALLOWED_PATH_PATTERNS 대소문자 미구분**: Windows 환경에서 대소문자 차이를 이용한 경로 필터 우회 가능성.
2. **SOURCE_EXT_PATTERN 부분 매치**: 파일 확장자 검사 시 접미사 형태가 아닌 부분 일치로 인한 오탐.
3. **FILE_MODIFY_PATTERNS PowerShell 미대응**: PowerShell 고유의 파일 조작 명령어를 정규식에서 누락.
4. **taskDumpPattern(Get-Content) 탐지 누락**: `cat` 외에 PowerShell 환경의 데이터 덤프 명령어를 인지하지 못함.
5. **extractAccountIdFromCommand 파이프라인 취약점**: 복잡한 파이프라인 명령어에서 계정 ID 추출이 실패함.
6. **classifyFailureKind 광범위 매칭**: 1429 등 특정 에러 코드 매칭 범위가 너무 넓어 엉뚱한 에러를 분류함.
7. **체크 순서 부적절**: Blocker 확인 전에 Routing Hint를 먼저 계산하여 불필요한 연산 수행.
8. **Edit/Write 절대경로(.omc) 누락**: 프로젝트 내부 설정 폴더(`.omc`)에 대한 접근 제어 로직 미비.
9. **safeImport Fallback 품질 저하**: 모듈 로드 실패 시 대체 동작의 보안 수준이 검증되지 않음.
10. **제어 문자 우회**: 명령어 내 특수 제어 문자를 삽입하여 정규식 탐지를 회피할 가능성.

## 근본 원인 분석
- **문자열 부분매치 기반 명령어 분석의 한계**: 정규식에만 의존하여 쉘 명령어의 실제 실행 맥락을 파악하지 못함.
- **Windows 실행 패턴 미반영**: Unix 위주의 보안 패턴으로 인해 PowerShell 등 Windows 환경의 특이 케이스에 취약함.
- **Fail-Open 기본값**: 개발 편의성을 위해 예외 발생 시 실행을 허용하는 구조가 보안 약점을 만듦.

## 수정 계획
- **P0 (즉시)**: Fail-Closed 보안 필터 전환 및 safeImport 예외 처리 강화.
- **P1 (이번주)**: 명령어 토큰화 파서 도입 및 PowerShell 환경 대응 패턴 업데이트.
- **P2 (다음주)**: 상태 파일 잠금(Locking) 메커니즘 구현 및 민감 정보 마스킹 로직 적용.

## 검증 방법
- **test-pre-tool-use.mjs**: 우회 페이로드를 포함한 통합 테스트 스위트 실행.
- **node --check**: 모든 수정된 후킹 스크립트의 구문 및 정적 보안 검증.
- **회귀 테스트**: 기존 정상 명령어들의 오탐 여부를 확인하는 벤치마크 수행.
