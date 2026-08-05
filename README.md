# Discord Character Bot

Discord 지정 채널에서 Codex의 ChatGPT 로그인 세션을 이용해 캐릭터챗을 실행하는 작은 로컬 봇.

## 특징

- OpenAI API 키 불필요: `codex login`의 ChatGPT OAuth 세션 재사용
- 지정 길드와 채널만 처리
- 선택적 사용자 ID 허용 목록
- 채널당 Codex 스레드 유지
- 일반 메시지를 공동 입력 대기열에 축적하고 `/run`에서만 스토리 진행
- `/run`마다 로컬 체크포인트를 저장하고 `/rewind`로 이전 컨텍스트 복원
- `/set`으로 사용자별 호칭과 특징 저장, 미설정 시 Discord 닉네임 사용
- `character.md` 수정 시 새 스레드 자동 시작
- Discord Markdown으로 나레이션·대사·속마음 구분
- Codex 실행 환경에서 Discord 토큰 제거
- 도구·웹·쓰기 비활성화

## 요구 사항

- Bun 1.3 이상
- ChatGPT 구독에서 사용 가능한 Codex
- Discord bot token
- Discord Developer Portal에서 **Message Content Intent** 활성화

## 설치

```bash
cd ~/work/discord-character-bot
bun install
codex login
codex login status
cp .env.example .env
```

`.env`에 다음 세 값을 채운다.

```dotenv
DISCORD_TOKEN=...
DISCORD_GUILD_ID=...
DISCORD_CHANNEL_ID=...
```

개인용이면 `DISCORD_ALLOWED_USER_IDS`에 본인 Discord 사용자 ID를 넣는 것을 권장한다.

캐릭터 설정은 `character.md`를 수정한다. 실행 중 수정해도 다음 메시지부터 새 Codex 스레드가 시작된다.

기본 모델은 `gpt-5.6-terra`, reasoning effort는 `medium`이다.

## 실행

개발 실행:

```bash
bun run dev
```

일반 실행:

```bash
bun run start
```

## 사용 흐름

1. 친구들이 설정 채널에 대사나 행동을 일반 메시지로 보낸다.
2. 봇이 `📝` 반응을 달면 입력 대기열에 저장된 상태다.
3. 스토리를 진행할 사람이 `/run`을 실행한다.
4. 봇은 쌓인 메시지를 시간순으로 묶어 캐릭터의 다음 턴을 한 번 생성한다.

일반 메시지만으로는 AI 응답이 생성되지 않는다. 새 메시지가 생성 중 들어오면 다음 `/run`용으로 남는다. `/run` 실패 시 입력도 소비되지 않는다.

## Slash commands

- `/me`: 내 호칭, 특징, 대기 메시지 수, 모델 확인
- `/set nickname:<이름> description:<특징>`: 캐릭터가 사용할 사용자 정보 설정
- `/set reset:true`: 저장된 사용자 정보 초기화
- `/run`: 쌓인 메시지로 다음 스토리 턴 생성
- `/rewind steps:<1~20>`: 최근 `/run` 턴을 제거하고 당시 사용자 입력을 대기열 앞쪽에 복원
- `/reset`: 현재 스토리 기억과 아직 처리하지 않은 입력 초기화 (`/set`, `/init` 유지)
- `/init`: 이름, 성격·말투, 배경·사전설정, 현재 상황, 추가 상세 설정
- `/init clear:true`: 채널 프리셋을 지우고 `character.md` 기본값으로 복귀
- `/char`: 실제 적용 중인 캐릭터 카드 확인

Slash command는 봇 시작 시 설정 길드에 자동 등록된다. Discord 초대 URL에는 `bot`과 `applications.commands` scope가 필요하다.

`/rewind` 후 기존 Discord 출력 메시지는 화면에 남지만 이후 AI 컨텍스트에서는 제외된다. 남은 체크포인트를 새 Codex 스레드에 재주입하므로 되돌린 지점부터 다시 `/run`할 수 있다. 최근 100개 `/run` 체크포인트를 보관한다.

출력 형식:

```text
*나레이션과 행동*

**“캐릭터의 대사”**

***‘필요할 때만 쓰는 속마음’***
```

사용자 입력에서도 단일 별표는 나레이션이다.

```text
문 좀 열어줘. *문 앞에서 젖은 우산을 접는다.*
```

위 입력은 `문 좀 열어줘.`를 사용자 대사, `문 앞에서…`를 사용자 나레이션으로 분리해 모델에 전달한다. `**굵은 글씨**`와 `\*이스케이프한 별표\*`는 나레이션으로 해석하지 않는다.

`DISCORD_REQUIRE_MENTION=true`이면 봇을 멘션한 메시지에만 답한다.

## 로컬 데이터

- `data/state.json`: 채널별 Codex thread ID
- 같은 파일에 사용자별 호칭·특징, `/init` 캐릭터 프리셋, 아직 실행하지 않은 입력 대기열 저장
- 같은 파일에 최근 `/run` 체크포인트와 되감기용 입력·출력 히스토리 저장
- `~/.codex/`: Codex 로그인과 세션 데이터
- `.env`: Discord 비밀값; Git에서 제외됨

`~/.codex/auth.json`에는 액세스 토큰이 있을 수 있다. 저장소에 복사하거나 공유하지 않는다.

## 보안 범위

Codex는 본래 코딩 에이전트다. 이 프로젝트는 읽기 전용 sandbox, 도구 사용 금지 프롬프트, 웹 비활성화, 환경 변수 allowlist를 적용하지만 완전한 보안 격리는 아니다. 공개 서버보다 본인이 제어하는 비공개 길드·채널에서 사용한다.

콘텐츠에는 별도 앱 필터나 refusal 레이어를 추가하지 않는다. 프롬프트는 허용되는 허구 역할극에 직접 응답하고 불필요한 경고·훈계·면책 문구를 넣지 않도록 구성되어 있다. 단, Codex/OpenAI 서비스 자체의 필수 정책은 이 앱에서 비활성화할 수 없다.

## 검사

```bash
bun test
bun run check
bun run build
```

## 인증 방식

공식 `@openai/codex-sdk`가 로컬 Codex CLI를 실행하고 저장된 ChatGPT 로그인을 재사용한다. OAuth 파일을 직접 읽거나 비공식 API로 전달하지 않는다.

- [Codex 인증](https://learn.chatgpt.com/docs/auth)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
