// 드럼 키트 페이지 진입점: 실제 드럼 세트 화면에서 스틱으로 겨누고 친다
//
// [한눈에 보기]
//
//   보드 ─BLE─▶ ble.ts ─onMotion─▶ scene.setAim(방향, 구역)    화면 속 스틱이 따라 움직임
//                       └onHit───┐
//   마우스 · 터치 (센서 없을 때) ──┼─▶ hit(드럼, 세기) ─┬─ audio.play()  소리 (가장 먼저)
//   키보드 1~5 · 스페이스 ─────────┘                    └─ scene.hit()   드럼 흔들림 · 불꽃
//
//   센서 방향이 들어오는 동안에는 센서가 조준을 맡고, 끊기면 마우스 · 터치로 조준할 수 있다.
//   마우스로 칠 때의 구역 판정은 펌웨어와 같은 규칙(zoneOf)이라, 보드 없이도 실제와 같은 느낌으로 연습할 수 있다.
import { AirBandConnection, CMD, webBluetoothSupport, type MotionEvent } from '../ble';
import { DrumAudio, DRUM_CLASSES } from '../audio';
import { KitScene, CLS, zoneOfAim, type Aim } from './scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>('connect');
const recenterBtn = $<HTMLButtonElement>('recenter');
const zonesToggle = $<HTMLInputElement>('zones');
const fullBtn = $<HTMLButtonElement>('full');
const statusEl = $('status');
const supportEl = $('support');
const stageEl = $('stage');
const canvas = $<HTMLCanvasElement>('kit');

/** 자유 연주 화면과 같은 이름 · 색 */
const LABELS: Record<number, string> = { 0: '스네어', 1: '킥', 2: '하이햇', 3: '탐', 4: '크래시' };
const hueOf = (cls: number) => (200 + cls * 70) % 360;
const CLASS_COUNT = Object.keys(DRUM_CLASSES).length;
const POINTER_VELOCITY = 100;
/** 이 시간 동안 모션 패킷이 없으면 센서 조준을 놓고 마우스 조준으로 */
const MOTION_STALE_MS = 800;

const audio = new DrumAudio();
const conn = new AirBandConnection();
const scene = new KitScene(canvas, hueOf, (cls) => LABELS[cls] ?? DRUM_CLASSES[cls]);

let lastMotionAt = -Infinity;
let pointerAim: Aim | null = null;

const connected = () => statusEl.dataset.state === 'connected';
const sensorAiming = () => performance.now() - lastMotionAt < MOTION_STALE_MS;

function hit(cls: number, velocity: number): void {
  audio.play(cls, velocity);
  scene.hit(cls, velocity);
}

/** 펌웨어 orientation.h zone()과 같은 규칙 */
const zoneOf = zoneOfAim;

// ---------------------------------------------------------------------------
// 센서
// ---------------------------------------------------------------------------
conn.onHit = (e) => hit(e.cls, e.velocity);
conn.onMotion = (m: MotionEvent) => {
  lastMotionAt = m.receivedAt;
  scene.setAim({ h: m.headingDeg, e: m.elevationDeg }, m.zone);
};
conn.onState = (state, detail) => {
  statusEl.dataset.state = state;
  if (state === 'connected') {
    statusEl.textContent = `연결됨 · ${detail ?? ''}`;
    connectBtn.textContent = '연결 끊기';
    void conn.send(CMD.motionOn);
  } else if (state === 'connecting') {
    statusEl.textContent = '연결 중…';
    connectBtn.textContent = '연결 중…';
  } else {
    statusEl.textContent = detail ? `연결 안 됨 · ${detail}` : '연결 안 됨';
    connectBtn.textContent = '센서 연결';
    lastMotionAt = -Infinity;
  }
  connectBtn.disabled = state === 'connecting';
  recenterBtn.disabled = state !== 'connected';
};

connectBtn.addEventListener('click', async () => {
  await audio.resume();
  if (connected()) {
    conn.disconnect();
    return;
  }
  try {
    await conn.connect();
  } catch (err) {
    console.warn('BLE 연결 실패', err);
  }
});

function recenter(): void {
  if (connected()) void conn.send(CMD.recenter);
}
recenterBtn.addEventListener('click', recenter);

// ---------------------------------------------------------------------------
// 마우스 · 터치 (센서 조준이 없을 때)
// ---------------------------------------------------------------------------
function pointerPos(ev: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
canvas.addEventListener('pointermove', (ev) => {
  const p = pointerPos(ev);
  pointerAim = scene.toAngles(p.x, p.y);
  if (!sensorAiming()) scene.setAim(pointerAim, scene.isOnKick(p.x, p.y) ? CLS.kick : zoneOf(pointerAim));
});
canvas.addEventListener('pointerleave', () => {
  pointerAim = null;
  if (!sensorAiming()) scene.setAim(null);
});
// click보다 pointerdown이 빠르다
canvas.addEventListener('pointerdown', (ev) => {
  void audio.resume();
  const p = pointerPos(ev);
  if (scene.isOnKick(p.x, p.y)) {
    hit(CLS.kick, POINTER_VELOCITY);
    return;
  }
  const a = scene.toAngles(p.x, p.y);
  pointerAim = a;
  const cls = zoneOf(a);
  if (!sensorAiming()) scene.setAim(a, cls);
  hit(cls, POINTER_VELOCITY);
});

// ---------------------------------------------------------------------------
// 키보드 · 화면 버튼
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (ev) => {
  if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  void audio.resume();
  if (ev.code === 'Space') {
    ev.preventDefault();
    hit(Math.floor(Math.random() * CLASS_COUNT), 40 + Math.floor(Math.random() * 88));
    return;
  }
  const key = ev.key.toLowerCase();
  if (key === 'c') return recenter();
  if (key === 'z') {
    zonesToggle.checked = !zonesToggle.checked;
    scene.showZones = zonesToggle.checked;
    return;
  }
  if (key === 'f') return toggleFullscreen();
  const n = Number(ev.key);
  if (n >= 1 && n <= CLASS_COUNT) hit(n - 1, POINTER_VELOCITY);
});

zonesToggle.addEventListener('change', () => (scene.showZones = zonesToggle.checked));

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stageEl.requestFullscreen?.().catch(() => undefined);
}
fullBtn.addEventListener('click', toggleFullscreen);

// ---------------------------------------------------------------------------
// 조준 주인 바꾸기 · 안내 글
// ---------------------------------------------------------------------------
setInterval(() => {
  const sensor = sensorAiming();
  // 센서가 끊기면 마우스 조준(없으면 쉬는 자세)으로 돌아간다
  if (!sensor) scene.setAim(pointerAim, pointerAim ? zoneOf(pointerAim) : -1);
  if (!connected()) scene.hint = '마우스 · 터치로 겨누고 눌러서 치기 · 키 1~5 · 센서를 연결하면 스틱으로 칩니다';
  else if (!sensor) scene.hint = '방향 데이터 없음 — 보드 버튼으로 치거나 IMU 연결을 확인하세요';
  else scene.hint = '스틱을 스네어 위에 두고 C(정면 맞추기) · Z 구역선 · F 전체 화면';
}, 250);

async function start(): Promise<void> {
  const support = webBluetoothSupport();
  if (!support.ok) {
    supportEl.textContent = support.reason!;
    supportEl.hidden = false;
    connectBtn.disabled = true;
  }
  await audio.init();
}
void start();
