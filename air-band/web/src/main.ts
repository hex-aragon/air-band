// 앱 진입점: BLE 수신 → 오디오 재생 → 시각화 · 로그 · 지연 표시

// [한눈에 보기] 전체 흐름
//
//   보드 버튼 · 스틱 ─BLE─▶ ble.ts (패킷 해석) ─onHit─┐
//   화면 패드 클릭 / 키보드 1~5 ─padHit─────────┼─▶ handleHit()
//   스페이스바 / 테스트 타격 ─testHit──────────┘      ├─ audio.play()   소리 (가장 먼저!)
//                                                      ├─ visual.hit()   물결
//                                                      ├─ flashPad()     패드 반짝
//                                                      ├─ 지연 숫자 갱신
//                                                      └─ addLog()       로그 한 줄
//
//   입력이 어디서 오든 같은 handleHit()을 거친다. 그래서 보드 없이 화면으로 테스트한 것이
//   보드를 연결했을 때와 똑같이 동작한다.
//
//   2단계: 보드가 모션 패킷(스틱 방향, 25Hz)도 보낸다 ─onMotion─▶ motion.update() → 방향 화면
//          화면의 "정면 맞추기" 버튼(또는 키 C)은 보드에 'c' 명령을 보낸다.
//
//   녹음: handleHit()을 지나는 모든 타격을 recorder가 쌓는다 → 재생 · MIDI · 공유 링크 (recorder.ts)
import { mountHeader, attachStick } from './ui/header';
mountHeader('pads');

import { AirBandConnection, CMD, webBluetoothSupport, type HitEvent } from './ble';
import { DrumAudio, DRUM_CLASSES } from './audio';
import { HitVisualizer } from './visual';
import { MotionView } from './motion';
import {
  Recorder,
  decodeTake,
  encodeTake,
  formatDuration,
  loadTakes,
  saveTakes,
  takeToMidi,
  type Take,
} from './recorder';

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
const recenterBtn = $<HTMLButtonElement>('recenter');
const motionToggle = $<HTMLInputElement>('motion-on');
const motionNoteEl = $('motion-note');
const recBtn = $<HTMLButtonElement>('rec');
const recStatusEl = $('rec-status');
const takesEl = $<HTMLOListElement>('takes');

const LOG_MAX = 12;

/** 화면 패드 표시 이름 (DRUM_CLASSES 순서와 같음) */
const PAD_LABELS: Record<number, string> = { 0: '스네어', 1: '킥', 2: '하이햇', 3: '탐', 4: '크래시' };
/** 패드 아래 작은 글씨: [스틱 구역, 보드 버튼 · 키보드]. 좁은 화면에서는 구역만 보인다 */
const PAD_HINTS: Record<number, [string, string]> = {
  0: ['정면', '버튼 1 · 키 1'],
  1: ['버튼 2', '키 2'],
  2: ['왼쪽', '버튼 3 · 키 3'],
  3: ['오른쪽', '버튼 4 · 키 4'],
  4: ['위로', '키 5'],
};
/** 드럼별 색상 (패드 · 물결 · 방향 화면 공통) */
const hueOf = (cls: number) => (200 + cls * 70) % 360;
const CLASS_COUNT = Object.keys(DRUM_CLASSES).length;
/** 화면 패드로 칠 때의 세기 (보드 버튼과 같은 값) */
const PAD_VELOCITY = 100;

type HitSource = 'sensor' | 'pad' | 'test' | 'replay';

const audio = new DrumAudio();
const visual = new HitVisualizer($<HTMLCanvasElement>('stage'));
const conn = new AirBandConnection();
const motion = new MotionView($<HTMLCanvasElement>('motion'), hueOf, (cls) => PAD_LABELS[cls] ?? DRUM_CLASSES[cls]);

// [설명] 지터 계산
//   offset = (브라우저가 받은 시각) - (보드가 보낸 시각). 두 시계는 서로 맞춰져 있지 않아 값 자체는 의미가 없다.
//   하지만 "가장 빨리 온 패킷의 offset"을 기준(0)으로 잡으면, 다른 패킷이 기준보다 몇 ms 늦었는지는 알 수 있다.
// BLE 지터 추정: (수신 시각 - 보드 millis)의 최솟값을 기준으로 얼마나 늦게 왔는지
let minOffset = Infinity;

const recorder = new Recorder();

// ---------------------------------------------------------------------------
// 타격 처리 — 수신 즉시 재생하고, 표시는 그 다음에
// ---------------------------------------------------------------------------
function handleHit(e: HitEvent, source: HitSource): void {
  const played = audio.play(e.cls, e.velocity);
  visual.hit(e.velocity, e.cls, CLASS_COUNT);
  flashPad(e.cls);
  const fromSensor = source === 'sensor';
  if (fromSensor) motion.hit(e.cls);

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

  // [설명] 녹음 시각: 보드 타격은 "보드 시각 + 가장 빨랐던 전송 지연"으로 계산한다.
  //   그러면 BLE 전송이 들쭉날쭉해서 생기는 흔들림(지터)이 녹음에 들어가지 않는다.
  const at = fromSensor && Number.isFinite(minOffset) ? e.boardMs + minOffset : e.receivedAt;
  recorder.add(at, e.cls, e.velocity, fromSensor ? e.boardMs : undefined);

  addLog(e, procMs, source);
}

// [설명] 로그는 최신이 위로 오도록 prepend하고, 12줄이 넘으면 가장 오래된 줄을 지운다.
function addLog(e: HitEvent, procMs: number, source: HitSource): void {
  const li = document.createElement('li');
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const name = DRUM_CLASSES[e.cls] ?? `class ${e.cls}`;
  const srcLabel = { sensor: conn.isPhone ? '폰' : '보드', pad: '화면', test: '테스트', replay: '재생' }[source];
  li.innerHTML = `
    <span class="t">${time}</span>
    <span class="name">${name}<span class="src">${srcLabel}</span></span>
    <span class="vel"><span class="bar" style="width:${(e.velocity / 127) * 100}%"></span></span>
    <span class="num">${e.velocity}</span>
    <span class="num dim">${Number.isFinite(procMs) ? `${procMs.toFixed(1)}ms` : '—'}</span>`;
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
conn.onMotion = (m) => motion.update(m);

conn.onState = (state, detail) => {
  statusEl.dataset.state = state;
  connectHintEl.hidden = state === 'connected';
  if (state === 'connected') {
    statusEl.textContent = `연결됨 · ${detail ?? ''}`;
    connectBtn.textContent = '연결 끊기';
    minOffset = Infinity;
    if (motionToggle.checked) void conn.send(CMD.motionOn);
  } else if (state === 'connecting') {
    statusEl.textContent = '연결 중…';
    connectBtn.textContent = '연결 중…';
  } else {
    statusEl.textContent = detail ? `연결 안 됨 · ${detail}` : '연결 안 됨';
    connectBtn.textContent = '센서 연결';
    batteryEl.textContent = '—';
    motion.clear();
  }
  connectBtn.disabled = state === 'connecting';
  recenterBtn.disabled = state !== 'connected';
  updateMotionNote();
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

// 폰 단독 모드: 권한 요청이 클릭 안에서 일어나야 하므로 connectPhone()을 await보다 먼저 부른다
document.getElementById('phone')!.addEventListener('click', () => {
  const started = conn.isPhone ? (conn.disconnect(), Promise.resolve()) : conn.connectPhone();
  void audio.resume();
  started.catch((err) => console.warn('폰 센서 시작 실패', err));
});

// ---------------------------------------------------------------------------
// 스틱 방향 (2단계)
// ---------------------------------------------------------------------------
// [설명] 정면 맞추기: 스틱을 스네어를 칠 위치에 두고 누르면, 보드가 그 방향을 기준(0°)으로 다시 잡는다.
//   자이로는 시간이 지나면 조금씩 흘러가므로(1분에 1° 미만) 구역이 어긋나 보이면 다시 누르면 된다.
function recenter(): void {
  if (statusEl.dataset.state === 'connected') void conn.send(CMD.recenter);
}
recenterBtn.addEventListener('click', recenter);
attachStick(conn, { kind: 'stick', zones: true, autoWizard: false });
motionToggle.addEventListener('change', () => {
  if (statusEl.dataset.state === 'connected') void conn.send(motionToggle.checked ? CMD.motionOn : CMD.motionOff);
  if (!motionToggle.checked) motion.clear();
  updateMotionNote();
});

// 연결됐는데 모션이 안 오면 이유를 알려 준다 (IMU 없음 = 버튼 전용 모드, 또는 1단계 펌웨어)
function updateMotionNote(): void {
  const connected = statusEl.dataset.state === 'connected';
  let note = '';
  // 연결 전 안내는 방향 화면 안에 그려지므로 여기서는 비워 둔다
  if (!connected) note = '';
  else if (!motionToggle.checked) note = '방향 보기 꺼짐';
  else if (motion.age() > 1500) note = '방향 데이터 없음 — IMU가 없거나(버튼 전용 모드) 1단계 펌웨어입니다';
  motionNoteEl.textContent = note;
  motionNoteEl.hidden = note === '';
}
setInterval(updateMotionNote, 500);

// ---------------------------------------------------------------------------
// 연주 녹음 · 재생
// ---------------------------------------------------------------------------
let takes: Take[] = loadTakes();
let storageOk = true;
let highlightId = '';

interface Playback {
  id: string;
  nodes: AudioBufferSourceNode[];
  timers: number[];
}
let playback: Playback | null = null;

function toggleRecording(): void {
  void audio.resume();
  const now = performance.now();
  if (!recorder.recording) {
    recorder.start(now);
    recBtn.classList.add('on');
  } else {
    const n = takes.length + 1;
    const d = new Date();
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const take = recorder.stop(now, `연주 ${n} (${stamp})`, minOffset);
    recBtn.classList.remove('on');
    if (take) {
      takes.unshift(take);
      storageOk = saveTakes(takes);
      highlightId = take.id;
      setRecMessage(`저장했습니다: ${take.events.length}타 · ${formatDuration(take.durationMs)}`);
    } else {
      setRecMessage('친 게 없어서 저장하지 않았습니다');
    }
    renderTakes();
  }
  updateRecButton();
}

let recMessage = '';
let recMessageUntil = 0;
function setRecMessage(msg: string): void {
  recMessage = msg;
  recMessageUntil = performance.now() + 4000;
  updateRecButton();
}

function updateRecButton(): void {
  const now = performance.now();
  if (recorder.recording) {
    recBtn.textContent = '■ 녹음 끝내기';
    recStatusEl.textContent = `● ${formatDuration(recorder.elapsed(now))} · ${recorder.count}타`;
    recStatusEl.dataset.live = '1';
  } else {
    recBtn.textContent = '● 녹음';
    delete recStatusEl.dataset.live;
    recStatusEl.textContent =
      now < recMessageUntil ? recMessage : storageOk ? '' : '이 브라우저에는 저장되지 않습니다 (시크릿 창 등) — 새로고침하면 사라집니다';
  }
}
setInterval(updateRecButton, 100);
recBtn.addEventListener('click', toggleRecording);

// [설명] 재생: 모든 소리를 오디오 시계에 미리 예약한다 (setTimeout보다 훨씬 정확).
//   화면 효과만 setTimeout으로 띄우되, 오디오 출력 지연만큼 늦춰 소리와 맞춘다.
//   재생 중에도 녹음할 수 있다 (재생되는 타격은 녹음되지 않으니 겹쳐 치기용).
function playTake(take: Take): void {
  stopPlayback();
  void audio.resume();
  const lead = 0.12; // 예약 여유 (초)
  const t0 = audio.ctx.currentTime + lead;
  const outMs = ((audio.ctx.baseLatency ?? 0) + (audio.ctx.outputLatency ?? 0)) * 1000;
  const pb: Playback = { id: take.id, nodes: [], timers: [] };
  for (const ev of take.events) {
    pb.nodes.push(audio.playAt(ev.cls, ev.vel, t0 + ev.t / 1000));
    pb.timers.push(
      window.setTimeout(() => {
        visual.hit(ev.vel, ev.cls, CLASS_COUNT);
        flashPad(ev.cls);
        addLog({ hand: 0, mode: 0, cls: ev.cls, velocity: ev.vel, boardMs: 0, receivedAt: performance.now() }, NaN, 'replay');
      }, lead * 1000 + outMs + ev.t),
    );
  }
  pb.timers.push(window.setTimeout(() => stopPlayback(), lead * 1000 + outMs + take.durationMs + 200));
  playback = pb;
  renderTakes();
}

function stopPlayback(): void {
  if (!playback) return;
  for (const n of playback.nodes) {
    try {
      n.stop();
    } catch {
      // 이미 끝난 소리
    }
  }
  for (const t of playback.timers) clearTimeout(t);
  playback = null;
  renderTakes();
}

function downloadMidi(take: Take): void {
  const blob = new Blob([takeToMidi(take)], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${take.name.replace(/[\\/:*?"<>|]+/g, '_')}.mid`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyLink(take: Take): Promise<void> {
  const url = `${location.origin}${location.pathname}#take=${encodeTake(take)}`;
  try {
    await navigator.clipboard.writeText(url);
    setRecMessage(`공유 링크를 복사했습니다 (${url.length}자) — 받은 사람은 보드 없이 재생할 수 있습니다`);
  } catch {
    window.prompt('아래 링크를 복사하세요', url);
  }
}

function deleteTake(take: Take): void {
  if (!window.confirm(`"${take.name}"을(를) 지울까요?`)) return;
  if (playback?.id === take.id) stopPlayback();
  takes = takes.filter((t) => t.id !== take.id);
  storageOk = saveTakes(takes);
  renderTakes();
}

function renderTakes(): void {
  takesEl.replaceChildren();
  if (takes.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '녹음한 연주가 없습니다. ● 녹음(키 R)을 누르고 쳐 보세요.';
    takesEl.append(li);
    return;
  }
  for (const take of takes) {
    const li = document.createElement('li');
    if (take.id === highlightId) li.className = 'new';
    const isPlaying = playback?.id === take.id;
    const d = new Date(take.createdAt);
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = take.name; // 공유받은 이름이 HTML로 해석되지 않게 textContent
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${formatDuration(take.durationMs)} · ${take.events.length}타 · ${d.getMonth() + 1}/${d.getDate()}`;
    info.append(name, meta);
    const btn = (label: string, title: string, fn: () => void, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      return b;
    };
    li.append(
      info,
      btn(isPlaying ? '■ 정지' : '▶ 재생', '재생', () => (isPlaying ? stopPlayback() : playTake(take)), isPlaying ? 'on' : ''),
      btn('MIDI', 'MIDI 파일(.mid) 받기 — GarageBand · MuseScore 등에서 열림', () => downloadMidi(take)),
      btn('링크', '공유 링크 복사', () => void copyLink(take)),
      btn('삭제', '지우기', () => deleteTake(take), 'danger'),
    );
    takesEl.append(li);
  }
}

// 공유 링크로 열었을 때: #take=... 를 읽어 목록 맨 위에 넣는다 (소리는 사용자가 ▶를 눌러야 남)
function importFromHash(): void {
  const m = location.hash.match(/^#take=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    const take = decodeTake(m[1]);
    takes.unshift(take);
    storageOk = saveTakes(takes);
    highlightId = take.id;
    setRecMessage(`공유받은 연주를 불러왔습니다 (${take.events.length}타) — ▶ 재생을 누르세요`);
  } catch (err) {
    setRecMessage(`공유 링크를 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
  history.replaceState(null, '', location.pathname + location.search);
}
// 이미 열린 탭에 다른 공유 링크를 붙여 넣으면 새로고침 없이 해시만 바뀌므로 그때도 불러온다
window.addEventListener('hashchange', () => {
  importFromHash();
  renderTakes();
});

// ---------------------------------------------------------------------------
// 드럼 패드 (보드 없이도 칠 수 있게, 보드 버튼이 오면 같이 빛남)
// ---------------------------------------------------------------------------
const padEls = new Map<number, HTMLElement>();
const padTimers = new Map<number, number>();

// [설명] 패드를 코드로 만든다. DRUM_CLASSES에 드럼을 추가하면 패드도 자동으로 늘어난다.
//   --hue CSS 변수로 패드 색을 물결 색과 맞춘다 (스네어 200 파랑, 킥 270 보라, 하이햇 340 분홍, 탐 50 노랑, 크래시 120 초록).
function buildPads(): void {
  padsEl.style.setProperty('--cols', String(CLASS_COUNT));
  for (const cls of Object.keys(DRUM_CLASSES).map(Number)) {
    const pad = document.createElement('button');
    pad.className = 'pad';
    pad.style.setProperty('--hue', String(hueOf(cls))); // visual.ts 물결 색과 같음
    pad.innerHTML = `<span class="name">${PAD_LABELS[cls] ?? DRUM_CLASSES[cls]}</span>
      <span class="hint">${hintHtml(cls)}</span>`;
    // click보다 pointerdown이 빠르다 (손 뗄 때까지 기다리지 않음)
    pad.addEventListener('pointerdown', () => padHit(cls));
    padsEl.append(pad);
    padEls.set(cls, pad);
  }
}

function hintHtml(cls: number): string {
  const hint = PAD_HINTS[cls];
  if (!hint) return `키 ${cls + 1}`;
  return `<span class="zone">${hint[0]}</span><span class="keys"> · ${hint[1]}</span>`;
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
  if (ev.key === 'c' || ev.key === 'C') {
    recenter();
    return;
  }
  if (ev.key === 'r' || ev.key === 'R') {
    toggleRecording();
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
  importFromHash();
  renderTakes();
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
