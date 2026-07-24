# Telegram `ask_user_question` 경량 구현 계획

## 확정 범위

- 한 번에 한 Pi 세션만 Telegram 질문 사용
- Mac과 해당 Pi 프로세스가 실행 중일 때만 동작
- 현재 설치된 `ask-user-question`의 외부 UI bridge를 활용
- 현재 Pi 프로세스가 Telegram Bot API를 직접 long polling
- broker daemon, launchd, Unix socket, IPC protocol, 원본 패키지 PR은 사용하지 않음
- `radio`, `checkbox`, `text`, `allowOther`, 취소 지원
- 기존 Telegram 봇 설정을 재사용

## 핵심 흐름

```text
사용자: “텔레그램으로 질문해”
  → question_channel({ channel: "telegram" })
  → ask_user_question
  → ctx.ui.ask_user_question bridge
  → Telegram sendMessage/getUpdates
  → 기존 FormResult로 변환
  → 같은 에이전트 턴 계속
```

## Task L1 — 무거운 선행 구현 제거

**삭제**
- `extensions/telegram-question-bridge/protocol.ts`
- `extensions/telegram-question-bridge/protocol.test.ts`
- `extensions/telegram-question-bridge/question-state.ts`
- `extensions/telegram-question-bridge/question-state.test.ts`

**완료 기준**
- broker/IPC용 코드가 저장소에 남지 않음
- 기존 사용자 설정 파일은 커밋에 포함하지 않음
- 테스트·타입체크 baseline 유지

## Task L2 — 단일 세션 직접 polling 확장 구현

**생성**
- `extensions/telegram-question-bridge/index.ts`
- `extensions/telegram-question-bridge/telegram.ts`
- `extensions/telegram-question-bridge/index.test.ts`
- `extensions/telegram-question-bridge/telegram.test.ts`

**기능**
- `question_channel({ channel: "local" | "telegram" })`
- `/question-channel local|telegram|status`
- Telegram 모드에서만 기존 UI bridge를 임시 설치
- local 복귀 시 원래 bridge 복원
- 질문 호출 시작 전에 이전 Telegram update offset 정리
- `sendMessage`, `getUpdates`, `answerCallbackQuery`, `editMessageReplyMarkup` 최소 사용
- radio: 버튼 선택
- checkbox: 토글 + 제출
- text: ForceReply
- allowOther: 기타 입력 후 ForceReply
- 취소 버튼 또는 `/cancel`
- Pi AbortSignal 발생 시 polling 중단
- 설정된 private chat ID와 발신 user ID가 모두 일치할 때만 응답 수락
- 한 번에 하나의 Telegram 질문 호출만 허용

**제외**
- 데몬·백그라운드 영속 실행
- 여러 Pi 프로세스 간 조정
- pending 질문 디스크 저장
- 자동 재접속·세션 복구
- Keychain 마이그레이션

## Task L3 — 검증과 실사용 설정

**자동 검증**
```bash
cd /Users/mindasom/.pi/agent/extensions
PATH="/opt/homebrew/bin:$PATH" pnpm test
PATH="/opt/homebrew/bin:$PATH" pnpm run typecheck
PATH="/opt/homebrew/bin:$PATH" pnpm exec biome check telegram-question-bridge
```

**런타임 검증**
- 임시 Pi 설정에서 확장 로드
- local 질문 fallback 확인
- Telegram mock으로 radio/checkbox/text/취소 확인
- 실제 봇으로 질문 1회 왕복 확인

**보안 조치**
- 기존 봇 token은 이번 대화 도구 출력에 노출되었으므로 BotFather에서 재발급
- 새 token을 기존 `0600` 설정 파일에 저장
- 로그·테스트 fixture에 실제 token 금지

## 검토 결과

- 전체 자동 검증: 30개 파일, 453개 테스트 통과
- 타입체크·Biome·격리 headless 로드 통과
- 설치된 `ask-user-question@0.4.5`와 동시 로드 통과
- production 코드: `index.ts` 119줄 + `telegram.ts` 331줄 = 450줄
- broker, launchd, Unix socket, IPC 의존 없음
- 새 봇 token 재발급·설정 완료
- 실제 Telegram 왕복 통과: radio, checkbox, text, cancel

## 롤백

- `/question-channel local`로 즉시 로컬 폼 복귀
- 확장 디렉터리를 비활성화하면 기존 `ask_user_question` 동작만 남음
- Telegram 오류 시 로컬로 조용히 fallback하지 않고 명시적 오류 반환
