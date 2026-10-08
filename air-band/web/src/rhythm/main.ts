// 리듬 게임 페이지 진입점: 스틱 준비 → 곡 선택 → 카운트다운 → 연주(판정) → 결과
//
// [한눈에 보기]
//
//   스틱(IMU) · 보드 버튼 ─BLE─▶ ble.ts ─onHit─┐
//   키보드 D F J K · 스페이스 · 1~5 ─────────────┼─▶ onInput(드럼, 친 시각)
//   화면 줄 터치 ────────────────────────────────┘      ├─ audio.play()    친 드럼 소리
//                                                       └─ game.hit()      가장 가까운 노트 판정 (game.ts)
//                                                          (빗나가면 "← 더 왼쪽" 같은 방향 힌트)
//   스틱 방향(모션 패킷 25Hz) ─onMotion─▶ 화면 속 스틱이 따라 움직임 / 줄 화면에서는 "지금 겨눈 줄" 표시
//
// [설명] 화면 두 가지 (곡 선택에서 고름)
//   드럼 키트 (기본) : 드럼 세트 그림(kit/scene.ts) 위에서, 음표가 링이 되어 드럼을 향해 좁혀 들어온다.
//                      링이 드럼 테두리에 딱 맞는 순간 그 드럼을 치면 된다. 스틱으로 실제 드럼을 치는 느낌.
//   줄              : 위에서 떨어지는 음표 (아래 설명)
//
// [설명] 줄 배치 = 스틱 방향
//   줄은 왼쪽부터 하이햇(←) · 스네어(정면) · 탐(→) · 크래시(↑) 순서다. 스틱을 휘두르는 방향과
//   화면의 줄 위치가 같아서, 노트가 떨어지는 줄 쪽으로 스틱을 겨누고 치면 된다.
//   킥은 발(보드 버튼 2 · 스페이스)이라 줄이 아니라 트랙 전체를 가로지르는 막대로 떨어진다.
//
//   requestAnimationFrame 마다 frame():
//     ├─ scheduleAudio()   곧 나올 메트로놈·가이드 소리를 오디오 엔진에 미리 예약
//     ├─ game.update()     놓친 노트 Miss 처리
//     └─ draw()            줄 · 박자선 · 떨어지는 노트 · 판정 글자 그리기
//
// [설명] 시계 두 개
//   화면·입력은 performance.now()(ms), 소리는 AudioContext 시각(초)을 쓴다.
//   getOutputTimestamp()는 "지금 스피커로 나가는 소리의 오디오 시각 ↔ performance 시각" 쌍을 알려 준다.
//   이걸로 변환하면 가이드 소리가 스피커에서 실제로 들리는 순간을 노트가 판정선에 닿는 순간에 맞출 수 있다.

import { AirBandConnection, CMD, webBluetoothSupport } from '../ble';
import { DrumAudio } from '../audio';
import { RhythmGame, WINDOW_MS, POINTS, type Judgement } from './game';
import { SONGS, buildChart, type Chart, type Song } from './charts';
import { KitScene, zoneOfAim } from '../kit/scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------
const DRUMS = 5; // 드럼 class 0~4 (스네어 · 킥 · 하이햇 · 탐 · 크래시)
const KICK = 1;
const COLUMNS = 4;
/** 화면 줄 → 드럼 class. 스틱 방향 순서 (왼쪽 하이햇 · 정면 스네어 · 오른쪽 탐 · 위 크래시) */
const CLS_OF_COLUMN = [2, 0, 3, 4];
/** 드럼 class → 화면 줄. 킥은 -1 (트랙 전체 가로 막대) */
const columnOf = (cls: number) => CLS_OF_COLUMN.indexOf(cls);
const hueOf = (cls: number) => (200 + cls * 70) % 360; // 자유 연주 · 드럼 키트 화면과 같은 색
const DRUM_NAMES = ['스네어', '킥', '하이햇', '탐', '크래시'];
const DIRECTION_OF = ['정면', '버튼 2', '← 왼쪽', '오른쪽 →', '↑ 위로'];
const KEY_LABEL = ['F', '스페이스', 'D', 'J', 'K'];
const KEY_TO_DRUM: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, f: 0, ' ': 1, d: 2, j: 3, k: 4 };
/** 모션 패킷이 이 시간 동안 안 오면 "겨눈 줄" 표시를 끈다 */
const AIM_STALE_MS = 800;
/** 드럼 키트 화면: 링이 이 시간(ms, 속도 1배) 전부터 보이기 시작해 드럼으로 좁혀 들어온다 */
const APPROACH_MS = 1500;
const LEAD_IN_BEATS = 4; // 시작 전 "4, 3, 2, 1" 카운트
const BASE_PX_PER_MS = 0.4; // 음표 속도 1배일 때 1초에 400px 이동
const SCHEDULE_AHEAD_MS = 200; // 이만큼 앞의 소리를 미리 예약
const GUIDE_VELOCITY = 55; // 가이드 소리는 작게 (내가 친 소리와 구분)
const INPUT_VELOCITY = 100;

const JUDGE_STYLE: Record<Judgement, { text: string; hue: number }> = {
  perfect: { text: 'PERFECT', hue: 45 },
  great: { text: 'GREAT', hue: 200 },
  good: { text: 'GOOD', hue: 150 },
  miss: { text: 'MISS', hue: 0 },
};

// ---------------------------------------------------------------------------
// 설정 · 최고 기록 (브라우저에 저장. 저장이 막혀 있어도 게임은 동작)
// ---------------------------------------------------------------------------
interface Settings {
  guide: boolean;
  metronome: boolean;
  speed: number;
  offsetMs: number; // 입력 보정: 양수면 "늦게 쳐도 맞게" 판정
  view: 'kit' | 'lanes';
}
const DEFAULT_SETTINGS: Settings = { guide: true, metronome: true, speed: 1, offsetMs: 0, view: 'kit' };
type Best = Record<string, { score: number; rank: string }>;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장 불가(시크릿 모드 등) — 이번 방문 동안만 유지
  }
}

const settings: Settings = load('airband.rhythm.settings', DEFAULT_SETTINGS);
const best: Best = load('airband.rhythm.best', {});

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
type State = 'menu' | 'play' | 'result';
let state: State = 'menu';
let song: Song = SONGS[0];
let chart: Chart | null = null;
let game: RhythmGame | null = null;
let songStart = 0; // 곡의 0ms가 되는 performance.now() 값

interface AudioEvent {
  time: number; // 게임 시각 ms
  kind: 'click' | 'guide';
  lane: number;
  accent: boolean;
}
let events: AudioEvent[] = [];
let nextEvent = 0;

// 그리기 효과
const drumFlash = new Array<number>(DRUMS).fill(-Infinity); // 드럼별 친 시각
interface Popup { lane: number; judgement: Judgement; at: number; delta: number }
const popups: Popup[] = [];
/** 엉뚱한 드럼을 쳤을 때 쳐야 했던 줄에 뜨는 방향 힌트 */
interface DirHint { lane: number; text: string; at: number }
const hints: DirHint[] = [];

// 스틱 상태
let aimCls = -1; // 지금 스틱이 겨눈 드럼 (보드가 판정한 구역)
let aimAt = -Infinity;
let minOffset = Infinity; // BLE 지터 제거용 (수신 시각 - 보드 시각)의 최솟값
const sensorHit = new Set<number>(); // 스틱 준비: 센서로 쳐 본 드럼
let recentered = false;

const audio = new DrumAudio();
const conn = new AirBandConnection();
const canvas = $<HTMLCanvasElement>('game');
const ctx2d = canvas.getContext('2d')!;
const kitCanvas = $<HTMLCanvasElement>('kit');
const scene = new KitScene(kitCanvas, hueOf, (cls) => DRUM_NAMES[cls]);
scene.showNames = false;
scene.overlay = drawKitOverlay;
let clickBuffers: { normal: AudioBuffer; accent: AudioBuffer } | null = null;

// ---------------------------------------------------------------------------
// 소리: 메트로놈 클릭 · 가이드 · 시각 변환
// ---------------------------------------------------------------------------

/** 짧은 "틱" 소리. accent는 마디 첫 박(더 높은 음) */
function makeClick(freq: number): AudioBuffer {
  const sr = audio.ctx.sampleRate;
  const n = Math.floor(sr * 0.04);
  const buf = audio.ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr) * Math.exp(-i / (sr * 0.008)) * 0.5;
  return buf;
}

function playClickAt(accent: boolean, when: number): void {
  if (!clickBuffers) return;
  const src = audio.ctx.createBufferSource();
  src.buffer = accent ? clickBuffers.accent : clickBuffers.normal;
  src.connect(audio.ctx.destination);
  src.start(when);
}

/** performance.now() 기준 시각(ms) → 그 순간 스피커에서 들리도록 하는 오디오 시각(초) */
function perfToAudioTime(perfMs: number): number {
  const ts = audio.ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime && ts.contextTime !== undefined) {
    return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
  }
  // 지원하지 않는 브라우저: 출력 지연 보정 없이 현재 시각 기준으로
  return audio.ctx.currentTime + (perfMs - performance.now()) / 1000;
}

/** 지금부터 SCHEDULE_AHEAD_MS 안에 나올 소리를 미리 예약 */
function scheduleAudio(t: number): void {
  while (nextEvent < events.length && events[nextEvent].time < t + SCHEDULE_AHEAD_MS) {
    const ev = events[nextEvent++];
    const when = Math.max(audio.ctx.currentTime, perfToAudioTime(songStart + ev.time));
    if (ev.kind === 'click') playClickAt(ev.accent, when);
    else audio.playAt(ev.lane, GUIDE_VELOCITY, when);
  }
}

// ---------------------------------------------------------------------------
// 게임 진행
// ---------------------------------------------------------------------------
function startSong(): void {
  void audio.resume();
  chart = buildChart(song);
  game = new RhythmGame(chart.notes);
  popups.length = 0;

  // 소리 이벤트 목록: 카운트인(항상) + 메트로놈 + 가이드
  events = [];
  for (let i = 0; i < LEAD_IN_BEATS; i++) {
    events.push({ time: -(LEAD_IN_BEATS - i) * chart.beatMs, kind: 'click', lane: 0, accent: i === 0 });
  }
  if (settings.metronome) {
    chart.beats.forEach((b, i) => events.push({ time: b, kind: 'click', lane: 0, accent: i % 4 === 0 }));
  }
  if (settings.guide) {
    for (const n of chart.notes) events.push({ time: n.time, kind: 'guide', lane: n.lane, accent: false });
  }
  events.sort((a, b) => a.time - b.time);
  nextEvent = 0;

  // 0.5초 여유 + 카운트인 뒤에 곡 시작
  songStart = performance.now() + 500 + LEAD_IN_BEATS * chart.beatMs;
  setState('play');
  $('hud-title').textContent = song.title;
}

function finishSong(): void {
  if (!game) return;
  const prev = best[song.id];
  if (!prev || game.score > prev.score) {
    best[song.id] = { score: game.score, rank: game.rank };
    save('airband.rhythm.best', best);
  }
  showResult();
  setState('result');
}

function quitToMenu(): void {
  game = null;
  chart = null;
  events = [];
  renderSongs();
  setState('menu');
}

function setState(s: State): void {
  state = s;
  $('menu').hidden = s !== 'menu';
  $('result').hidden = s !== 'result';
  $('hud').hidden = s !== 'play';
  $('count').hidden = true;
  if (s !== 'play') $('progress').style.width = '0';
}

// ---------------------------------------------------------------------------
// 입력
// ---------------------------------------------------------------------------

/**
 * 모든 입력이 모이는 곳.
 * @param perfTime 친 순간의 performance.now() 값 (BLE는 수신 시각, 키보드·터치는 이벤트 시각)
 */
function onInput(cls: number, perfTime: number, velocity = INPUT_VELOCITY): void {
  if (cls < 0 || cls >= DRUMS) return;
  void audio.resume();
  audio.play(cls, velocity);
  scene.hit(cls, velocity);
  const now = performance.now();
  drumFlash[cls] = now;

  if (state !== 'play' || !game) return;
  const t = perfTime - songStart - settings.offsetMs;
  const r = game.hit(cls, t);
  if (r) {
    popups.push({ lane: cls, judgement: r.judgement, at: now, delta: r.delta });
    return;
  }
  // 타이밍은 맞는데 다른 드럼을 쳤다 → 쳐야 했던 줄에 방향 힌트
  const want = game.pendingNear(t);
  if (want && want.lane !== cls) hints.push({ lane: want.lane, text: directionHint(cls, want.lane), at: now });
}

/** 친 드럼 → 쳐야 했던 드럼으로 가려면 스틱을 어느 쪽으로 */
function directionHint(hit: number, want: number): string {
  if (want === KICK) return '킥은 버튼 2';
  if (want === 4) return '↑ 더 위로';
  if (hit === KICK) return `스틱 ${DIRECTION_OF[want]}`;
  if (hit === 4) return '↓ 내려서';
  return columnOf(want) < columnOf(hit) ? '← 더 왼쪽' : '더 오른쪽 →';
}

// [설명] 센서 타격 시각 = 보드 시각 + 가장 빨랐던 전송 지연.
//   BLE는 패킷마다 도착이 수~수십 ms씩 들쭉날쭉하다. 수신 시각 대신 이 값을 쓰면 그 흔들림이 판정에 섞이지 않는다.
conn.onHit = (e) => {
  const offset = e.receivedAt - e.boardMs;
  if (offset < minOffset) minOffset = offset;
  sensorHit.add(e.cls);
  renderStick();
  onInput(e.cls, e.boardMs + minOffset, e.velocity);
};
conn.onMotion = (m) => {
  const changed = m.zone !== aimCls || performance.now() - aimAt > AIM_STALE_MS;
  aimCls = m.zone;
  aimAt = m.receivedAt;
  scene.setAim({ h: m.headingDeg, e: m.elevationDeg }, m.zone);
  if (changed) renderStick();
};

function recenter(): void {
  if (statusEl.dataset.state !== 'connected') return;
  void conn.send(CMD.recenter);
  recentered = true;
  renderStick();
}

window.addEventListener('keydown', (ev) => {
  if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const cls = KEY_TO_DRUM[ev.key.toLowerCase()];
  if (cls !== undefined) {
    ev.preventDefault();
    onInput(cls, ev.timeStamp);
    return;
  }
  if (ev.key === 'c' || ev.key === 'C') {
    recenter();
    return;
  }
  if (ev.key === 'Escape' && state === 'play') quitToMenu();
  if (ev.key === 'Enter' && state !== 'play') {
    ev.preventDefault();
    startSong();
  }
});

// 화면 줄 터치/클릭 (게임 중에만. 메뉴에서는 오버레이가 위에 있어 캔버스가 안 눌림)
// 드럼 키트 화면: 드럼을 누르면 그 드럼 (킥은 킥 북, 나머지는 펌웨어와 같은 방향 규칙)
kitCanvas.addEventListener('pointerdown', (ev) => {
  const cls = scene.isOnKick(ev.offsetX, ev.offsetY) ? KICK : zoneOfAim(scene.toAngles(ev.offsetX, ev.offsetY));
  onInput(cls, ev.timeStamp);
});

// 판정선 아래 킥 띠를 누르면 킥
canvas.addEventListener('pointerdown', (ev) => {
  const { left, laneW, hitY } = layout();
  if (ev.offsetY > hitY + 58) {
    onInput(KICK, ev.timeStamp);
    return;
  }
  const col = Math.floor((ev.offsetX - left) / laneW);
  if (col >= 0 && col < COLUMNS) onInput(CLS_OF_COLUMN[col], ev.timeStamp);
});

// 탭을 떠나면 시계가 어긋나므로 곡을 멈춘다
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play') quitToMenu();
});

// ---------------------------------------------------------------------------
// 그리기
// ---------------------------------------------------------------------------
let W = 0;
let H = 0;
const dark = window.matchMedia('(prefers-color-scheme: dark)');

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  W = r.width;
  H = r.height;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

/** 줄 배치: 가운데 정렬, 최대 폭 560px */
function layout() {
  const trackW = Math.min(W - 24, 560);
  const left = (W - trackW) / 2;
  return { left, laneW: trackW / COLUMNS, trackW, hitY: H - 104 };
}

/** 줄 아래쪽이 위로 번쩍이는 효과 */
function glow(x: number, w: number, hitY: number, hue: number, f: number): void {
  const g = ctx2d.createLinearGradient(0, hitY, 0, hitY - 260);
  g.addColorStop(0, `hsla(${hue}, 85%, 55%, ${0.45 * f})`);
  g.addColorStop(1, `hsla(${hue}, 85%, 55%, 0)`);
  ctx2d.fillStyle = g;
  ctx2d.fillRect(x, hitY - 260, w, 260);
}

/** 판정 글자 · 힌트의 가로 위치 (킥은 가운데) */
function popupX(cls: number): number {
  const { left, laneW, trackW } = layout();
  const col = columnOf(cls);
  return col < 0 ? left + trackW / 2 : left + (col + 0.5) * laneW;
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx2d.beginPath();
  ctx2d.roundRect(x, y, w, h, r);
}

// ---------------------------------------------------------------------------
// 드럼 키트 화면 덧그리기: 다가오는 링 · 판정 글자 · 방향 힌트 · 콤보
// ---------------------------------------------------------------------------
function drawKitOverlay(c: CanvasRenderingContext2D, now: number): void {
  if (settings.view !== 'kit') return;
  const t = state === 'play' ? now - songStart : -Infinity;
  const lead = APPROACH_MS / settings.speed;

  // 다가오는 링: 남은 시간에 비례해 크다가, 칠 순간 드럼 테두리와 겹친다
  if (game) {
    for (const n of game.notes) {
      const dt = n.time - t;
      if (dt > lead) break;
      if (n.judgement || dt < -WINDOW_MS.good) continue;
      const k = Math.max(0, dt / lead); // 1 → 0
      const hue = hueOf(n.lane);
      for (const g of scene.geomAll(n.lane)) {
        const grow = 1 + 1.8 * k;
        c.save();
        c.strokeStyle = `hsla(${hue}, 90%, 62%, ${0.3 + 0.7 * (1 - k)})`;
        c.lineWidth = 2 + 4 * (1 - k);
        if (k < 0.1) {
          c.shadowColor = `hsl(${hue}, 90%, 60%)`;
          c.shadowBlur = 18;
        }
        c.beginPath();
        c.ellipse(g.x, g.y, g.rx * grow + 4, g.ry * grow + 4, 0, 0, Math.PI * 2);
        c.stroke();
        c.restore();
      }
    }
  }

  const above = (cls: number) => {
    const g = scene.geomAll(cls)[0];
    if (!g) return { x: 0, y: 0 };
    // 킥은 스네어 바로 아래라 위에 쓰면 스네어와 겹친다 → 킥 북 안쪽 아래에
    return cls === KICK ? { x: g.x, y: g.y + g.ry * 0.6 } : { x: g.x, y: g.y - g.ry - 22 };
  };
  c.textAlign = 'center';
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    const age = (now - p.at) / 500;
    if (age >= 1) {
      popups.splice(i, 1);
      continue;
    }
    const { x, y } = above(p.lane);
    const st = JUDGE_STYLE[p.judgement];
    c.globalAlpha = 1 - age;
    c.fillStyle = `hsl(${st.hue}, 90%, 65%)`;
    c.font = '800 20px system-ui, sans-serif';
    c.fillText(st.text, x, y - age * 30);
    if (p.judgement !== 'miss' && Math.abs(p.delta) > WINDOW_MS.perfect) {
      c.font = '12px system-ui, sans-serif';
      c.fillStyle = 'rgba(255,255,255,0.7)';
      const d = Math.round(p.delta);
      c.fillText(d < 0 ? `빠름 ${-d}ms` : `늦음 ${d}ms`, x, y + 16 - age * 30);
    }
    c.globalAlpha = 1;
  }
  for (let i = hints.length - 1; i >= 0; i--) {
    const h = hints[i];
    const age = (now - h.at) / 700;
    if (age >= 1) {
      hints.splice(i, 1);
      continue;
    }
    const { x, y } = above(h.lane);
    c.globalAlpha = 1 - age;
    c.fillStyle = '#fbbf24';
    c.font = '800 17px system-ui, "Noto Sans KR", sans-serif';
    c.fillText(h.text, x, y - 26 - age * 20);
    c.globalAlpha = 1;
  }
  if (game && game.combo >= 5) {
    const w = kitCanvas.clientWidth;
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.font = '900 40px system-ui, sans-serif';
    c.fillText(String(game.combo), w / 2, 92);
    c.font = '700 12px system-ui, sans-serif';
    c.fillText('COMBO', w / 2, 110);
  }
}

function applyView(): void {
  const kit = settings.view === 'kit';
  kitCanvas.hidden = !kit;
  canvas.hidden = kit;
  $('stage').classList.toggle('kitview', kit);
}

function draw(now: number): void {
  if (settings.view === 'kit') return; // 드럼 키트 화면은 scene이 스스로 그린다 (drawKitOverlay)
  const { left, laneW, trackW, hitY } = layout();
  const isDark = dark.matches;
  const t = state === 'play' ? now - songStart : 0;
  const pxPerMs = BASE_PX_PER_MS * settings.speed;
  const yOf = (time: number) => hitY - (time - t) * pxPerMs;

  ctx2d.clearRect(0, 0, W, H);

  // 줄 배경 + 스틱이 겨눈 줄 + 친 순간 번쩍임
  const aiming = now - aimAt < AIM_STALE_MS ? columnOf(aimCls) : -1;
  for (let i = 0; i < COLUMNS; i++) {
    const cls = CLS_OF_COLUMN[i];
    const hue = hueOf(cls);
    const x = left + i * laneW;
    const base = i === aiming ? 0.2 : isDark ? 0.07 : 0.06;
    ctx2d.fillStyle = `hsla(${hue}, ${isDark ? 40 : 60}%, 50%, ${base})`;
    ctx2d.fillRect(x + 1, 0, laneW - 2, H);
    const f = 1 - (now - drumFlash[cls]) / 160;
    if (f > 0) glow(x + 1, laneW - 2, hitY, hue, f);
  }
  // 킥: 트랙 전체 아래쪽이 번쩍
  const kf = 1 - (now - drumFlash[KICK]) / 160;
  if (kf > 0) glow(left, trackW, hitY, hueOf(KICK), kf * 0.7);
  // 킥 띠 (판정선 아래, 터치로 킥)
  ctx2d.fillStyle = `hsla(${hueOf(KICK)}, 60%, 50%, ${isDark ? 0.12 : 0.08})`;
  ctx2d.fillRect(left, hitY + 58, trackW, H - hitY - 58);

  // 박자선 (마디 첫 박은 진하게)
  if (chart) {
    const firstBeat = -LEAD_IN_BEATS;
    const lastBeat = chart.beats.length;
    for (let b = firstBeat; b <= lastBeat; b++) {
      const y = yOf(b * chart.beatMs);
      if (y < -10 || y > hitY) continue;
      ctx2d.fillStyle = isDark ? `rgba(255,255,255,${b % 4 === 0 ? 0.16 : 0.06})` : `rgba(0,0,0,${b % 4 === 0 ? 0.14 : 0.05})`;
      ctx2d.fillRect(left, y, trackW, b % 4 === 0 ? 2 : 1);
    }
  }

  // 떨어지는 노트. 킥(가로 막대)을 먼저 그려서 다른 노트 밑에 깔리게
  if (game) {
    const noteH = 16;
    for (const pass of [0, 1]) {
      for (const n of game.notes) {
        if (n.judgement && n.judgement !== 'miss') continue; // 맞힌 노트는 사라짐
        const y = yOf(n.time);
        if (y < -noteH) break; // 이후 노트는 화면 위쪽 밖 (시간순)
        if (y > H + noteH) continue;
        const isKick = n.lane === KICK;
        if (isKick !== (pass === 0)) continue;
        const missed = n.judgement === 'miss';
        ctx2d.fillStyle = missed
          ? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)')
          : `hsl(${hueOf(n.lane)}, ${isKick ? 55 : 80}%, ${isDark ? 62 : 50}%)`;
        if (isKick) {
          roundRect(left + 2, y - 4, trackW - 4, 8, 4);
        } else {
          const x = left + columnOf(n.lane) * laneW + 8;
          roundRect(x, y - noteH / 2, laneW - 16, noteH, 6);
        }
        ctx2d.fill();
      }
    }
  }

  // 판정선
  ctx2d.fillStyle = isDark ? 'rgba(255,255,255,0.75)' : 'rgba(15,23,42,0.8)';
  ctx2d.fillRect(left, hitY - 2, trackW, 4);

  // 스틱이 겨눈 줄: 판정선 위에 스틱 끝 표시
  if (aiming >= 0) {
    const cx = left + (aiming + 0.5) * laneW;
    const hue = hueOf(aimCls);
    ctx2d.save();
    ctx2d.shadowColor = `hsl(${hue}, 90%, 60%)`;
    ctx2d.shadowBlur = 12;
    ctx2d.fillStyle = `hsl(${hue}, 90%, ${isDark ? 68 : 50}%)`;
    ctx2d.beginPath();
    ctx2d.arc(cx, hitY, 9, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.restore();
  }

  // 판정선 아래 줄 이름 · 방향 · 키
  ctx2d.textAlign = 'center';
  const dim = isDark ? '#8b93a1' : '#6b7280';
  for (let i = 0; i < COLUMNS; i++) {
    const cls = CLS_OF_COLUMN[i];
    const cx = left + (i + 0.5) * laneW;
    ctx2d.fillStyle = `hsl(${hueOf(cls)}, 75%, ${isDark ? 65 : 42}%)`;
    ctx2d.font = '700 15px system-ui, "Noto Sans KR", sans-serif';
    ctx2d.fillText(DRUM_NAMES[cls], cx, hitY + 28);
    ctx2d.fillStyle = dim;
    ctx2d.font = '12px system-ui, "Noto Sans KR", sans-serif';
    ctx2d.fillText(`${DIRECTION_OF[cls]} · ${KEY_LABEL[cls]}`, cx, hitY + 46);
  }
  ctx2d.fillStyle = `hsl(${hueOf(KICK)}, 60%, ${isDark ? 70 : 40}%)`;
  ctx2d.font = '600 12px system-ui, "Noto Sans KR", sans-serif';
  ctx2d.fillText('━━ 킥 = 보드 버튼 2 · 스페이스 · 여기 터치 ━━', left + trackW / 2, hitY + 80);

  // 판정 글자 (0.5초 동안 떠오르며 사라짐)
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    const age = (now - p.at) / 500;
    if (age >= 1) {
      popups.splice(i, 1);
      continue;
    }
    const cx = popupX(p.lane);
    const st = JUDGE_STYLE[p.judgement];
    ctx2d.globalAlpha = 1 - age;
    ctx2d.fillStyle = `hsl(${st.hue}, 85%, ${isDark ? 62 : 45}%)`;
    ctx2d.font = '800 17px system-ui, sans-serif';
    ctx2d.fillText(st.text, cx, hitY - 24 - age * 30);
    if (p.judgement !== 'miss') {
      // 빠름/늦음 표시: 연습할 때 어느 쪽으로 틀리는지 보이게
      ctx2d.font = '11px system-ui, sans-serif';
      ctx2d.fillStyle = isDark ? '#8b93a1' : '#6b7280';
      const d = Math.round(p.delta);
      ctx2d.fillText(Math.abs(d) <= WINDOW_MS.perfect ? '' : d < 0 ? `빠름 ${-d}ms` : `늦음 ${d}ms`, cx, hitY - 8 - age * 30);
    }
    ctx2d.globalAlpha = 1;
  }

  // 방향 힌트 (0.7초)
  for (let i = hints.length - 1; i >= 0; i--) {
    const h = hints[i];
    const age = (now - h.at) / 700;
    if (age >= 1) {
      hints.splice(i, 1);
      continue;
    }
    ctx2d.globalAlpha = 1 - age;
    ctx2d.fillStyle = isDark ? '#fbbf24' : '#b45309';
    ctx2d.font = '800 15px system-ui, "Noto Sans KR", sans-serif';
    ctx2d.fillText(h.text, popupX(h.lane), hitY - 70 - age * 20);
    ctx2d.globalAlpha = 1;
  }

  // 콤보
  if (game && game.combo >= 5) {
    ctx2d.fillStyle = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.85)';
    ctx2d.font = '900 44px system-ui, sans-serif';
    ctx2d.fillText(String(game.combo), left + trackW / 2, H * 0.34);
    ctx2d.font = '700 13px system-ui, sans-serif';
    ctx2d.fillText('COMBO', left + trackW / 2, H * 0.34 + 22);
  }
}

// ---------------------------------------------------------------------------
// 매 프레임
// ---------------------------------------------------------------------------
function frame(now: number): void {
  if (state === 'play' && game && chart) {
    const t = now - songStart;
    scheduleAudio(t);

    for (const n of game.update(t - settings.offsetMs)) {
      popups.push({ lane: n.lane, judgement: 'miss', at: now, delta: 0 });
    }

    // 카운트다운 숫자
    const countEl = $('count');
    if (t < 0) {
      const left = Math.ceil(-t / chart.beatMs);
      countEl.hidden = left > LEAD_IN_BEATS;
      countEl.textContent = String(left);
    } else {
      countEl.hidden = true;
    }

    updateHud(t);
    if (game.finished && t > chart.durationMs) finishSong();
  }
  draw(now);
  requestAnimationFrame(frame);
}

function updateHud(t: number): void {
  if (!game || !chart) return;
  const c = game.counts;
  const judged = c.perfect + c.great + c.good + c.miss;
  const acc = judged ? game.score / (judged * POINTS.perfect) : 1;
  $('hud-score').textContent = game.score.toLocaleString('ko-KR');
  $('hud-acc').textContent = `${(acc * 100).toFixed(1)}%`;
  $('progress').style.width = `${Math.max(0, Math.min(1, t / chart.durationMs)) * 100}%`;
}

// ---------------------------------------------------------------------------
// 메뉴 · 결과 화면
// ---------------------------------------------------------------------------
function renderSongs(): void {
  const list = $('songs');
  list.replaceChildren();
  for (const s of SONGS) {
    const c = buildChart(s);
    const b = best[s.id];
    const el = document.createElement('button');
    el.className = 'song';
    el.setAttribute('aria-pressed', String(s.id === song.id));
    el.innerHTML = `
      <span class="t">${s.title}</span>
      <span class="lv">${'★'.repeat(s.level)}${'☆'.repeat(3 - s.level)}</span>
      <span class="d">${s.description}</span>
      <span class="info">BPM ${s.bpm} · 노트 ${c.notes.length}개 · ${Math.round(c.durationMs / 1000)}초${
        b ? ` · 최고 기록 ${b.rank} ${b.score.toLocaleString('ko-KR')}점` : ''
      }</span>`;
    el.addEventListener('click', () => {
      song = s;
      renderSongs();
    });
    el.addEventListener('dblclick', startSong);
    list.append(el);
  }
}

/** 버튼 여러 개 중 하나를 고르는 옵션 */
function segmented<T>(id: string, options: [T, string][], get: () => T, set: (v: T) => void): void {
  const box = $(id);
  const render = () => {
    box.replaceChildren();
    for (const [value, label] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(get() === value));
      b.addEventListener('click', () => {
        set(value);
        save('airband.rhythm.settings', settings);
        render();
      });
      box.append(b);
    }
  };
  render();
}

function formatOffset(ms: number): string {
  return ms === 0 ? '0ms' : ms > 0 ? `+${ms}ms` : `${ms}ms`;
}

function setupOptions(): void {
  segmented('opt-guide', [[true, '켜기'], [false, '끄기']], () => settings.guide, (v) => (settings.guide = v));
  segmented('opt-metro', [[true, '켜기'], [false, '끄기']], () => settings.metronome, (v) => (settings.metronome = v));
  segmented<Settings['view']>('opt-view', [['kit', '드럼 키트'], ['lanes', '줄']], () => settings.view, (v) => {
    settings.view = v;
    applyView();
  });
  segmented('opt-speed', [[0.75, '느리게'], [1, '보통'], [1.5, '빠르게'], [2, '아주 빠르게']], () => settings.speed, (v) => (settings.speed = v));

  const range = $<HTMLInputElement>('opt-offset');
  const out = $('opt-offset-out');
  range.value = String(settings.offsetMs);
  out.textContent = formatOffset(settings.offsetMs);
  range.addEventListener('input', () => {
    settings.offsetMs = Number(range.value);
    out.textContent = formatOffset(settings.offsetMs);
    save('airband.rhythm.settings', settings);
  });
}

function showResult(): void {
  if (!game) return;
  const rankHue: Record<string, number> = { S: 45, A: 150, B: 200, C: 270, D: 0 };
  $('res-title').textContent = song.title;
  const rankEl = $('res-rank');
  rankEl.textContent = game.rank;
  rankEl.style.color = `hsl(${rankHue[game.rank]}, 80%, ${dark.matches ? 62 : 45}%)`;
  $('res-score').textContent = game.score.toLocaleString('ko-KR');
  $('res-acc').textContent = `${(game.accuracy * 100).toFixed(1)}%`;
  $('res-combo').textContent = String(game.maxCombo);
  $('res-perfect').textContent = String(game.counts.perfect);
  $('res-great').textContent = String(game.counts.great);
  $('res-good').textContent = String(game.counts.good);
  $('res-miss').textContent = String(game.counts.miss);

  // 타이밍 분석 → 입력 보정 추천
  const calib = $('res-calib');
  const mean = Math.round(game.meanDelta);
  if (game.deltas.length < 8) {
    calib.textContent = '맞힌 노트가 적어서 타이밍 분석은 건너뛰었습니다.';
    return;
  }
  if (Math.abs(mean) < 10) {
    calib.textContent = `타이밍이 정확합니다. (평균 ${formatOffset(mean)})`;
    return;
  }
  const suggested = Math.max(-150, Math.min(150, Math.round((settings.offsetMs + mean) / 5) * 5));
  calib.innerHTML = `평균 <b>${Math.abs(mean)}ms ${mean > 0 ? '늦게' : '빨리'}</b> 쳤습니다.
    입력 보정을 <b>${formatOffset(suggested)}</b>로 바꾸면 판정이 몸의 타이밍에 맞춰집니다.
    <button id="res-apply" style="margin-left:6px">보정 적용</button>`;
  $('res-apply').addEventListener('click', (ev) => {
    settings.offsetMs = suggested;
    save('airband.rhythm.settings', settings);
    setupOptions();
    (ev.currentTarget as HTMLButtonElement).replaceWith(document.createTextNode(' ✓ 적용했습니다.'));
  });
}

// ---------------------------------------------------------------------------
// 연결 UI (자유 연주 화면과 같은 방식)
// ---------------------------------------------------------------------------
const connectBtn = $<HTMLButtonElement>('connect');
const statusEl = $('status');

conn.onState = (s, detail) => {
  statusEl.dataset.state = s;
  if (s === 'connected') {
    minOffset = Infinity;
    void conn.send(CMD.motionOn); // 겨눈 줄 표시용
  } else if (s === 'disconnected') {
    aimAt = -Infinity;
    recentered = false;
    sensorHit.clear();
  }
  renderStick();
  statusEl.textContent = s === 'connected' ? `연결됨 · ${detail ?? ''}` : s === 'connecting' ? '연결 중…' : detail ? `연결 안 됨 · ${detail}` : '연결 안 됨';
  connectBtn.textContent = s === 'connected' ? '연결 끊기' : s === 'connecting' ? '연결 중…' : '센서 연결';
  connectBtn.disabled = s === 'connecting';
};

connectBtn.addEventListener('click', async () => {
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
// 스틱 준비 (메뉴): ① 연결 ② 정면 맞추기 ③ 방향마다 한 번씩 쳐 보기
// ---------------------------------------------------------------------------
const STICK_ORDER = [2, 0, 3, 4, KICK]; // 하이햇 · 스네어 · 탐 · 크래시 · 킥

function renderStick(): void {
  const connected = statusEl.dataset.state === 'connected';
  const motion = performance.now() - aimAt < AIM_STALE_MS;
  $('step-connect').classList.toggle('done', connected);
  $('step-center').classList.toggle('done', recentered);
  const allHit = STICK_ORDER.every((c) => sensorHit.has(c));
  $('step-try').classList.toggle('done', allHit);
  $<HTMLButtonElement>('recenter').disabled = !connected;
  const chips = $('chips');
  chips.replaceChildren();
  for (const cls of STICK_ORDER) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--hue', String(hueOf(cls)));
    if (sensorHit.has(cls)) chip.classList.add('ok');
    if (motion && cls === aimCls) chip.classList.add('aim');
    chip.textContent = `${DRUM_NAMES[cls]} ${DIRECTION_OF[cls]}`;
    chips.append(chip);
  }
  $('aim-now').textContent = !connected
    ? '센서 연결 전 — 키보드 · 터치로도 할 수 있습니다'
    : motion
      ? `지금 겨눈 곳: ${DRUM_NAMES[aimCls] ?? '?'}`
      : '방향 데이터 없음 — 보드 버튼으로만 칠 수 있습니다 (IMU 확인)';
}
setInterval(renderStick, 500);
$('recenter').addEventListener('click', recenter);

$('start').addEventListener('click', startSong);
$('res-retry').addEventListener('click', startSong);
$('res-menu').addEventListener('click', quitToMenu);

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------
async function init(): Promise<void> {
  const support = webBluetoothSupport();
  if (!support.ok) {
    connectBtn.disabled = true;
    const hint = $('connect-hint');
    hint.textContent = support.reason!;
    hint.hidden = false;
  }
  renderStick();
  renderSongs();
  setupOptions();
  applyView();
  resize();
  requestAnimationFrame(frame);
  await audio.init();
  clickBuffers = { normal: makeClick(1000), accent: makeClick(1600) };
}

void init();
