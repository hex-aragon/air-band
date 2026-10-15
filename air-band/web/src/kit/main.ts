// 드럼 키트 페이지: 3D 드럼 세트에서 스틱으로 겨누고 친다
//
// [한눈에 보기]
//
//   보드 ─BLE─▶ ble.ts ─onMotion─▶ scene.setAim(방향, 구역)    화면 속 스틱이 따라 움직임
//                       └onHit───┐
//   마우스 · 터치 (센서 없을 때) ──┼─▶ hit(드럼, 세기) ─┬─ audio.play()  소리 (가장 먼저)
//   키보드 1~5 · 스페이스 ─────────┘                    └─ scene.hit()   드럼 흔들림 · 불꽃
//
//   연결 · 맞추기 · 드럼 간격은 위 메뉴의 스틱 버튼(ui/header.ts)이 맡는다.
//   센서 방향이 들어오는 동안에는 센서가 조준을 맡고, 끊기면 마우스 · 터치로 조준할 수 있다.
import { mountHeader, attachStick, calibrate, stickConnected } from '../ui/header';
mountHeader('kit');

import { AirBandConnection, CMD, type MotionEvent } from '../ble';
import { DrumAudio, DRUM_CLASSES } from '../audio';
import { CLS, zoneOfAim, type Aim } from './scene';
import { createKitView } from './view';
import { onZoneChange } from '../motion';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const zonesBtn = $<HTMLButtonElement>('zones');
const fullBtn = $<HTMLButtonElement>('full');
const stageEl = $('stage');
const canvas = $<HTMLCanvasElement>('kit');

const LABELS: Record<number, string> = { 0: '스네어', 1: '킥', 2: '하이햇', 3: '탐', 4: '크래시' };
const hueOf = (cls: number) => (200 + cls * 70) % 360;
const CLASS_COUNT = Object.keys(DRUM_CLASSES).length;
const POINTER_VELOCITY = 100;
/** 이 시간 동안 모션 패킷이 없으면 센서 조준을 놓고 마우스 조준으로 */
const MOTION_STALE_MS = 800;

const audio = new DrumAudio();
const conn = new AirBandConnection();
const scene = createKitView(canvas, hueOf, (cls) => LABELS[cls] ?? DRUM_CLASSES[cls]);

let lastMotionAt = -Infinity;
let pointerAim: Aim | null = null;
const sensorAiming = () => performance.now() - lastMotionAt < MOTION_STALE_MS;

function hit(cls: number, velocity: number): void {
  audio.play(cls, velocity);
  scene.hit(cls, velocity);
}

// ---------------------------------------------------------------------------
// 센서 (연결 버튼은 위 메뉴가 숨은 #connect · #phone을 누른다)
// ---------------------------------------------------------------------------
conn.onHit = (e) => hit(e.cls, e.velocity);
conn.onMotion = (m: MotionEvent) => {
  lastMotionAt = m.receivedAt;
  scene.setAim({ h: m.headingDeg, e: m.elevationDeg }, m.zone);
};
conn.onState = (state) => {
  if (state === 'connected') void conn.send(CMD.motionOn);
  else lastMotionAt = -Infinity;
};
$('connect').addEventListener('click', async () => {
  await audio.resume();
  if (stickConnected()) return conn.disconnect();
  try {
    await conn.connect();
  } catch (err) {
    console.warn('BLE 연결 실패', err);
  }
});
// 폰 단독 모드: 권한 요청이 클릭 안에서 일어나야 하므로 connectPhone()을 await보다 먼저 부른다
$('phone').addEventListener('click', () => {
  const started = conn.isPhone ? (conn.disconnect(), Promise.resolve()) : conn.connectPhone();
  void audio.resume();
  started.catch((err) => console.warn('폰 센서 시작 실패', err));
});
attachStick(conn, { kind: 'stick', zones: true });
onZoneChange(() => {
  // 간격을 바꾸면 마우스 조준 구역도 바로 바뀐다 (ZONE_DEG를 읽으므로 따로 할 일 없음)
});

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
  if (!sensorAiming()) scene.setAim(pointerAim, scene.isOnKick(p.x, p.y) ? CLS.kick : zoneOfAim(pointerAim));
});
canvas.addEventListener('pointerleave', () => {
  pointerAim = null;
  if (!sensorAiming()) scene.setAim(null);
});
canvas.addEventListener('pointerdown', (ev) => {
  void audio.resume();
  const p = pointerPos(ev);
  if (scene.isOnKick(p.x, p.y)) return hit(CLS.kick, POINTER_VELOCITY);
  const a = scene.toAngles(p.x, p.y);
  pointerAim = a;
  const cls = zoneOfAim(a);
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
    return hit(CLS.kick, POINTER_VELOCITY);
  }
  const key = ev.key.toLowerCase();
  if (key === 'c') return calibrate('center');
  if (key === 'a') return calibrate('axis');
  if (key === 'z') return toggleZones();
  if (key === 'f') return toggleFullscreen();
  const n = Number(ev.key);
  if (n >= 1 && n <= CLASS_COUNT) hit(n - 1, POINTER_VELOCITY);
});

function toggleZones(): void {
  scene.showZones = !scene.showZones;
  zonesBtn.setAttribute('aria-pressed', String(scene.showZones));
}
zonesBtn.addEventListener('click', toggleZones);

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stageEl.requestFullscreen?.().catch(() => undefined);
}
fullBtn.addEventListener('click', toggleFullscreen);

// 조준 주인 바꾸기 · 안내 글
setInterval(() => {
  const sensor = sensorAiming();
  if (!sensor) scene.setAim(pointerAim, pointerAim ? zoneOfAim(pointerAim) : -1);
  if (!stickConnected()) scene.hint = '마우스 · 터치로 드럼을 눌러 치기 · 키보드 1~5 · 스페이스 = 킥 · 오른쪽 위 "스틱 연결"로 진짜 스틱';
  else if (!sensor) scene.hint = '방향 데이터 없음 — 보드 버튼으로 치거나 IMU 연결을 확인하세요';
  else scene.hint = '방향이 안 맞으면 위 메뉴 → 스틱 맞추기 · Z 구역선 · F 전체 화면';
}, 250);

void audio.init();
