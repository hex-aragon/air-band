# Air Band 코드 설명서

보드 버튼을 한 번 누르면 브라우저에서 드럼 소리가 나기까지, 코드가 어떤 순서로 실행되는지 따라가며 설명합니다.
각 소스 파일에도 `[한눈에 보기]`, `[설명]`으로 시작하는 주석을 달아 두었으니, 이 문서와 코드를 나란히 열고 보세요.

---

## 0. 파일 지도

```
air-band/
├ firmware/air_band_right/air_band_right.ino   ← 보드 프로그램 (C++ / 아두이노)
└ web/                                         ← 브라우저 프로그램 (TypeScript)
   ├ index.html        화면 뼈대 + 스타일(CSS)
   ├ src/main.ts       진입점. 모든 입력을 받아 소리·화면·로그로 보냄
   ├ src/ble.ts        블루투스 연결, 8바이트 패킷 해석
   ├ src/audio.ts      드럼 소리 만들기·재생 (Web Audio)
   ├ src/visual.ts     물결 애니메이션 (Canvas)
   ├ vite.config.ts    개발 서버 설정
   └ package.json      사용하는 도구 목록 (TypeScript, Vite)
```

역할 분담은 한 줄로 이렇게 됩니다.

> **보드는 "언제 · 어떤 드럼을 · 얼마나 세게" 쳤는지만 판단해 8바이트로 보내고, 소리는 브라우저가 낸다.**

---

## 1. 버튼 한 번 누를 때 일어나는 일 (전체 흐름)

```
 ① 보드 버튼 2 누름
      │  핀 P0.12가 HIGH → LOW
 ② pollButtons()          [펌웨어, loop 안에서 약 1ms마다]
      │  "안 눌림 → 눌림" 감지, 디바운스 통과
 ③ emitHit(1, 100, 시각)   [펌웨어]
      │  8바이트 패킷 만들어 큐에 넣고 LED1 30ms 켬
 ④ bleSendLoop()          [펌웨어, 별도 태스크]
      │  큐에서 꺼내 bleuart.write() → 무선 전송 (notify)
 ⑤ handleNotify()         [web/src/ble.ts]
      │  수신 시각 기록 → parsePackets()로 해석 → onHit 호출
 ⑥ handleHit()            [web/src/main.ts]
      ├ audio.play(1, 100)   킥 소리 재생   [audio.ts]
      ├ visual.hit()         보라색 물결    [visual.ts]
      ├ flashPad(1)          킥 패드 반짝
      └ addLog()             "kick 보드 100" 한 줄 추가
```

아래에서 각 단계를 코드와 함께 봅니다.

---

## 2. 펌웨어 (air_band_right.ino)

### 2-1. 아두이노 프로그램의 기본 구조

```cpp
void setup() { ... }   // 전원 켜지면 한 번
void loop()  { ... }   // 그 뒤로 무한 반복
```

이 보드는 FreeRTOS(작은 운영체제) 위에서 돌기 때문에, `loop()` 외에 **태스크**를 하나 더 동시에 돌릴 수 있습니다. 우리는 BLE 전송을 별도 태스크로 떼어 놓았습니다 (2-6에서 설명).

### 2-2. setup(): 켜질 때 준비

```cpp
Serial.begin(115200);                // USB 시리얼 (로그 출력용)
Wire.begin();                        // I2C 시작 (IMU 통신용)
i2cScan();                           // 연결된 I2C 장치 주소 출력

while (!imuBegin()) {                // IMU 찾기
  if (ENABLE_BUTTONS && ++tries >= IMU_BOOT_TRIES) break;   // 3번 실패하면 버튼 모드로
  ...
}
buttonsBegin();                      // 버튼 핀 4개를 INPUT_PULLUP으로
g_hitQueue = xQueueCreate(8, sizeof(HitPacket));   // 전송 대기 우체통(8칸)
bleBegin();                          // BLE 시작 + 광고
Scheduler.startLoop(bleSendLoop);    // 전송 태스크 시작
```

지금은 IMU가 없어서 로그가 이렇게 나옵니다.

```
[I2C] scan: 0x6A                      ← 보드의 전원 칩 (IMU 아님)
[IMU] 없음 — 버튼 전용 모드로 동작
[BTN] 버튼 1~4 → 드럼 0~3 (스네어/킥/하이햇/탐)
[BLE] 광고 시작: AirBand-R
```

### 2-3. 버튼 읽기: pollButtons()

**풀업과 active-low**: 버튼 한쪽은 핀, 다른 쪽은 GND에 연결되어 있습니다. `INPUT_PULLUP`으로 설정하면 칩 안의 저항이 핀을 3.3V로 당겨 두므로,

| 상태 | 핀 값 |
|---|---|
| 안 누름 | HIGH (1) |
| 누름 | LOW (0) |

진단 펌웨어로 네 버튼(P0.11, P0.12, P0.24, P0.25) 모두 이렇게 동작하는 것을 확인했습니다.

**디바운스**: 기계식 버튼은 누르는 순간 접점이 몇 ms 동안 떨립니다. 그래서 상태가 바뀐 뒤 25ms 동안은 다음 변화를 무시합니다.

```cpp
bool pressed = digitalRead(BUTTON_PINS[i]) == LOW;          // 누르면 LOW
if (pressed == g_btnPressed[i]) continue;                   // 변화 없음
if (nowMs - g_btnChangedMs[i] < BUTTON_DEBOUNCE_MS) continue;  // 25ms 안의 떨림은 무시
g_btnPressed[i]   = pressed;
g_btnChangedMs[i] = nowMs;
if (!pressed) continue;                                     // 손 뗄 때는 안 보냄
emitHit(i, BUTTON_VELOCITY, nowMs);                         // 버튼 i → 드럼 i, 세기 100
```

### 2-4. IMU 타격 감지: detectHit() (센서를 연결하면 동작)

10ms마다 IMU에서 가속도 x, y, z를 읽고 크기 `√(x²+y²+z²)`를 계산합니다(단위 g, 가만히 있으면 약 1g).
직전 값이 **꼭대기(피크)** 이고 2.5g 이상이면 타격입니다.

```
     g
     │        m1  ← 꼭대기 + 2.5g 이상 → 타격!
     │       ╱  ╲
     │     m2     m0
2.5g ┼ ─ ─ ─ ─ ─ ─ ─
     └──────────────── 시간 (10ms 간격)
```

- 세기: 2.5g → 1, 12g 이상 → 127 (그 사이는 비례)
- 불응기 60ms: 스틱이 튕겨서 생기는 두 번째 피크는 무시
- `classifyHit()`: 지금은 항상 스네어(0). 2단계에서 AI 모델이 동작을 보고 드럼 종류를 고를 자리

버튼과 IMU 모두 마지막에 같은 `emitHit()`을 부릅니다. 그래서 센서를 연결해도 웹은 고칠 필요가 없습니다.

### 2-5. 패킷 만들기: emitHit() → buildPacket()

| 바이트 | 내용 | 버튼 2를 눌렀을 때 |
|---|---|---|
| 0 | hand (0 = 오른손) | `00` |
| 1 | mode (0 = 드럼) | `00` |
| 2 | class (드럼 종류) | `01` (킥) |
| 3 | velocity (세기) | `64` (= 100) |
| 4~7 | 보드 시각 `millis()` | 예: 112389ms → `05 B7 01 00` |

4바이트 시각은 **작은 자리부터**(little-endian) 1바이트씩 넣습니다.

```cpp
p.bytes[4] = (uint8_t)(ts);          // 가장 낮은 바이트
p.bytes[5] = (uint8_t)(ts >> 8);
p.bytes[6] = (uint8_t)(ts >> 16);
p.bytes[7] = (uint8_t)(ts >> 24);    // 가장 높은 바이트
```

### 2-6. 전송: 큐 + bleSendLoop()

`bleuart.write()`는 무선 송신 버퍼가 꽉 차면 **최대 100ms까지 기다릴 수 있습니다.** `loop()`에서 직접 보내면 그동안 버튼·센서 읽기가 멈춥니다. 그래서:

```cpp
// loop 쪽: 우체통에 넣기만 하고 바로 돌아감 (대기 0)
xQueueSend(g_hitQueue, &p, 0);

// 전송 태스크: 우체통에 뭔가 올 때까지 잠들어 있다가 꺼내서 보냄
if (xQueueReceive(g_hitQueue, &p, portMAX_DELAY) == pdTRUE) {
  if (Bluefruit.connected() && bleuart.notifyEnabled()) {   // 브라우저가 연결·구독한 상태일 때만
    bleuart.write(p.bytes, sizeof(p.bytes));
  }
}
```

**중요**: 브라우저에서 **센서 연결**을 하기 전에는 `connected()`가 false라서 버튼을 눌러도 아무것도 전송되지 않습니다 (LED1만 깜빡임).

### 2-7. BLE 설정: bleBegin()

| 용어 | 뜻 |
|---|---|
| 광고(advertising) | 보드가 "나 여기 있어요(AirBand-R)"를 주기적으로 뿌리는 것. 브라우저 목록에 뜨는 이유 |
| 연결(connection) | 브라우저가 광고를 보고 연결을 걸면 1:1 통신 시작 |
| NUS | Nordic UART Service. 시리얼처럼 바이트를 주고받는 표준 서비스 |
| notify | 보드가 데이터를 브라우저에 "밀어서" 보내는 방식 |
| 연결 간격 | 연결 후 데이터를 주고받는 주기. 7.5~15ms를 요청 (짧을수록 지연↓) |

---

## 3. 웹 (web/)

### 3-1. index.html: 화면 뼈대

```
┌ header ─────────────────────────────────────────┐
│ 🥁 Air Band [센서 연결] [테스트 타격] 상태·배터리·소리 │
├─────────────────────────────────────────────────┤
│ #connect-hint  노란 안내 (연결되면 숨김)            │
│ #pads          드럼 패드 4개 (main.ts가 만듦)       │
│ <canvas #stage> 물결 애니메이션 (visual.ts)         │
│ .latency       지연 숫자 3개                       │
│ #log           최근 타격 12줄                      │
└─────────────────────────────────────────────────┘
```

색은 `:root`의 CSS 변수로 정의하고, 다크 모드일 때 값만 바꿉니다.

### 3-2. ble.ts: 연결과 수신

**연결** (`connect()`, 사용자가 "센서 연결"을 누르면 실행)

```ts
const device = await navigator.bluetooth.requestDevice({    // ① 기기 선택 창 띄우기
  filters: [{ name: 'AirBand-R' }, { services: [NUS_SERVICE] }],
});
const server  = await device.gatt!.connect();                 // ② 무선 연결
const service = await server.getPrimaryService(NUS_SERVICE); // ③ NUS 서비스 찾기
this.tx = await service.getCharacteristic(NUS_TX);           // ④ TX 특성 찾기
this.tx.addEventListener('characteristicvaluechanged', this.handleNotify);
await this.tx.startNotifications();                          // ⑤ "보내면 알려줘" 구독
```

`await`는 "이 단계가 끝날 때까지 기다린 뒤 다음 줄"이라는 뜻입니다. ⑤가 끝나면 펌웨어의 `notifyEnabled()`가 true가 되어, 그때부터 버튼 신호가 옵니다.

**수신과 해석** (`handleNotify()` → `parsePackets()`)

```ts
const receivedAt = performance.now();           // 받은 시각 (지연 측정용)
for (let off = 0; off + 8 <= dv.byteLength; off += 8) {   // 8바이트씩 자르기
  out.push({
    hand:     dv.getUint8(off + 0),
    mode:     dv.getUint8(off + 1),
    cls:      dv.getUint8(off + 2),              // 드럼 종류
    velocity: dv.getUint8(off + 3),              // 세기
    boardMs:  dv.getUint32(off + 4, true),       // true = little-endian (펌웨어와 같은 순서)
    receivedAt,
  });
}
```

### 3-3. main.ts: 모든 입력을 한곳으로

입력은 세 군데서 오지만 모두 `handleHit()` 하나로 모입니다.

| 입력 | 호출 경로 | 로그 표시 |
|---|---|---|
| 보드 버튼 | `conn.onHit` → `handleHit(e, 'sensor')` | 보드 |
| 화면 패드 클릭 / 키보드 1~4 | `padHit(cls)` → `handleHit(e, 'pad')` | 화면 |
| 스페이스바 / 테스트 타격 | `testHit()` → `handleHit(e, 'test')` | 테스트 |

```ts
function handleHit(e, source) {
  const played = audio.play(e.cls, e.velocity);   // 1. 소리 먼저 (지연 최소화)
  visual.hit(e.velocity, e.cls, CLASS_COUNT);     // 2. 물결
  flashPad(e.cls);                                // 3. 패드 반짝 (120ms)
  // 4. 지연 숫자 갱신
  // 5. 로그 한 줄 추가
}
```

그래서 화면 패드로 테스트한 동작이 보드를 연결했을 때와 똑같습니다.

### 3-4. audio.ts: 소리 만들기와 재생

**Web Audio 연결 구조**

```
BufferSource(드럼 소리) → Gain(세기) → master Gain(전체 볼륨 0.9) → 스피커
```

**빨리 소리 내는 방법**: 페이지가 열릴 때 드럼 4개를 모두 `AudioBuffer`(메모리 속 소리)로 만들어 두고, 칠 때는 `start()`만 호출합니다. 그래서 수신→재생 호출이 0.1ms 정도입니다.

**소리 합성** (wav 파일이 없을 때): 디지털 소리는 1초에 약 48000개의 숫자(-1~1)입니다.

| 재료 | 코드 | 소리 |
|---|---|---|
| 사인파 | `Math.sin(phase)` | "둥-" 음정 있는 소리 |
| 노이즈 | `Math.random() * 2 - 1` | "치-" 음정 없는 소리 |
| 감쇠 | `Math.exp(-t * k)` | 점점 작아짐 (k가 클수록 빨리) |

| 드럼 | 조합 |
|---|---|
| 스네어 | 220→160Hz 사인 + 고역 노이즈, 0.35초 |
| 킥 | 150→45Hz로 급하게 떨어지는 사인 + 짧은 클릭, 0.5초 |
| 하이햇 | 5kHz 이상만 남긴 노이즈, 0.12초 |
| 탐 | 180→110Hz 사인 + 약한 노이즈, 0.45초 |

`public/samples/`에 `snare.wav`, `kick.wav`, `hihat.wav`, `tom.wav`를 넣으면 합성음 대신 그 파일을 씁니다.

**세기 → 볼륨**: `(세기/127)^1.6`. 사람 귀는 작은 소리 차이에 민감해서 곡선을 줍니다.
(127 → 1.0, 100 → 0.68, 64 → 0.33, 32 → 0.11)

**자동재생 정책**: 브라우저는 사용자가 클릭하기 전엔 소리를 막습니다. 그래서 "센서 연결" 클릭이나 패드 클릭 안에서 `audio.resume()`을 부릅니다.

### 3-5. visual.ts: 물결 애니메이션

- `requestAnimationFrame`으로 1초에 약 60번 `frame()`이 실행됩니다.
- 매번 캔버스를 지우고, 살아 있는 물결을 "태어난 지 몇 ms 됐나"에 맞춰 크기·투명도를 계산해 다시 그립니다.
- 0.7초가 지난 물결은 지웁니다.
- 드럼마다 가로 위치(4등분)와 색(파랑·보라·분홍·노랑)이 다르고, 세기가 셀수록 크게 퍼집니다.
- `ResizeObserver`로 캔버스 크기가 바뀌면 다시 맞춰서 원이 찌그러지지 않게 합니다.

### 3-6. 화면의 지연 숫자

| 항목 | 계산 | 뜻 |
|---|---|---|
| 수신 → 재생 호출 | `start()` 시각 − 수신 시각 | 브라우저 처리 시간. 보통 1ms 미만 |
| 오디오 출력 버퍼 | `baseLatency + outputLatency` | OS·사운드 장치가 정하는 지연. 이 PC에서 약 58ms |
| BLE 지터 | (수신 − 보드 시각) − 그 최솟값 | 무선 전송이 평소보다 몇 ms 늦었나 |

보드 시계와 PC 시계는 맞춰져 있지 않아서 "버튼→소리" 전체 지연은 직접 잴 수 없습니다. 대신 흔들림(지터)만 보여 줍니다.

---

## 4. 자주 바꾸게 될 값

| 바꾸고 싶은 것 | 파일 | 값 |
|---|---|---|
| 버튼 세기 | 펌웨어 | `BUTTON_VELOCITY` (100) |
| 버튼 떨림 무시 시간 | 펌웨어 | `BUTTON_DEBOUNCE_MS` (25) |
| 타격 민감도 (IMU) | 펌웨어 | `HIT_THRESHOLD_G` (2.5) |
| 세게 쳐야 최대 세기 | 펌웨어 | `VEL_MAX_G` (12.0) |
| 연타 이중 감지 방지 | 펌웨어 | `REFRACTORY_MS` (60) |
| 드럼 종류 추가 | 웹 `audio.ts` + `main.ts` | `DRUM_CLASSES`, `PAD_LABELS` |
| 세기→볼륨 곡선 | 웹 `audio.ts` | `velocityToGain()`의 1.6 |

펌웨어를 바꾸면 **아두이노 IDE로 다시 업로드**해야 하고, 웹을 바꾸면 **브라우저 새로고침**만 하면 됩니다.
