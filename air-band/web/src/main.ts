// 앱 진입점: BLE 수신 → 오디오 재생 → 시각화 · 로그 · 지연 표시

// [한눈에 보기] 전체 흐름
//
//   보드 버튼 ─BLE─▶ ble.ts (패킷 해석) ─onHit─┐
//   화면 패드 클릭 / 키보드 1~4 ─padHit─────────┼─▶ handleHit()
//   스페이스바 / 테스트 타격 ─testHit──────────┘      ├─ audio.play()   소리 (가장 먼저!)
//                                                      ├─ visual.hit()   물결
//                                                      ├─ flashPad()     패드 반짝
//                                                      ├─ 지연 숫자 갱신
//                                                      └─ addLog()       로그 한 줄
//
//   입력이 어디서 오든 같은 handleHit()을 거친다. 그래서 보드 없이 화면으로 테스트한 것이
//   보드를 연결했을 때와 똑같이 동작한다.
import { AirBandConnection, webBluetoothSupport, type HitEvent } from './ble';
import { DrumAudio, DRUM_CLASSES } from './audio';
import { HitVisualizer } from './visual';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>('connect');
const testBtn = $<HTMLButtonElement>('test');
const statusEl = $('status');
const batteryEl = $('battery');
const supportEl = $('support');
const latProcEl = $('lat-proc');
const latOutEl = $('lat-out');
const latJitterEl = $('lat-jitter');
const audioSrcEl = $('audio-src');
const logEl = $<HTMLOListElement>('log');
const padsEl = $('pads');
const connectHintEl = $('connect-hint');

const LOG_MAX = 12;

/** 화면 패드 표시 이름 (DRUM_CLASSES 순서와 같음) */
const PAD_LABELS: Record<number, string> = { 0: '스네어', 1: '킥', 2: '하이햇', 3: '탐' };
const CLASS_COUNT = Object.keys(DRUM_CLASSES).length;
/** 화면 패드로 칠 때의 세기 (보드 버튼과 같은 값) */
const PAD_VELOCITY = 100;

type HitSource = 'sensor' | 'pad' | 'test';

const audio = new DrumAudio();
const visual = new HitVisualizer($<HTMLCanvasElement>('stage'));
const conn = new AirBandConnection();

// [설명] 지터 계산
//   offset = (브라우저가 받은 시각) - (보드가 보낸 시각). 두 시계는 서로 맞춰져 있지 않아 값 자체는 의미가 없다.
//   하지만 "가장 빨리 온 패킷의 offset"을 기준(0)으로 잡으면, 다른 패킷이 기준보다 몇 ms 늦었는지는 알 수 있다.
// BLE 지터 추정: (수신 시각 - 보드 millis)의 최솟값을 기준으로 얼마나 늦게 왔는지
let minOffset = Infinity;

// ---------------------------------------------------------------------------
// 타격 처리 — 수신 즉시 재생하고, 표시는 그 다음에
// ---------------------------------------------------------------------------
function handleHit(e: HitEvent, source: HitSource): void {
  const played = audio.play(e.cls, e.velocity);
  visual.hit(e.velocity, e.cls, CLASS_COUNT);
  flashPad(e.cls);
  const fromSensor = source === 'sensor';

  const procMs = played.startedAt - e.receivedAt;
  latProcEl.textContent = procMs.toFixed(1);
  latOutEl.textContent = played.outputLatencyMs.toFixed(1);

  let jitterMs: number | null = null;
  if (fromSensor) {
    const offset = e.receivedAt - e.boardMs;
    if (offset < minOffset) minOffset = offset;
    jitterMs = offset - minOffset;
    latJitterEl.textContent = jitterMs.toFixed(1);
  }

  addLog(e, procMs, source);
}

// [설명] 로그는 최신이 위로 오도록 prepend하고, 12줄이 넘으면 가장 오래된 줄을 지운다.
function addLog(e: HitEvent, procMs: number, source: HitSource): void {
  const li = document.createElement('li');
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const name = DRUM_CLASSES[e.cls] ?? `class ${e.cls}`;
  const srcLabel = { sensor: '보드', pad: '화면', test: '테스트' }[source];
  li.innerHTML = `
    <span class="t">${time}</span>
    <span class="name">${name}<span class="src">${srcLabel}</span></span>
    <span class="vel"><span class="bar" style="width:${(e.velocity / 127) * 100}%"></span></span>
    <span class="num">${e.velocity}</span>
    <span class="num dim">${procMs.toFixed(1)}ms</span>`;
  logEl.prepend(li);
  while (logEl.children.length > LOG_MAX) logEl.lastElementChild!.remove();
}

// ---------------------------------------------------------------------------
// 연결 UI
// ---------------------------------------------------------------------------
// [설명] ble.ts의 AirBandConnection은 이벤트가 생기면 아래 콜백 함수들을 불러 준다.
//   onHit     : 타격 패킷 도착
//   onState   : 연결 상태 변화 (disconnected / connecting / connected)
//   onBattery : 배터리 값 (1단계 펌웨어는 배터리 서비스가 없어 'none')
conn.onHit = (e) => handleHit(e, 'sensor');

conn.onState = (state, detail) => {
  statusEl.dataset.state = state;
  connectHintEl.hidden = state === 'connected';
  if (state === 'connected') {
    statusEl.textContent = `연결됨 · ${detail ?? ''}`;
    connectBtn.textContent = '연결 끊기';
    minOffset = Infinity;
  } else if (state === 'connecting') {
    statusEl.textContent = '연결 중…';
    connectBtn.textContent = '연결 중…';
  } else {
    statusEl.textContent = detail ? `연결 안 됨 · ${detail}` : '연결 안 됨';
    connectBtn.textContent = '센서 연결';
    batteryEl.textContent = '—';
  }
  connectBtn.disabled = state === 'connecting';
};

conn.onBattery = (b) => {
  batteryEl.textContent = b === 'none' ? '정보 없음 (USB 전원)' : `${b}%`;
};

connectBtn.addEventListener('click', async () => {
  // 사용자 클릭 안에서 오디오를 깨워야 첫 타격부터 소리가 난다
  await audio.resume();
  if (statusEl.dataset.state === 'connected') {
    conn.disconnect();
    return;
  }
  try {
    await conn.connect();
  } catch (err) {
    console.warn('BLE 연결 실패', err);
  }
});

// ---------------------------------------------------------------------------
// 드럼 패드 (보드 없이도 칠 수 있게, 보드 버튼이 오면 같이 빛남)
// ---------------------------------------------------------------------------
const padEls = new Map<number, HTMLElement>();
const padTimers = new Map<number, number>();

// [설명] 패드 4개를 코드로 만든다. DRUM_CLASSES에 드럼을 추가하면 패드도 자동으로 늘어난다.
//   --hue CSS 변수로 패드 색을 물결 색과 맞춘다 (스네어 200 파랑, 킥 270 보라, 하이햇 340 분홍, 탐 50 노랑).
function buildPads(): void {
  for (const cls of Object.keys(DRUM_CLASSES).map(Number)) {
    const pad = document.createElement('button');
    pad.className = 'pad';
    pad.style.setProperty('--hue', String((200 + cls * 70) % 360)); // visual.ts 물결 색과 같음
    pad.innerHTML = `<span class="name">${PAD_LABELS[cls] ?? DRUM_CLASSES[cls]}</span>
      <span class="hint">버튼 ${cls + 1} · 키 ${cls + 1}</span>`;
    // click보다 pointerdown이 빠르다 (손 뗄 때까지 기다리지 않음)
    pad.addEventListener('pointerdown', () => padHit(cls));
    padsEl.append(pad);
    padEls.set(cls, pad);
  }
}

function flashPad(cls: number): void {
  const pad = padEls.get(cls);
  if (!pad) return;
  pad.classList.add('on');
  clearTimeout(padTimers.get(cls));
  padTimers.set(cls, window.setTimeout(() => pad.classList.remove('on'), 120));
}

function padHit(cls: number, velocity = PAD_VELOCITY, source: HitSource = 'pad'): void {
  void audio.resume();
  handleHit({ hand: 0, mode: 0, cls, velocity, boardMs: 0, receivedAt: performance.now() }, source);
}

// 센서 없이 소리/화면 확인용: 무작위 드럼, 무작위 세기
function testHit(): void {
  padHit(Math.floor(Math.random() * CLASS_COUNT), 40 + Math.floor(Math.random() * 88), 'test');
}
testBtn.addEventListener('click', testHit);
window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return;
  // 버튼에 포커스가 있어도 스페이스는 테스트 타격으로만 쓴다 (연결 버튼이 눌리지 않게)
  if (ev.code === 'Space') {
    ev.preventDefault();
    testHit();
    return;
  }
  const n = Number(ev.key);
  if (n >= 1 && n <= CLASS_COUNT) padHit(n - 1);
});

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------
// [설명] 페이지가 열리면 한 번 실행: 패드 만들기 → 브라우저 지원 확인 → 드럼 소리 4개 준비
async function start(): Promise<void> {
  buildPads();
  const support = webBluetoothSupport();
  if (!support.ok) {
    supportEl.textContent = support.reason!;
    supportEl.hidden = false;
    connectBtn.disabled = true;
  }

  await audio.init();
  // 로딩은 병렬이라 끝난 순서가 제각각 → class 번호 순으로 표시. 모두 같은 출처면 한 번만 적는다
  const label = (src: 'file' | 'synth') => (src === 'file' ? '샘플 파일' : '합성음');
  const entries = [...audio.sources.entries()].sort(([a], [b]) => a - b);
  const allSame = entries.every(([, src]) => src === entries[0][1]);
  audioSrcEl.textContent = allSame
    ? `${label(entries[0][1])} (${entries.map(([cls]) => DRUM_CLASSES[cls]).join(', ')})`
    : entries.map(([cls, src]) => `${DRUM_CLASSES[cls]}: ${label(src)}`).join(', ');
}

void start();
