# EveJS 모드 제작 튜토리얼 (제작자 시점)

> **모드를 만들고 싶은 사람**을 위한 문서입니다. 아무것도 없는 상태에서 모드 마켓에 설치할 수 있는 모드까지, 총 **8단계**.
> 진행 중에 **서버 파일을 수정할 필요가 없습니다** —— 모드는 로더를 통해 연결됩니다.

**필요한 것**: Windows 10 이상, EveJS 서버(0.12.8 이상), EvEJS 런처 0.1.20 이상, GitHub 계정.

---

## 🎨 색상 / 표시 범례 (먼저 읽어 주세요)

| 표시 | 의미 | 해야 할 일 |
| --- | --- | --- |
| 🟥 **위험** | 실패하거나 오류가 나며, **되돌릴 수 없는** 결과가 생깁니다 | 절대 하지 마세요 |
| 🟨 **주의** | 실수하기 쉽거나 결과가 예상과 다릅니다 | 실행 전에 한 번 확인하세요 |
| 🟦 **팁** | 시간을 아껴 주는 요령 | 써도 됩니다 |
| 🟩 **권장** | 이 방식이 좋습니다 | 그대로 하세요 |
| ✅ **필수** | 빠지면 진행할 수 없습니다 | 반드시 완료하세요 |
| ⭕ **선택** | 비워 둬도 됩니다 | 필요할 때만 |
| 🧩 **예시** | 그대로 쓸 수 있는 코드 / 설정 | 복사해서 고치세요 |

> GitHub의 Markdown, VS Code 미리보기, Typora 등에서 위 색상 표시가 정상적으로 보입니다(이모지이므로 **플러그인이 필요 없습니다**).

---

## 📋 단계 개요

| # | 단계 | 장소 | 대략 소요 시간 | 필수? |
| --- | --- | --- | --- | --- |
| 1 | 환경 확인(버전 / mods 폴더) | 런처 | 2분 | ✅ |
| 2 | **제작자 아이덴티티**를 만들고 `.eve-key` 내보내기 | 런처 | 2분 | ✅ |
| 3 | **GitHub 토큰** 만들기(classic, public_repo 체크) | GitHub 웹 | 5분 | ✅(공개와 제출 모두 필요) |
| 4 | **모드 만들기**(골격 생성) | 런처 | 3분 | ✅ |
| 5 | 로직 작성(`loader.js`) | 편집기 | 필요에 따라 | ✅ |
| 6 | 로컬 테스트(활성화 / 로그 확인) | 런처 | 5분 | 🟩 권장 |
| 7 | **공개하고 마켓에 등록**(패키징 → 내 저장소로 push → 심사 PR 생성, 클릭 한 번) | 런처 | 1분 | ✅ |
| 8 | 새 버전 공개(버전 번호 변경 → 「공개」 다시 클릭) | 런처 | 1분 | 🟩 권장 |

> 🟦 **한 번만 vs 매번**: 1~4단계는 한 번만 하면 되고, 이후에는 버전마다 **7단계**만 거칩니다(패키징, 저장소 push, 심사 PR을 한 번에 처리. 3부 참고).

---

# 1부: 준비(한 번만)

## 1단계 ✅ 환경 확인

1. 런처 실행 → **환경 자가 점검**: Node.js / 의존성 / 클라이언트 경로 등 9개 항목. 빨간 항목부터 해결하세요.
2. EveJS 서버 루트(`server/`, `config/` 포함)를 확인합니다. 런처 → **설정 센터**에서 현재 사용 중인 경로를 볼 수 있습니다.
3. **`mods/` 폴더**가 있는지 확인합니다. 없다면 모드 / 플러그인 → **mods/ 자동 생성**.

🟨 **주의**: 모드 폴더는 `<EveJS 루트>/mods/<모드 ID>/` 로 고정입니다. **다른 곳에 두지 마세요**. 한글 등 비ASCII 폴더 이름으로도 바꾸지 마세요.

---

## 2단계 ✅ 제작자 아이덴티티 만들기(「내가 누구인지」의 증명)

모드 / 플러그인 → 상단 **토큰 설정**(제작자 아이덴티티와 GitHub 토큰이 같은 창에 있습니다):

1. **처음 열면 Ed25519 키 쌍이 자동 생성됩니다**(누를 버튼 없음)
2. **표시 이름**을 바꿉니다(사람에게 보이는 이름, 예: 「사령관」) → **표시 이름 저장**
3. **키 내보내기** 클릭 → `.eve-key` 파일로 **안전한 곳**에 저장(USB 메모리 / 비밀번호 관리자)
4. 다른 PC로 옮길 때: 새 PC에서 **키 가져오기**를 눌러 이 `.eve-key`를 고르면 아이덴티티가 복원됩니다
5. **키 폴더** 버튼으로 개인 키가 있는 폴더(`_launcher/data/mod-keys/`)를 바로 열 수 있습니다

얻게 되는 것은 세 가지입니다:

| 항목 | 설명 | 보관 필요 여부 |
| --- | --- | --- |
| **제작자 ID**(`au-...`) | 모드 매니페스트에 적히며 「이 모드는 당신의 것」을 뜻합니다 | 자동으로 매니페스트에 기록됨 |
| **키 지문**(`keyId`, 12자) | 서명 검증에 사용합니다 | 자동으로 매니페스트에 기록됨 |
| **`.eve-key` 파일** | 내용은 **개인 키**입니다 | 🟥 **반드시 잘 보관해야 함** |

🟥 **위험**:
- **`.eve-key`는 곧 당신의 신원입니다.** 잃어버리면 **다시는 업데이트에 서명할 수 없습니다**(기존 사용자에게는 "서명 실패"로 보입니다). 유출되면 다른 사람이 당신인 척 공개할 수 있습니다.
- `.eve-key`나 `_launcher/data/mod-keys/*.key`를 GitHub에 커밋하거나, 남에게 보내거나, ZIP에 넣지 **절대** 마세요.

🟩 **권장**: PC를 옮길 때는 「키 가져오기」로 `.eve-key`를 되돌리면 아이덴티티가 복원됩니다.

---

## 3단계 ✅ GitHub 토큰 만들기(공개와 제출 모두 필요)

런처가 당신을 대신해 GitHub를 조작합니다. **공개**할 때는 내 저장소에 파일을 쓰고 Release를 만들고 ZIP을 업로드하며, **등록 신청**할 때는 인덱스 저장소 `diguo520/EVEjs-mods`(관리자 명의)를 포크하고 PR을 엽니다. **classic 토큰** 하나로 둘 다 처리할 수 있습니다.

### 3.1 올바른 페이지 열기 🟨

```
GitHub 오른쪽 위 아이콘 → Settings → 왼쪽 칼럼 맨 아래 Developer settings
  → Personal access tokens → Tokens (classic) → Generate new token (classic)
```

아래 그림대로 클릭하세요(번호는 페이지의 빨간 원과 대응합니다):

![GitHub classic 토큰 페이지: ① Tokens (classic) ② Generate new token (classic) ③ Note ④ Expiration ⑤ repo 체크](./github-token-classic.png)

| 번호 | 어디를 클릭 / 무엇을 입력 |
| --- | --- |
| ① | 왼쪽 칼럼 **Tokens (classic)** —— 위쪽의 Fine-grained tokens가 아닙니다 |
| ② | **Generate new token** → **Generate new token (classic)** |
| ③ | **Note**: 아무거나, 예 `evejs-launcher` |
| ④ | **Expiration**: 90일 권장(만료되면 다시 생성) |
| ⑤ | **Select scopes**에서 **repo** 체크(`public_repo`는 그 하위 항목이며, repo를 켜면 함께 포함됩니다) |

🟥 **fine-grained(세분화) 토큰은 쓰지 마세요**: 그 Repository access는 「당신에게 권한이 있는 저장소」만 고를 수 있어 관리자 명의의 인덱스 저장소 `EVEjs-mods`를 고를 수 없습니다. 포크 생성과 PR 생성에는 이 저장소에 대한 쓰기 권한이 필요하므로, 세분화 토큰으로 제출하면 반드시 `403 Resource not accessible by personal access token` 로 실패합니다.

### 3.2 기본 정보 입력

| 항목 | 입력 내용 |
| --- | --- |
| Note | 아무거나, 예 `evejs-launcher` |
| Expiration | 90일 권장 또는 사용자 지정(만료 후 다시 생성) |

### 3.3 scope 체크(핵심) 🟨

| scope | 체크 여부 | 역할 |
| --- | --- | --- |
| **public_repo** | 🟩 필수 | 공개 저장소 읽기/쓰기: Release 생성, ZIP 업로드, 포크 생성, PR 생성 전부 |
| **repo** | 🟨 권장 | public_repo를 포함합니다. 런처가 저장소를 자동 생성하거나 비공개 저장소를 관리하길 원하면 체크 |

### 3.4 생성하고 복사

**Generate token** 클릭 → `ghp_...` 문자열을 복사(🟨 **한 번만 표시**됩니다. 페이지를 닫으면 볼 수 없습니다).

### 3.5 런처에 입력

모드 / 플러그인 → **토큰 설정** → GitHub 토큰 항목 → 붙여넣기 → **저장**(로컬에 암호화 저장, 저장 후 권한 자동 검증) → 검증 통과.

> 🟦 **왜 classic인가?** 인덱스 저장소는 관리자 명의라 세분화 토큰으로는 접근할 수 없습니다. **인덱스 저장소 협력자**로 추가된 사람만 세분화 토큰을 쓸 수 있습니다: Repository access에서 `EVEjs-mods`를 고르고 **Contents = Read and write**, **Pull requests = Read and write** 로 설정하세요.

🟨 **주의**: 토큰 scope를 바꾸거나 다시 생성한 뒤에는 새 토큰을 **다시 붙여넣고 저장**해야 합니다.

---

# 2부: 모드 만들기

## 4단계 ✅ 모드 만들기(골격 생성)

모드 / 플러그인 → **모드 만들기**, 양식을 채웁니다:

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| 템플릿 | ✅ | `Welcome Broadcast (Example)`(로그인 환영 메시지가 있는 예시) / `Blank Skeleton`(빈 골격). 🟩 처음에는 예시로 한 번 돌려 보는 것을 권장 |
| 모드 이름 | ✅ | 플레이어에게 보이는 이름 |
| ID(id / 폴더 이름) | 🟩 | 이름에서 자동 생성됩니다. `a-z 0-9 - _ .` 만 허용되며, 만든 뒤에는 **바꾸지 마세요** |
| 버전 | ✅ | 기본 `1.0.0`. 새 버전은 **올려야** 합니다(8단계 참고) |
| 분류 | ✅ | 게임플레이 / 경제 / AI / 그래픽 / 도구(마켓이 이 값으로 거릅니다) |
| 태그 | ⭕ | 쉼표로 구분, 예 `채팅, 초보` |
| 요약 | 🟩 | 한 문장. 마켓 카드에 표시됩니다 |
| 상세 설명 / 기능 요점 | ⭕ | 모드의 README에 기록됩니다 |
| 관련 모드 ID | ⭕ | 어떤 모드와 관련되는지. 쉼표 또는 공백으로 구분 |
| 빌드 옵션 | — | ☑ 서버 재시작(기본 켜짐), ☑ 만든 뒤 바로 활성화(기본 켜짐), ☑ 만든 뒤 바로 서명(기본 켜짐) |

**만들기**를 누르면 `mods/` 에 다음이 생깁니다:

```
mods/<당신의 모드 id>/
├─ evejs-launcher.mod.json    ← 매니페스트(신원, 버전, 분류, 의존)
├─ loader.js                  ← 당신이 작성할 로직
├─ README.md                  ← 「상세 설명」에서 생성
└─ CHANGELOG.md               ← 버전 변경 기록
```

🟨 「만든 뒤 바로 활성화」의 **체크를 해제했을 때만** `loader.js` 가 `loader.js.disabled` 로 생성됩니다(기본은 체크 상태이므로 기본값이 곧 로드 가능한 `loader.js`). 이후 전환은 **설치됨** 탭의 스위치로 하면 됩니다 —— 스위치는 이름만 바꿉니다.

🟨 **매니페스트 필수 항목**(런처가 검증하며, 빠지면 "매니페스트 검증 실패"가 납니다):

```
schemaVersion: 3                       ← 반드시 3
id / displayName / version             ← ID / 이름 / 버전
kind: "loader"                         ← 현재 실제로 활성화할 수 있는 것은 loader 뿐
restart: "game_server"                 ← none | client | game_server | launcher
activation.strategy: "loader_rename"   ← 반드시 이 값
폴더에 loader.js 또는 loader.js.disabled 가 있어야 함
```

---

## 5단계 ✅ 로직 작성(`loader.js`)

`mods/<당신의 모드 id>/loader.js` 를 열면 골격이 이미 들어 있습니다 —— 🟩 **이 골격 자체가 실행되는 최소 예시**입니다(플레이어가 로그인하고 10초 뒤 로컬 채팅으로 메시지 한 줄을 받습니다). 그대로 고치면 됩니다.

🟥 **네 가지 절대 규칙**(골격에 모두 적혀 있습니다. 하나라도 지우면 문제가 생깁니다):

| 규칙 | 이유 |
| --- | --- |
| `setImmediate` + 진입 검사(`process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world"`, 또는 진입점이 `index.js`) | `NODE_OPTIONS` 는 npm → 서버로 층층이 상속되어 래퍼 프로세스도 당신의 파일을 읽습니다. 검사하지 않으면 잘못된 프로세스에서 동작합니다 |
| **서버의 큰 모듈을 직접 `require` 하지 않기**(`chatHub` 는 약 456MB / 645개 모듈을 끌어옵니다) | `require.cache` 에 나타난 뒤에 참조를 얻으면 캐시 적중, 추가 메모리 0 |
| `timer.unref()` | 타이머가 프로세스 종료를 붙잡지 않게 함 |
| 「한 번만 설치」 판단에 `globalThis.__xxx` 사용 | loader는 여러 번 로드됩니다. 아니면 메시지 중복, 리스너 누적 |

🟨 **경로 규칙(가장 많이 밟는 함정)**: loader 안의 `require("./src/...")` 는 **당신의 모드 폴더 기준**으로 해석되며 서버 루트가 **아닙니다** —— 그대로 쓰면 `MODULE_NOT_FOUND` 가 납니다. 올바른 방법은 먼저 서버 루트를 구하는 것입니다:

```js
const path = require("path");
const serverRoot = path.resolve(__dirname, "..", "..", "server");
const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
// 🟨 여기서 바로 require 하지 마세요 —— 서버가 스스로 로드할 때까지 기다립니다. 전체 예시는 부록 B
```

🟨 **세션 속성**: 채팅 세션의 사용자 정의 속성은 **자동으로 동기화되지 않습니다**. 직접 읽고 쓰면 "조용히 실패"할 수 있으니 `chatHub` / `sessionRegistry` 가 제공하는 인터페이스를 사용하세요.

🟩 **서버 소스를 고쳐야 하는** 모드(API 호출만으로는 부족한 경우)는 **부록 G** 를 보세요 —— 직접 `Module.prototype._compile` 을 후킹하지 마세요.

---

## 6단계 🟩 로컬 테스트

1. 모드 / 플러그인 → **설치됨** → 내 모드를 찾아 스위치를 **켜기**(만들 때 "바로 활성화"를 체크했다면 불필요)
2. 런처 → 콘솔 → **원클릭 시작**(메인 서버 + 마켓 서비스만 시작)
3. 게임에 들어가 효과 확인
4. 문제가 있으면 두 곳의 로그를 봅니다:
   - 런처 → **서버 로그**(시스템 / 메인 서버 / 마켓 서비스 / 클라이언트, INFO/WARN/ERROR 로 거를 수 있음)
   - 서버 콘솔 출력(런처 안에서 볼 수 있음)
5. 🟩 **"정말 로드되었는지, 몇 ms 걸렸는지" 확인**: 서버 출력에서 `[EveJS-MOD]` 를 검색:
   - `loader 준비 완료 <당신의 모드> 3ms` —— loader가 로드되었습니다. `loader 실패 ... :: <이유>` 라면 로드되지 않은 것입니다
   - `loaders-done total=14 failed=0 ms=1086` —— 모든 모드 로드에 걸린 총 시간
   - `<파일> N개 층 주입(A -> B 바이트)` —— 버스 패치가 적용되었습니다
   - `<id> 패치 실패, 이전 층 결과 유지: <이유>` —— 이 층은 건너뛰었습니다(다른 모드에 **영향 없음**)

   🟨 프로세스별 세부 내용과 각 층의 결과는 `_launcher/logs/mod-load-report.json` 에도 기록됩니다. "누가 파일을 바꿨는가"를 볼 때 바로 확인하세요.

### 🔧 문제 해결 빠른 표

| 증상 | 가장 가능성 높은 원인 |
| --- | --- |
| 목록에 "loader.js 없음" 표시 | 파일이 삭제되었거나 다른 이름으로 바뀜 |
| 스위치를 켰는데 저절로 꺼짐 | 매니페스트 검증 실패 / 서명이 바뀜 → 카드의 빨간 표시 확인 |
| 로그에 "모드 로드" 가 없음 | 모드가 **비활성** 상태이거나 다른 모드와 충돌해 건너뜀 |
| 로그에 `MODULE_NOT_FOUND` | `require("./src/...")` 가 서버 루트 기준으로 해석됨 —— 실제로는 당신의 모드 폴더 기준(5단계) |
| 게임에서 효과 없고 로그에도 오류 없음 | 로직이 "한 번만 설치" 판단 전에 return 했거나 `require` 경로가 잘못됨 |
| Node 메모리 급증 | 서버의 큰 모듈을 `require` 함(5단계의 함정 2) |

---

# 3부: 마켓에 공개하기

> **공개는 클릭 한 번**: 런처가 「재서명 → ZIP 패키징 → 내 저장소로 push(저장소 생성, Release 생성, ZIP 업로드) → 인덱스 저장소에 버전 심사 PR 제출」을 연달아 처리하고, 당신은 진행률만 봅니다.
> 인덱스 저장소로 가는 PR은 **버전마다 제출**합니다 —— 병합되어야 마켓이 새 버전으로 바뀝니다.

## 7단계 ✅ 공개하고 마켓에 등록(클릭 한 번)

모드 / 플러그인 → **모드 공개**(「내가 만든 모드」 카드의 「심사 제출 / 다시 제출」도 같은 창입니다):

1. **모드 선택**: 드롭다운에는 **당신이 만든 모드만** 나옵니다(잘못 제출을 막기 위해 남의 모드는 나오지 않습니다)
2. **버전 번호**와 **업데이트 설명** 입력(업데이트 설명은 인덱스와 PR에 들어갑니다. 쉬운 말로 쓰세요)
3. **분류 / 태그** 확인, **소스 / 프로젝트 주소** ⭕ 선택(예 `https://github.com/당신/당신의-모드`), **GitHub Releases 직링크** ⭕ 비워 두세요(공개할 때 올바른 주소가 생성됩니다)
4. 세 가지 선언에 체크(본인 창작 / 악성 코드 없음 / 규정과 조건 확인)
5. **공개** 클릭

창 상단의 전제 조건이 충족되어야 「공개」를 누를 수 있습니다: **표시 이름**(2단계), **GitHub 토큰**(3단계), **같은 모드의 제출 간격 30분**, **공개와 공개 사이 60초**. 빠진 항목은 그 줄이 노랗게 표시되고 보완할 입구가 나옵니다.

### 진행률의 네 단계

| 단계 | 하는 일 | 어디서 |
| --- | --- | --- |
| 로컬 패키징 | 재서명 → ZIP 패키징 → SHA256 계산 → 마켓용 매니페스트 생성 | **전부 로컬**: 네트워크 없음, 토큰 불필요 |
| 소스 저장소 준비 | 저장소가 없으면 공개 저장소 생성 | 당신의 GitHub |
| Release 공개 및 패키지 업로드 | `evejs-mod.json` 기록(마켓이 읽는 값) → Release 생성(tag = `v<버전>`) → `<id>-<버전>.zip` 업로드 | 당신의 GitHub |
| 버전 심사 PR 제출 | 인덱스 저장소로 PR: 처음에는 `sources.json`(등록)도 함께, 이후에는 버전마다 `mods/<id>.json` 만 갱신 | 인덱스 저장소 `diguo520/EVEjs-mods` |

산출물과 대장:

| 산출물 | 위치 |
| --- | --- |
| ZIP 패키지 | `_launcher/temp/export-<id>-<version>.zip`(같은 파일이 당신의 Release에도 업로드됩니다) |
| 제출 대장 | `_launcher/data/my-submissions.json` |

🟨 **코드를 바꾸면 「공개」를 다시 누르세요**: 내용이 바뀌면 서명이 무효가 됩니다. 런처가 다시 서명하고, 다시 패키징하고, 새 버전을 push합니다.

### 🔧 이 단계에서 흔한 오류

| 오류 | 원인 | 해결 |
| --- | --- | --- |
| 🟥 `403 Resource not accessible by personal access token` | 토큰이 fine-grained이거나 classic에 public_repo가 없음 | classic 토큰에 **public_repo** 를 체크하세요. 인덱스 저장소는 관리자 명의라 세분화 토큰으로는 닿지 않습니다. 이미 인덱스 저장소 협력자라면: 세분화 토큰에 `EVEjs-mods` + Contents / Pull requests = Read and write |
| 🟥 `net::ERR_INVALID_ARGUMENT` | 구버전 런처의 ZIP 업로드 버그 | **0.1.20+** 로 업그레이드 |
| 🟥 `404` | 저장소가 없거나 토큰이 그것을 포함하지 않음 | owner/repo 철자를 확인하고 classic 토큰(public_repo / repo)을 사용 |
| 🟥 `GitHub 토큰이 입력되지 않았습니다` | 토큰 미저장 | 3.5단계로 돌아가기 |

🟩 **성공 후**: 창에 저장소 주소와 Release 주소가 표시됩니다(열어서 ZIP이 있는지 확인 가능). 카드는 **심사 중** 으로 바뀝니다.

### 심사와 병합

- 관리자가 PR에서 모드를 심사합니다(매니페스트 항목, 분류, ZIP 위치, 버전 번호 등)
- **통과(병합)**: 인덱스 CI가 즉시 재구성되고, 마켓이 당신의 버전으로 바뀌며, 모든 런처에서 검색됩니다
- **불통과**: 관리자가 PR에 이유를 답하고, **내가 만든 모드** 의 카드가 빨개지며 **등록 거부 이유** 가 적힙니다

🟨 **같은 모드는 최소 30분 간격으로만 제출할 수 있습니다**: 연달아 누르면 Release를 중복 push하고 같은 PR을 반복해서 새로 고칩니다. 창에 남은 시간이 표시되고, 그 전까지 버튼은 회색입니다.

🟦 제출 후 런처는 이 PR을 **한 번 더 확인**해 실제로 열렸는지 확인하고 번호와 상태를 대장에 기록합니다:
「내가 만든 모드」 카드에 `심사 중 / 병합됨 / PR 닫힘` 이 표시됩니다(이 상태는 최대 30분에 한 번만 다시 확인해 GitHub에 자주 부담을 주지 않습니다).

---

## 8단계 🟩 새 버전 공개(버전 변경 → 「공개」 다시 클릭)

1. 버전 번호 변경: `mods/<id>/evejs-launcher.mod.json` 의 `"version"` 을 편집(예 `1.0.1`)
   🟨 **모드 만들기** 에서 같은 id로 다시 생성해도 됩니다 —— 단, **id는 바꾸지 마세요**
2. 모드 / 플러그인 → **모드 공개** → 내 모드 선택 → 버전과 업데이트 설명 입력 → **공개**
   (같은 저장소, 새 tag `v1.0.1`, 새 ZIP `<id>-1.0.1.zip`, 같은 `release/<id>` 브랜치가 PR을 갱신)

🟨 **왜 버전을 올려야 하나**: 마켓은 버전 번호로 "새 버전이 있는지"를 판단합니다. 번호가 그대로면 남의 런처가 업데이트를 알리지 않습니다.

🟦 **왜 ZIP 파일 이름에 버전을 넣나**: jsDelivr는 브랜치 참조를 최대 약 12시간 캐시합니다. 새 파일 이름이면 예전 캐시에 걸리지 않습니다.

---

# 4부: 심사, 내림, 복구

## 관리자는 무엇을 심사하나

| 점검 항목 | 요구 사항 |
| --- | --- |
| 저장소 귀속 | 반드시 당신 자신의 저장소여야 함 |
| 매니페스트 완전성 | `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` / `sizeBytes` / `sha256`(64자 hex) / `downloadUrls[]` |
| ZIP 위치 | **당신 자신의 Release**(인덱스 저장소는 바이너리를 저장하지 않음) |
| 분류 | 게임플레이 / 경제 / AI / 그래픽 / 도구 중 하나 |
| 귀속 강제 규칙 | `id` 는 선착순, `author.id` 는 키에 묶임(키를 바꾸면 거부) |
| 서버 소스 패치 | 서버 파일을 고치는 모드는 `__evejsMods.register`(부록 G)를 사용해야 함. 직접 `Module.prototype._compile` 을 후킹하면 수정 요구를 받습니다 —— 여러 모드가 각자 후킹하면 서로를 덮어씁니다 |

## 심사 결과는 어디서 보나

런처 → 모드 / 플러그인 → **내가 만든 모드**:

| 카드 상태 | 의미 | 할 수 있는 일 |
| --- | --- | --- |
| 🟩 마켓 등록됨 | 마켓에 들어감 | 새 버전을 공개하면 됩니다 |
| 🟨 업데이트 가능 / 로컬이 등록본보다 새로움 | 로컬 버전이 마켓보다 새로움 | 8단계 진행 |
| 🟧 내려감 | 관리자가 내림 | 카드에 **내림 사유** 가 있습니다. 고친 뒤 **심사 다시 제출** |
| 🟥 등록 거부 | 심사를 통과하지 못함 | 카드에 **등록 거부 이유** 가 있습니다. 고친 뒤 **심사 다시 제출** |
| ⬜ 로컬만 / 제출 대기 | 아직 미공개 | 7단계 진행 |

🟦 **내가 만든 모드** 에는 "로컬에 아직 있거나 마켓에서 여전히 설치 가능한" 항목만 나옵니다. 로컬 폴더를 지우면 심사 기록만 남은 항목은 자동으로 숨겨집니다(제목 표시줄에 "N개 숨김" 안내).

---

# 부록: 핵심 주의 사항(🟥 이 부분만 저장해 두면 충분)

| # | 항목 | 결과 |
| --- | --- | --- |
| 1 | 🟥 남의 모드를 내 것처럼 제출하지 않기(`author.id` 가 내 것이 아니면 메인 프로세스가 바로 거부) | 제출 실패 |
| 2 | 🟥 `.eve-key` / 개인 키는 절대 외부에 주지 않고, 커밋하지 않고, ZIP에 넣지 않기 | 신원 도용 또는 업데이트 능력 완전 상실 |
| 3 | 🟥 디스크에서 서버 파일을 고치지 않기 | 남의 `server/` 를 직접 고치면 설치되지 않고 업그레이드마다 깨집니다. 메모리에서 고치려면 `__evejsMods.register`(부록 G) |
| 4 | 🟥 loader에서 서버의 큰 모듈을 `require` 하지 않기 | Node 메모리 급증 |
| 5 | 🟨 버전 번호는 올리기만 하기 | 남들이 업데이트를 받지 못함 |
| 6 | 🟨 코드를 바꾸면 「공개」를 다시 클릭(재서명, 재패키징, 재push는 자동) | 서명 무효 / 마켓은 옛 패키지 유지 |
| 7 | 🟨 만든 뒤 `id` 를 바꾸지 않기 | 기존 사용자 쪽에서는 "삭제 + 새로 설치"가 됩니다 |
| 8 | 🟨 ZIP 파일 이름에 버전 넣기 | 아니면 CDN 캐시에 걸려 옛 패키지를 받을 수 있습니다 |
| 9 | 🟨 분류는 고정된 다섯 값만 사용 | 마켓 필터에서 보이지 않습니다 |
| 10 | 🟦 loader는 한 번만 설치(`globalThis` 판단) | 아니면 중복 등록, 메시지 중복 |

---

# 부록 A: 매니페스트 항목 전체 표(`evejs-launcher.mod.json`)

| 항목 | 필수 | 형식 | 설명 |
| --- | --- | --- | --- |
| `schemaVersion` | ✅ | number | 고정 `3` |
| `id` | ✅ | string | 모드 ID, 128자 이하, 경로 구분자 불가, `a-z0-9-` 권장 |
| `displayName` | ✅ | string | 표시 이름, 100자 이하 |
| `version` | ✅ | string | 버전 번호, 64자 이하, 예 `1.0.0` |
| `kind` | ✅ | string | `loader`(사용 가능) / `settings` / `client-package` / `source-integrated`(이후 버전) |
| `restart` | ✅ | string | `none` / `client` / `game_server` / `launcher` |
| `activation.strategy` | ✅ | string | `loader_rename` |
| `description` | ⭕ | string | 요약, 1000자 이하(마켓 카드에 표시) |
| `category` | 🟩 | string | 게임플레이 / 경제 / AI / 그래픽 / 도구 |
| `tags` | ⭕ | string[] | 태그 |
| `author` | ✅ | object | `{ id, name, keyId, publicKey }`(런처가 자동 기록) |
| `requires` / `loadAfter` / `loadBefore` / `conflicts` | ⭕ | string[] | 의존과 충돌(모드 id 기입) |
| `compatibility.evejsVersions` | ⭕ | string[] | 호환 EveJS 버전, 예 `["0.12.8"]` |
| `signature` | ✅ | object | 서명(런처가 자동 생성) |

# 부록 B: 실제로 동작하는 loader 골격

이것은 「모드 만들기」 가 생성하는 골격의 **간략판** 입니다 —— 네 가지 절대 규칙이 모두 들어 있고, 고쳐서 바로 쓸 수 있습니다(주석이 달린 전체 버전은 `mods/<당신의 모드 id>/loader.js` 참고):

```js
"use strict";
const path = require("path");

const TAG = "[내-모드]";
const MOD_ID = "my-mod";
const POLL_MS = 3000;
const GRACE_MS = 10000;                      // 로그인 후 이만큼 기다림: 세션이 먼저 준비되어야 함
const MESSAGE = "돌아오신 것을 환영합니다, 파일럿!";

// 서버 소스를 고치려면 이 블록을 여세요(새 방식: 버스에 신고하고 덧붙이기만):
//   target —— EveJS 루트 기준 상대 경로, 슬래시 사용
//   marker —— 고유 표식. 이미 있으면 버스가 그 층을 건너뜀(멱등)
//   slot   —— 같은 파일에 여러 층이 있을 때의 순서, 작을수록 앞(10의 배수 권장)
//   append —— 덧붙일 코드만. 전체를 다시 쓰지 않음
const SOURCE_PATCH = null;
// const SOURCE_PATCH = {
//   target: "server/src/network/tcp/handshake.js",
//   marker: "// my-mod:patch",
//   slot: 40,
//   append: "// my-mod:patch\nconsole.log('[my-mod] patched');",
// };

console.log(TAG + " preload 실행됨 · pid=" + process.pid);

/** 진짜 서버 프로세스에서만 계속(npm / 래퍼 프로세스 제외) */
function isRealServerProcess() {
  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world") return true;
  const entry = (require.main && require.main.filename) || process.argv[1] || "";
  return /(^|[\\/])index\.js$/i.test(entry);
}

/** 소스 패치를 주입 버스에 등록(🟥 반드시 동기 실행, 이유는 아래) */
function registerSourcePatch() {
  if (!SOURCE_PATCH || !SOURCE_PATCH.target) return;
  const bus = globalThis.__evejsMods;
  if (!bus || !(Number(bus.api) >= 1)) {
    console.log(TAG + " 구버전 런처에는 주입 버스가 없어 소스 패치를 건너뜁니다");
    return;
  }
  bus.register({
    id: MOD_ID,
    target: SOURCE_PATCH.target,
    marker: SOURCE_PATCH.marker,
    slot: SOURCE_PATCH.slot,
    apply: (source) => source + "\n" + SOURCE_PATCH.append + "\n",
  });
}
// 🟥 동기 등록: 서버는 시작할 때 대상 파일을 require 하므로,
//    setImmediate 안에서 등록하면 이미 컴파일된 뒤라 패치가 적용되지 않습니다
registerSourcePatch();

setImmediate(() => {
  if (!isRealServerProcess()) return;
  if (globalThis.__myModStarted) return;      // 🟨 여러 번 로드됨: 한 번만 설치
  globalThis.__myModStarted = true;
  start();
});

function start() {
  // 🟥 require("./src/...") 는 **당신의 모드 폴더** 기준이며 서버 루트가 아님 —— 먼저 루트를 계산
  const serverRoot = path.resolve(__dirname, "..", "..", "server");
  const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
  const registryPath = path.join(serverRoot, "src", "services", "chat", "sessionRegistry.js");

  // 🟨 서버가 이 두 모듈을 require.cache 에 넣을 때까지 기다린 뒤 참조를 얻습니다:
  //    캐시 적중, 추가 메모리 0, 456MB 모듈 그래프를 미리 끌어오지 않음
  const timer = setInterval(() => {
    if (!require.cache[require.resolve(hubPath)]) return;
    if (!require.cache[require.resolve(registryPath)]) return;
    clearInterval(timer);
    run(require(require.resolve(hubPath)), require(require.resolve(registryPath)));
  }, 500);
  timer.unref();
}

function run(chatHub, sessionRegistry) {
  const seen = new Set();
  const firstSeenAt = new Map();

  const timer = setInterval(() => {
    let sessions;
    try {
      sessions = sessionRegistry.getSessions() || [];
    } catch {
      return;
    }

    const now = Date.now();
    const online = new Set();

    for (const session of sessions) {
      const characterID = sessionRegistry.resolveSessionCharacterID(session);
      if (!characterID) continue;              // 아직 게임에 들어가지 않음, 다음 차례에
      online.add(characterID);
      if (!firstSeenAt.has(characterID)) firstSeenAt.set(characterID, now);
      if (seen.has(characterID)) continue;
      if (now - firstSeenAt.get(characterID) < GRACE_MS) continue;

      try {
        // 어떤 세션 객체는 소문자 charid 만 가지므로 한 번 보완합니다(「조용히 전송되지 않음」 방지)
        if (!Number(session.characterID || 0)) session.characterID = characterID;
        chatHub.sendSystemMessage(session, MESSAGE);
        seen.add(characterID);
        console.log(TAG + " 캐릭터 " + characterID + " 에게 메시지 전송");
      } catch (error) {
        console.log(TAG + " 캐릭터 " + characterID + " 가 아직 준비되지 않음, 나중에 재시도: " + error.message);
      }
    }

    // 오프라인 캐릭터 정리. 다음 로그인에서 다시 발동
    for (const id of Array.from(seen)) if (!online.has(id)) seen.delete(id);
    for (const id of Array.from(firstSeenAt.keys())) if (!online.has(id)) firstSeenAt.delete(id);
  }, POLL_MS);
  timer.unref();
}
```

🟨 위에서 사용한 서버 인터페이스는 **실측으로 사용 가능함을 확인**한 것입니다:

| 인터페이스 | 용도 |
| --- | --- |
| `sessionRegistry.getSessions()` | 온라인 세션 배열(🟥 `list()` 가 **아닙니다**. 그 메서드는 없습니다) |
| `sessionRegistry.resolveSessionCharacterID(session)` | 캐릭터 ID 조회(게임에 들어가기 전에는 0) |
| `chatHub.sendSystemMessage(session, "메시지")` | 해당 캐릭터의 로컬 채널로 시스템 메시지 전송 |

EveJS 버전에 따라 인터페이스가 달라질 수 있으니, 당신 버전의 실제 export를 기준으로 하세요.

# 부록 C: 충돌과 로드 순서

| 유형 | 발생 방식 | 결과 |
| --- | --- | --- |
| 선언된 충돌 | 매니페스트의 `conflicts` 가 서로를 적음 | 두 모드가 동시에 활성화되지 않음 |
| `id` 중복 | 두 폴더의 매니페스트 `id` 가 같음 | 하나만 로드됨 |
| 서버 모듈 공유 | 여러 loader가 같은 서버 모듈을 참조 | 서로 영향을 줄 수 있음(런처가 경고) |
| 의존 누락 | `requires` 의 모드가 미설치 | 그 모드는 로드되지 않음 |

🟦 로드 순서: **설치됨** 에서 카드를 **드래그**해 정렬하거나, 카드 왼쪽 위의 「⤓ 맨 뒤로 이동」을 누르면 됩니다. 목록은 「활성 먼저, 비활성 나중」으로 나뉘고 각 구간은 사용자가 정한 순서입니다 —— 모드를 꺼도 다시 정렬할 필요가 없고, 다시 켜면 원래 자리로 돌아옵니다.
🟨 매니페스트의 `loadAfter` / `loadBefore` 가 **우선순위가 더 높아** 드래그한 순서에 끼어들어 미세 조정합니다. 위치가 바뀐 모드는 「로드 순서」 패널에서 「매니페스트 제약으로 이동됨」으로 표시됩니다.
🟦 「로드 순서」 패널은 **실제로 적용되는** 순서와 함께, **이번에 로드되지 않는** 모드(매니페스트 오류 / 의존 누락 / 충돌 / loader.js 없음)와 **효력이 없던 순서 선언**(대상 미설치 또는 비활성, 저장된 순서의 폴더가 삭제됨)을 따로 보여 줍니다. 변경은 **서버를 다시 시작해야** 적용됩니다.

## 🟥 여러 모드가 같은 서버 파일을 고치는 경우(새 런처에 해결책이 있습니다)

모드가 **스스로 `Module.prototype._compile` 을 후킹**해 서버 소스를 고치면, 두 모드가 같은 파일을 건드리는 순간 문제가 생깁니다:

- 누가 원본 파일을 먼저 보는지는 전적으로 로드 순서에 달려 있습니다;
- 한쪽이 "파일 전체의 sha256"으로 검증하면, 다른 쪽이 이미 내용을 덧붙였기 때문에 **검증에 실패**합니다;
- 실제로 관측된 사례: `자동 채굴` 과 `자동 록온·자동 집중포화` 가 모두 `server/src/network/tcp/handshake.js` 끝에 코드를 덧붙였고, 먼저 주입된 쪽이 쓴 뒤 나중 쪽은 해시가 맞지 않아 **조용히 포기**했습니다(오류도 없고 효과도 없음).

🟩 새 런처는 이를 위해 **주입 버스**를 제공합니다: 모드가 각자 후킹하지 않고 `__evejsMods.register` 로 "어느 파일에 무엇을 더할지"를 선언하면, 버스가 `(slot, 등록 순서)` 로 하나의 체인을 만듭니다 —— 각 층은 **앞 층이 바꾼 뒤**의 내용을 봅니다. 사용법은 **부록 G**.

# 부록 D: ZIP 구조와 가져오기 규칙

### ZIP 구조(둘 다 지원, 방식 2 권장)

```text
방식 1: 루트에 매니페스트 바로 두기        방식 2: 한 겹 폴더로 감싸기(권장)
my-mod.zip                          my-mod.zip
├── evejs-launcher.mod.json          └── my-mod/
├── loader.js.disabled                   ├── evejs-launcher.mod.json
└── README.md                            ├── loader.js.disabled
                                          └── README.md
```

런처가 패키지 루트를 자동으로 찾습니다. ZIP 안에 **여러** 모드 패키지가 있으면 거부됩니다(한 번에 하나만).

### 남이 당신의 ZIP을 가져올 때의 규칙

| 규칙 | 설명 |
| --- | --- |
| 설치 위치 | `<EveJS 루트>/mods/<매니페스트 id>`(id의 잘못된 문자는 `-` 로 치환) |
| 초기 상태 | **강제 비활성**(`loader.js` 는 `loader.js.disabled` 로 되돌아감). 사용자가 수동으로 켬 |
| 이름 충돌 | `mods/` 에 같은 이름 폴더가 있음 → 가져오기 거부 및 안내 |
| 매니페스트 누락 | ZIP에 `evejs-launcher.mod.json` 이 없음 → 거부 |

### 🟨 용량

모드 페이지는 **각 모드의 사용 용량을 재귀적으로 집계**합니다. 실행에 필요한 파일만 패키징하세요 —— 🟥 소스 저장소, `node_modules`, 스크린샷, `.git` 을 ZIP에 넣지 마세요.

# 부록 E: loader는 어떻게 주입되나

🟩 **현재(주입 버스 경유)**: 런처는 `NODE_OPTIONS` 에 `--require "<런처에 포함된 mod-host.js>"` 를 **하나만** 넣고, 당신의 `loader.js` 는 버스가 `_launcher/mods/mod-plan.json` 순서대로 `require` 합니다. 그래서 모드 폴더 이름에 비ASCII나 공백이 있어도 문제없습니다. 런처 로그의 `[EveJS-MOD] loaders-done total=N failed=0 ms=X` 가 "모든 모드 로드에 걸린 밀리초"입니다.

🟨 **아래는 "loader마다 `--require` 하나" 라는 옛 방식** 입니다(현재는 버스 플랜 기록이 실패했을 때의 보험용): 런처는 Node의 `NODE_OPTIONS=--require ...` 로 당신의 `loader.js` 를 서버 프로세스에 주입합니다. 따라서:

- 🟥 **역슬래시가 이스케이프로 먹혀 사라집니다** → `C:\mods\x\loader.js` 는 `C:modsxloader.js` 가 됩니다
- 🟨 `NODE_OPTIONS` 는 공백으로 나뉘므로, **공백이 있는 경로는 따옴표로 감싸야 합니다**

올바른 방법은 "경로를 슬래시로 바꾸고 + 큰따옴표로 감싸기" —— 런처 내부도 이렇게 조립합니다(실측 확인):

```js
const requireArgs = paths.map((p) => '--require "' + p.replace(/\\/g, "/") + '"').join(" ");
```

🟦 당신이 직접 이걸 조립할 **필요는 없습니다** —— "모드 폴더에 비ASCII나 공백을 넣지 않는다" 정도만 기억하면 문제 해결 때 맞춰 볼 수 있습니다.

# 부록 F: 공개 전 점검표

- [ ] 모드가 로컬에서 활성화되고 효과가 있다(6단계에서 확인)
- [ ] 서버 소스를 고치는 모드는 `__evejsMods.register`(부록 G)를 쓰고, 직접 `_compile` 을 후킹하지 않는다
- [ ] `evejs-launcher.mod.json` 의 `id` / `version` / `category` 가 맞다
- [ ] 버전 번호가 **이전 버전보다 크다**
- [ ] `.eve-key` 를 백업했다(PC 이동에 필요)
- [ ] `mods/<id>/` 에 개인 키나 본인 로컬 경로 등 사적인 내용이 없다
- [ ] **모드 공개** 를 눌러 네 단계를 모두 통과했고, ZIP을 내 Release 페이지에서 받을 수 있다
- [ ] 이 버전이 인덱스 저장소에 연 review PR 이 **병합되었다**(미병합 = 마켓은 이전 버전 그대로)


# 부록 G: 서버 소스 고치기 —— 주입 버스 `__evejsMods.register`

🟨 **서버 소스를 반드시 고쳐야 하는** 모드에만 필요한 부분입니다. 「로그인 인사」처럼 서버 API만 호출하는 모드는 부록 B로 충분합니다.

버스는 런처가 주입합니다. 모드 쪽에서는 파일 끝에 선언만 하면 됩니다:

```js
const bus = globalThis.__evejsMods;
if (bus && bus.api >= 1) {
  bus.register({
    id: "당신의 모드 id",                            // 매니페스트의 id 와 동일, 보고서에서 표식으로 사용
    target: "server/src/network/tcp/handshake.js",  // EveJS 루트 기준 상대, 슬래시
    marker: "MY_MOD_MARK",                         // 고유 표식: 이미 주입되었으면 자동 건너뜀(멱등)
    slot: 10,                                      // 같은 파일에 여러 층일 때 순서, 작을수록 앞
    apply: (source) => source + "\n// MY_MOD_MARK\n// 여기에 덧붙일 코드를 씁니다\n",
  });
} else {
  // 구버전 런처에는 버스가 없음: 직접 후킹으로 되돌리거나 아무것도 주입하지 않습니다
}
```

네 가지 약속(🟥 하나라도 어기면 다른 모드가 이유 없이 망가집니다):

| 약속 | 이유 |
| --- | --- |
| `register` 만 사용하고 **직접** `Module.prototype._compile` 을 후킹하지 않기 | 직접 후킹하면 다시 "주입 지점 쟁탈전"이 되고, 버스도 당신의 변경을 보지 못합니다 |
| `apply` 는 **덧붙이기만**. 기존 내용을 다시 쓰거나 지우지 않기 | 뒤 층이 당신의 결과를 받아 계속 덧붙여야 합니다 |
| `marker` 는 남이 쓰지 않는 고유 문자열로 | 버스가 이것으로 주입 여부를 판단해 재시작 시 겹쳐 쌓이지 않습니다 |
| 검증하려면 **변경 전 접두사**(또는 길이)를 볼 것. 파일 전체 sha256은 쓰지 말 것 | 여러 층 체인에서는 전체 해시가 절대 맞지 않아 스스로를 막습니다 |

🟩 결과 보는 법: 로그의 `[EveJS-MOD] <파일> N개 층 주입(A -> B 바이트)` 는 이 층이 적용되었다는 뜻이고, `[EveJS-MOD] <id> 패치 실패, 이전 층 결과 유지: <이유>` 는 이 층이 건너뛰어졌다(**다른 모드에는 영향 없음**)는 뜻입니다.

---

**문서 버전**: 런처 릴리스에 맞춰 갱신됩니다(런처의 `_launcher/mods/MOD_AUTHORING.ko.md` 와 동기화).
여기에 없는 상황이라면 먼저 런처의 **서버 로그** 와 카드의 빨간 표시를 확인하고, 로그를 가지고 관리자에게 문의하세요.
