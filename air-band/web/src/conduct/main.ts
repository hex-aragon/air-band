// 지휘 화면 진입점: 따라하기 연습 · 실전 지휘
//
// [한눈에 보기]
//
//   보드 / 폰 ─(지휘 모드 'k')─▶ 박 이벤트(mode 1, velocity = 박 크기) ─▶ ictus()
//            └─ 모션 25Hz ─▶ 겨눈 방향 → 파트 강조 (왼쪽 현악 · 오른쪽 관악/타악), 화면의 지휘봉
//   센서가 없으면 스페이스바 / 화면 탭이 박이다 (마우스 위치 = 겨눈 방향).
//
//   따라하기 연습: 템포 고정(FixedTempo). 오케스트라 · 메트로놈 · 노란 공(4박 도형)이 먼저 가고 사용자가 따라 한다
//                → 박마다 "정확 / 빨라요 / 늦어요"와 2박(왼쪽) · 3박(오른쪽) 방향을 알려 주고, 끝나면 점수
//   실전 지휘   : 템포를 사용자가 정한다(TempoFollower). 준비 박 두 번 → 연주, 빨라지면 따라오고 멈추면 기다린다
//   두 모드 모두 아래에 악보가 흐르며 지금 음과 박 세기(1 2 3 4)를 보여 준다.
import { mountHeader, attachStick, calibrate } from '../ui/header';
mountHeader('conduct');

import { AirBandConnection, CMD, webBluetoothSupport, type HitEvent, type MotionEvent } from '../ble';
import { FixedTempo, TempoFollower, type Clock } from './follower';
import { ConductPlayer } from './player';
import { barOf, beatInBar, type Score } from './score';
import { SONGS } from './songs';
import { ScoreView } from './score_view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Mode = 'practice' | 'live';
let score: Score = SONGS[0];
const conn = new AirBandConnection();
const player = new ConductPlayer();
let scoreView = new ScoreView(score);

/** 연습 모드 준비 박 (메트로놈만): 한 마디 + 못갖춘마디 앞 빈 박 → 준비 박이 늘 마디 첫 박에서 시작한다 */
const countIn = () => score.beatsPerBar + ((((score.beatsPerBar - score.anacrusis) % score.beatsPerBar) + score.beatsPerBar) % score.beatsPerBar);
/** 박 크기(도) → 셈여림 0~1. 4° 이하 = 아주 여리게, 40° 이상 = 아주 세게 */
const levelOf = (sizeDeg: number) => Math.max(0, Math.min(1, (sizeDeg - 4) / 36));
const DYN_LABELS: [number, string][] = [[0.2, 'pp'], [0.4, 'p'], [0.55, 'mp'], [0.7, 'mf'], [0.85, 'f'], [Infinity, 'ff']];
/** 겨눈 방향이 이 각도를 넘으면 그쪽 묶음 강조 */
const AIM_DEG = 15;
/** 판정 (ms): 이 안이면 "정확", 그다음 "좋아요", 넘으면 빨라요/늦어요 */
const JUDGE_PERFECT_MS = 70;
const JUDGE_GOOD_MS = 150;

const statusEl = $('status');
const connectBtn = $<HTMLButtonElement>('connect');
const recenterBtn = $<HTMLButtonElement>('recenter');
const messageEl = $('message');
const judgeEl = $('judge');
const canvas = $<HTMLCanvasElement>('hall');
const ctx2d = canvas.getContext('2d')!;
const scoreCanvas = $<HTMLCanvasElement>('score');
const scoreCtx = scoreCanvas.getContext('2d')!;
const bpmInput = $<HTMLInputElement>('p-bpm');
const musicInput = $<HTMLInputElement>('p-music');
const guideInput = $<HTMLInputElement>('p-guide');

let mode: Mode = 'practice';
let follower = new TempoFollower(score.lengthBeats, score.bpm);
let fixed = new FixedTempo(score.lengthBeats, Number(bpmInput.value));
const clock = (): Clock => (mode === 'practice' ? fixed : follower);

let loaded = false;
let level = 0.5;
let aim = { h: 0, e: 0 };
let aimAt = -Infinity;
const trail: { x: number; y: number; t: number }[] = [];
let pulseAt = -Infinity;
let minOffset = Infinity; // 보드 시각 → 페이지 시각 (가장 작은 지연 = 실제 지연에 가장 가까움)
let warnedDrum = false;
let judgeAt = -Infinity;
let beatCount = 0;

/** 연습 기록 */
interface PracticeStats {
  judged: Set<number>;
  errs: number[];
  good: number;
  dirChecks: number;
  dirOk: number;
  last: { k: number; h: number } | null;
}
const newStats = (): PracticeStats => ({ judged: new Set(), errs: [], good: 0, dirChecks: 0, dirOk: 0, last: null });
let stats = newStats();

const sensorAiming = () => performance.now() - aimAt < 800;

// ---------------------------------------------------------------------------
// 박 처리
// ---------------------------------------------------------------------------
/** perfT: performance.now() 기준 박 시각, sizeDeg: 박 크기 */
function ictus(perfT: number, sizeDeg: number): void {
  if (!loaded) return;
  void player.resume();
  const t = player.ctx.currentTime - (performance.now() - perfT) / 1000;
  level += 0.6 * (levelOf(sizeDeg) - level);
  player.setDynamics(level);
  player.setBalance(aim.h > AIM_DEG ? 1 : aim.h < -AIM_DEG ? -1 : 0);
  pulseAt = performance.now();
  beatCount++;
  $('beats').textContent = String(beatCount);

  if (mode === 'live') {
    const wasWaiting = follower.state === 'waiting';
    follower.onIctus(t);
    if (wasWaiting && follower.state === 'playing') player.start(follower);
    renderMessage();
    return;
  }
  if (fixed.state === 'playing') judge(t);
  else showJudge(`박! (${beatCount})`, '#93c5fd'); // 시작 전에도 박이 잡히는지 보이게
}

/** 연습 모드: 가장 가까운 박과 비교해 빠름/늦음 · 방향을 알려 준다 */
function judge(t: number): void {
  const b = fixed.beatAt(t);
  const k = Math.round(b);
  if (k < -countIn() || k >= score.lengthBeats) return;
  const errMs = (b - k) * fixed.spb * 1000;
  if (stats.judged.has(k)) return showJudge('한 박에 한 번만!', '#fbbf24');
  stats.judged.add(k);

  let text: string;
  let color: string;
  if (Math.abs(errMs) <= JUDGE_PERFECT_MS) [text, color] = ['정확!', '#4ade80'];
  else if (Math.abs(errMs) <= JUDGE_GOOD_MS) [text, color] = ['좋아요', '#86efac'];
  else [text, color] = [errMs < 0 ? `빨라요 ${Math.round(-errMs)}ms` : `늦어요 ${Math.round(errMs)}ms`, '#fb923c'];

  // 방향: 센서가 있을 때만. 4박: 2박은 1박보다 왼쪽(+), 3박은 오른쪽(-) / 3박: 2박은 오른쪽(-)
  const inBar = beatInBar(score, k);
  const want = DIRECTION[score.beatsPerBar]?.[inBar];
  if (want && sensorAiming() && stats.last && stats.last.k === k - 1) {
    const dh = aim.h - stats.last.h;
    const ok = want === 'left' ? dh > 4 : dh < -4;
    if (k >= 0) {
      stats.dirChecks++;
      if (ok) stats.dirOk++;
    }
    if (!ok) [text, color] = [`${inBar + 1}박은 ${want === 'left' ? '왼쪽으로 ←' : '오른쪽으로 →'}`, '#fbbf24'];
  }
  stats.last = { k, h: aim.h };
  if (k >= 0) {
    stats.errs.push(errMs);
    if (Math.abs(errMs) <= JUDGE_GOOD_MS) stats.good++;
  }
  showJudge(text, color);
}

/** 박자별로 방향을 확인할 박: 마디 안 번호(0부터) → 직전 박보다 왼쪽/오른쪽 */
const DIRECTION: Record<number, Record<number, 'left' | 'right'>> = { 4: { 1: 'left', 2: 'right' }, 3: { 1: 'right' } };

function showJudge(text: string, color: string): void {
  judgeEl.textContent = text;
  judgeEl.style.color = color;
  judgeAt = performance.now();
}

// ---------------------------------------------------------------------------
// 센서
// ---------------------------------------------------------------------------
conn.onHit = (e: HitEvent) => {
  if (e.mode !== 1) {
    // 지휘 모드를 모르는 예전 펌웨어 — 타격이 온다
    if (!warnedDrum) {
      warnedDrum = true;
      showMessage('보드 펌웨어가 예전 버전이라 지휘 박을 보내지 않습니다', '펌웨어를 새로 올리거나 스페이스바로 지휘해 보세요');
    }
    return;
  }
  minOffset = Math.min(minOffset, e.receivedAt - e.boardMs);
  ictus(e.boardMs + minOffset, e.velocity / 2);
};

conn.onMotion = (m: MotionEvent) => {
  aim = { h: m.headingDeg, e: m.elevationDeg };
  aimAt = m.receivedAt;
  motionLog.push({ t: m.receivedAt, h: m.headingDeg, e: m.elevationDeg });
  while (motionLog.length && m.receivedAt - motionLog[0].t > 2500) motionLog.shift();
  checkAxis();
};

// 축 진단: 박은 "지휘봉 끝의 위아래 움직임"으로 잡는다. 휘두르는데 좌우로만 크게 움직이고 위아래는 거의 그대로면
// 보드가 생각하는 지휘봉 끝 방향(축)이 실제와 다른 것 → 축 맞추기를 안내한다
const motionLog: { t: number; h: number; e: number }[] = [];
let axisHintAt = -Infinity;
function checkAxis(): void {
  if (motionLog.length < 30 || performance.now() - axisHintAt < 8000) return;
  const hs = motionLog.map((p) => p.h);
  const es = motionLog.map((p) => p.e);
  const hRange = Math.max(...hs) - Math.min(...hs);
  const eRange = Math.max(...es) - Math.min(...es);
  if (hRange > 30 && eRange < 8) {
    axisHintAt = performance.now();
    showJudge('위아래가 안 잡혀요 → 축 맞추기', '#fbbf24');
    showMessage(
      '지휘봉을 위아래로 휘두르는데 좌우로만 움직인다고 읽히고 있습니다',
      '지휘봉 끝을 천장으로 세우고 가만히 든 채 <b>축 맞추기(A)</b> → 정면으로 겨누고 <b>정면 맞추기(C)</b>. 한 번 하면 보드에 저장됩니다',
    );
  }
}

const axisBtn = $<HTMLButtonElement>('axis');
function calibrateAxis(): void {
  calibrate('axis'); // 위 메뉴의 맞추기 안내 (ui/header.ts)
}
axisBtn.addEventListener('click', calibrateAxis);
conn.onAxis = (r) => {
  const [x, y, z] = r.axis.map((v) => v.toFixed(2));
  if (r.ok) {
    motionLog.length = 0;
    showJudge('축 저장됨', '#4ade80');
    showMessage(`축 저장됨 (${x}, ${y}, ${z})`, '이제 지휘봉을 정면(오케스트라 가운데)으로 겨누고 정면 맞추기(C)');
  } else showMessage('축 맞추기 실패', '지휘봉 끝을 천장으로 세우고 가만히 든 채 다시 눌러 주세요');
};

conn.onState = (s, detail) => {
  statusEl.dataset.state = s;
  statusEl.textContent = s === 'connected' ? `연결됨 · ${detail ?? ''}` : s === 'connecting' ? '연결 중…' : detail ? `연결 안 됨 · ${detail}` : '연결 안 됨';
  connectBtn.textContent = s === 'connected' ? '연결 끊기' : s === 'connecting' ? '연결 중…' : '센서 연결';
  connectBtn.disabled = s === 'connecting';
  recenterBtn.disabled = s !== 'connected';
  axisBtn.disabled = s !== 'connected';
  if (s === 'connected') {
    void conn.send(CMD.conduct);
    void conn.send(CMD.motionOn);
    minOffset = Infinity;
    warnedDrum = false;
  }
  renderMessage();
};

connectBtn.addEventListener('click', async () => {
  void player.resume();
  if (statusEl.dataset.state === 'connected') return conn.disconnect();
  try {
    await conn.connect();
  } catch (err) {
    console.warn('BLE 연결 실패', err);
  }
});
$('phone').addEventListener('click', () => {
  const started = conn.isPhone ? (conn.disconnect(), Promise.resolve()) : conn.connectPhone();
  void player.resume();
  started.catch((err) => console.warn('폰 센서 시작 실패', err));
});
const recenter = () => calibrate('center');
recenterBtn.addEventListener('click', recenter);
attachStick(conn, { kind: 'baton', zones: false });

// ---------------------------------------------------------------------------
// 모드 · 시작 · 다시
// ---------------------------------------------------------------------------
function reset(): void {
  player.stop();
  player.rewind(mode === 'practice' ? countIn() : 0);
  follower = new TempoFollower(score.lengthBeats, score.bpm);
  fixed = new FixedTempo(score.lengthBeats, Number(bpmInput.value));
  stats = newStats();
  player.metronome = mode === 'practice';
  player.music = mode === 'live' || musicInput.checked;
  renderMessage();
}

function setMode(m: Mode): void {
  mode = m;
  $('mode-practice').setAttribute('aria-pressed', String(m === 'practice'));
  $('mode-live').setAttribute('aria-pressed', String(m === 'live'));
  $('practice').hidden = m !== 'practice';
  reset();
}
$('mode-practice').addEventListener('click', () => setMode('practice'));
$('mode-live').addEventListener('click', () => setMode('live'));

function startPractice(): void {
  if (!loaded || mode !== 'practice') return;
  void player.resume();
  reset();
  fixed.start(player.ctx.currentTime, countIn());
  player.start(fixed);
  renderMessage();
}
$('p-start').addEventListener('click', startPractice);
bpmInput.addEventListener('input', () => {
  $('p-bpm-v').textContent = bpmInput.value;
  if (fixed.state !== 'playing') fixed = new FixedTempo(score.lengthBeats, Number(bpmInput.value));
});
musicInput.addEventListener('change', () => (player.music = mode === 'live' || musicInput.checked));

$('restart').addEventListener('click', reset);

// 키보드 · 화면: 센서 없이도 지휘해 볼 수 있게
window.addEventListener('keydown', (ev) => {
  if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target instanceof HTMLInputElement && ev.code !== 'Space') return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    ictus(ev.timeStamp, ev.shiftKey ? 40 : 18);
  } else if (ev.key === 'Enter') startPractice();
  else if (ev.key === 'r' || ev.key === 'R') reset();
  else if (ev.key === 'c' || ev.key === 'C') recenter();
  else if (ev.key === 'a' || ev.key === 'A') calibrateAxis();
});
canvas.addEventListener('pointerdown', (ev) => ictus(ev.timeStamp, 18));
canvas.addEventListener('pointermove', (ev) => {
  if (sensorAiming()) return; // 센서 방향이 오고 있으면 그쪽 우선
  const r = canvas.getBoundingClientRect();
  aim = { h: ((r.width / 2 - (ev.clientX - r.left)) / r.width) * 90, e: ((r.height / 2 - (ev.clientY - r.top)) / r.height) * 60 };
});

// ---------------------------------------------------------------------------
// 안내 문구
// ---------------------------------------------------------------------------
function showMessage(main: string, sub = ''): void {
  messageEl.innerHTML = `${main}${sub ? `<small>${sub}</small>` : ''}`;
  messageEl.hidden = false;
}

const PATTERN_TEXT: Record<number, string> = {
  2: '1 아래 ↓ · 2 위로 ↗',
  3: '1 아래 ↓ · 2 오른쪽 → · 3 위 ↑',
  4: '1 아래 ↓ · 2 왼쪽 ← · 3 오른쪽 → · 4 위 ↑',
};
const lesson = () => `<div class="lesson"><b>지휘가 처음이라면</b> — 「${score.title}」: <b>${score.beatsPerBar}박</b> 지휘${score.beatUnit === 2 ? ' (2분음표가 한 박)' : ''}${score.anacrusis ? ' · 못갖춘마디로 시작' : ''}
  <ol>
    <li><b>센서는 처음 한 번:</b> 지휘봉 끝을 천장으로 세우고 <b>① 축 맞추기</b> → 정면으로 겨누고 <b>② 정면 맞추기</b>. 내려쳐서 위 <b>박</b> 숫자가 올라가면 준비 끝</li>
    <li><b>박 = 공 튀기기.</b> 손목을 툭 내렸다가 튀어 오르게 — 바닥을 찍는 순간이 박입니다</li>
    <li><b>${score.beatsPerBar}박 도형:</b> ${PATTERN_TEXT[score.beatsPerBar] ?? ''} — 노란 공을 따라 하세요</li>
    <li>"딸깍" ${countIn()}번(준비 박) 다음부터 음악이 나옵니다. 딸깍 · 공이 바닥에 닿을 때 같이 찍으세요</li>
    <li><b>크게</b> 휘두르면 세게, <b>작게</b>는 여리게. 아래 악보의 노란 음이 지금 연주되는 음입니다</li>
    <li>익숙해지면 <b>실전 지휘</b>: 오케스트라가 내 템포를 따라옵니다</li>
  </ol></div>`;

function renderMessage(): void {
  if (!loaded) return;
  const connected = statusEl.dataset.state === 'connected';
  const how = connected ? '지휘봉으로' : '센서 없이도 스페이스바 / 화면 탭 = 박 (마우스 = 겨누기)';
  if (mode === 'practice') {
    if (fixed.state === 'waiting') return showMessage(lesson(), `▶ 연습 시작(Enter)을 누르세요 · ${how}`);
    if (fixed.state === 'playing') {
      messageEl.hidden = true;
      return;
    }
    const total = score.lengthBeats;
    const avgAbs = stats.errs.length ? stats.errs.reduce((a, b) => a + Math.abs(b), 0) / stats.errs.length : 0;
    const mean = stats.errs.length ? stats.errs.reduce((a, b) => a + b, 0) / stats.errs.length : 0;
    const tendency = Math.abs(mean) < 30 ? '박에 잘 맞춤' : mean < 0 ? `평균 ${Math.round(-mean)}ms 빠름` : `평균 ${Math.round(mean)}ms 늦음`;
    const dir = stats.dirChecks ? ` · 방향 ${Math.round((stats.dirOk / stats.dirChecks) * 100)}%` : '';
    const pct = Math.round((stats.good / total) * 100);
    const next = pct >= 70 ? '잘했어요! 템포를 올리거나 실전 지휘에 도전해 보세요' : '템포를 낮추거나 "음악 같이"를 끄고 메트로놈만으로 연습해 보세요';
    return showMessage(`박 맞춤 ${pct}% (${stats.good} / ${total}박) · 평균 오차 ${Math.round(avgAbs)}ms · ${tendency}${dir}`, `${next} · Enter로 다시`);
  }
  switch (follower.state) {
    case 'waiting':
      return showMessage(
        follower.prepCount === 0 ? '준비 박 두 번 → 세 번째 박에 연주가 시작됩니다' : '한 번 더! (두 박 간격이 템포가 됩니다)',
        `${how} · 크게 휘두르면 세게, 왼쪽을 겨누면 현악 · 오른쪽은 호른 · 팀파니가 커집니다`,
      );
    case 'playing':
      messageEl.hidden = true;
      return;
    case 'holding':
      return showMessage('오케스트라가 기다리는 중', '다시 박을 주면 이어서 연주합니다');
    case 'done': {
      const bpms = follower.log.slice(1).map((l) => l.bpm);
      const avg = bpms.reduce((a, b) => a + b, 0) / Math.max(1, bpms.length);
      const sd = Math.sqrt(bpms.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, bpms.length));
      return showMessage(`끝! 평균 템포 ${avg.toFixed(0)} BPM · 템포 흔들림 ±${sd.toFixed(1)}`, `박 수 ${follower.log.length} · R 또는 "처음부터"로 다시`);
    }
  }
}

// ---------------------------------------------------------------------------
// 무대 그리기
// ---------------------------------------------------------------------------
interface Section {
  part: string;
  label: string;
  strings: boolean;
  /** 무대 위치 (0~1, 가로 · 세로) */
  x: number;
  y: number;
  r: number;
  hue: number;
}
// 관객석에서 본 무대: 왼쪽 현악, 오른쪽 관악 · 타악 · 피아노 (겨눈 방향 → 파트 강조와 같은 쪽)
const SEATS = {
  strings: [{ x: 0.24, y: 0.7 }, { x: 0.3, y: 0.42 }, { x: 0.44, y: 0.24 }, { x: 0.13, y: 0.46 }],
  winds: [{ x: 0.76, y: 0.7 }, { x: 0.7, y: 0.42 }, { x: 0.56, y: 0.24 }, { x: 0.87, y: 0.46 }],
};
const HUE: Record<string, number> = { violin: 28, cello: 16, string_ensemble_1: 38, contrabass: 8, french_horn: 48, timpani: 0, oboe: 160, acoustic_grand_piano: 210 };
function seatsFor(sc: Score): Section[] {
  const used = { strings: 0, winds: 0 };
  return sc.parts.map((p) => {
    const seat = SEATS[p.group][used[p.group]++ % 4];
    return { part: p.id, label: p.name, strings: p.group === 'strings', ...seat, r: 0.085, hue: HUE[p.instrument] ?? 200 };
  });
}
let sections = seatsFor(score);

// 지휘 도형 (지휘자 시점 = 화면 그대로). 단위 좌표: x 오른쪽 +, y 아래 +
//   박 점 P[i]와, i → i+1로 갈 때 튀어 오르는 곡선의 조절점 C[i]
type Pt = { x: number; y: number };
const PATTERNS: Record<number, { P: Pt[]; C: Pt[]; arrows: string[] }> = {
  2: {
    P: [{ x: 0, y: 0.55 }, { x: 0.45, y: 0.25 }],
    C: [{ x: 0.3, y: -0.25 }, { x: 0.1, y: -0.8 }],
    arrows: ['1 ↓', '2 ↗'],
  },
  3: {
    P: [{ x: 0, y: 0.55 }, { x: 0.72, y: 0.32 }, { x: 0.1, y: -0.15 }],
    C: [{ x: 0.2, y: -0.15 }, { x: 0.75, y: -0.35 }, { x: 0.02, y: -0.75 }],
    arrows: ['1 ↓', '2 →', '3 ↑'],
  },
  4: {
    P: [{ x: 0, y: 0.55 }, { x: -0.72, y: 0.32 }, { x: 0.72, y: 0.32 }, { x: 0.08, y: -0.2 }],
    C: [{ x: -0.15, y: -0.25 }, { x: -0.25, y: -0.1 }, { x: 0.75, y: -0.35 }, { x: 0.02, y: -0.75 }],
    arrows: ['1 ↓', '2 ←', '3 →', '4 ↑'],
  },
};

function bezier(a: { x: number; y: number }, c: { x: number; y: number }, b: { x: number; y: number }, u: number) {
  const v = 1 - u;
  return { x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, y: v * v * a.y + 2 * v * u * c.y + u * u * b.y };
}

function drawGuide(w: number, h: number, beat: number): void {
  const s = Math.min(w * 0.3, h * 0.42);
  const cx = w / 2;
  const cy = h * 0.42;
  const X = (p: { x: number }) => cx + p.x * s;
  const Y = (p: { y: number }) => cy + p.y * s;
  const { P, C, arrows } = PATTERNS[score.beatsPerBar] ?? PATTERNS[4];
  const n = P.length;

  // 도형 전체 (흐린 점선)
  ctx2d.setLineDash([6, 6]);
  ctx2d.strokeStyle = 'rgba(147, 197, 253, 0.35)';
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    ctx2d.moveTo(X(a), Y(a));
    ctx2d.quadraticCurveTo(X(C[i]), Y(C[i]), X(b), Y(b));
  }
  ctx2d.stroke();
  ctx2d.setLineDash([]);

  const playing = Number.isFinite(beat);
  const bi = playing ? Math.floor(beat) : 0;
  const j = beatInBar(score, bi);
  const f = playing ? beat - bi : 0;
  const next = (j + 1) % n;
  // 박 점: 다음에 찍을 곳은 크게 깜빡
  for (let i = 0; i < n; i++) {
    const isNext = playing && i === next;
    const r = isNext ? 16 + 4 * Math.sin(f * Math.PI) : 13;
    ctx2d.fillStyle = isNext ? 'rgba(250, 204, 21, 0.9)' : 'rgba(42, 47, 58, 0.9)';
    ctx2d.beginPath();
    ctx2d.arc(X(P[i]), Y(P[i]), r, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = isNext ? '#111' : '#c7ccd6';
    ctx2d.font = '700 14px system-ui, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(String(i + 1), X(P[i]), Y(P[i]) + 5);
  }
  if (!playing) return;
  // 공: 박 점에서 빠르게 튀어 올라 꼭대기에서 느려졌다가 다음 박 점으로 빠르게 떨어진다
  const u = f + 0.15 * Math.sin(2 * Math.PI * f);
  const pos = bezier(P[j], C[j], P[next], Math.max(0, Math.min(1, u)));
  ctx2d.fillStyle = '#facc15';
  ctx2d.shadowColor = '#facc15';
  ctx2d.shadowBlur = 18;
  ctx2d.beginPath();
  ctx2d.arc(X(pos), Y(pos), 11, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.shadowBlur = 0;
  ctx2d.fillStyle = '#fde68a';
  ctx2d.font = '700 18px system-ui, sans-serif';
  ctx2d.fillText(arrows[next], X(pos), Y(pos) - 20);
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  for (const [c, g] of [
    [canvas, ctx2d],
    [scoreCanvas, scoreCtx],
  ] as const) {
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
new ResizeObserver(resize).observe(canvas);
new ResizeObserver(resize).observe(scoreCanvas);

let drawState = '';
function draw(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const nowPerf = performance.now();
  const nowA = player.ctx.currentTime;
  const ck = clock();
  const beat = ck.beatAt(nowA);
  const guide = mode === 'practice' && guideInput.checked;
  ctx2d.clearRect(0, 0, w, h);

  // 무대 바닥 (반원)
  const cx = w / 2;
  const base = h * 0.98;
  const R = Math.min(w * 0.48, h * 0.95);
  const grad = ctx2d.createRadialGradient(cx, base, R * 0.1, cx, base, R);
  grad.addColorStop(0, '#1b1f29');
  grad.addColorStop(1, '#0c0e13');
  ctx2d.fillStyle = grad;
  ctx2d.beginPath();
  ctx2d.arc(cx, base, R, Math.PI, 0);
  ctx2d.fill();

  // 파트: 소리가 날 때 밝아지고, 강조된 묶음은 크게. 연습 공이 보일 때는 흐리게
  ctx2d.globalAlpha = guide ? 0.45 : 1;
  const bias = aim.h > AIM_DEG ? 1 : aim.h < -AIM_DEG ? -1 : 0;
  for (const s of sections) {
    const last = player.lastPlayed.get(s.part) ?? -Infinity;
    const active = Math.max(0, 1 - Math.max(0, nowA - last) / 0.5);
    const boost = s.strings ? 1 + 0.25 * bias : 1 - 0.25 * bias;
    const x = s.x * w;
    const y = h * 0.08 + s.y * h * 0.85;
    const r = s.r * Math.min(w, h * 1.4) * boost;
    ctx2d.fillStyle = `hsla(${s.hue}, 80%, ${30 + active * 32}%, ${0.35 + active * 0.55})`;
    ctx2d.beginPath();
    ctx2d.ellipse(x, y, r, r * 0.62, 0, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = '#e8eaef';
    ctx2d.font = '600 14px system-ui, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(s.label, x, y + 5);
  }
  ctx2d.globalAlpha = 1;

  if (guide) drawGuide(w, h, beat);

  // 내 지휘봉 (겨눈 방향) + 꼬리
  const bx = cx - (aim.h / 90) * w * 0.9;
  const by = h * 0.5 - (aim.e / 60) * h * 0.8;
  trail.push({ x: bx, y: by, t: nowPerf });
  while (trail.length && nowPerf - trail[0].t > 600) trail.shift();
  ctx2d.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = 1 - (nowPerf - trail[i].t) / 600;
    ctx2d.strokeStyle = `rgba(147, 197, 253, ${a * 0.8})`;
    ctx2d.lineWidth = 2 + a * 4;
    ctx2d.beginPath();
    ctx2d.moveTo(trail[i - 1].x, trail[i - 1].y);
    ctx2d.lineTo(trail[i].x, trail[i].y);
    ctx2d.stroke();
  }
  const since = (nowPerf - pulseAt) / 400;
  if (since < 1) {
    ctx2d.strokeStyle = `rgba(147, 197, 253, ${1 - since})`;
    ctx2d.lineWidth = 3;
    ctx2d.beginPath();
    ctx2d.arc(bx, by, 10 + since * 50, 0, Math.PI * 2);
    ctx2d.stroke();
  }
  ctx2d.fillStyle = '#f8fafc';
  ctx2d.beginPath();
  ctx2d.arc(bx, by, 6, 0, Math.PI * 2);
  ctx2d.fill();

  // 연습 준비 박: 큰 숫자
  if (mode === 'practice' && fixed.state === 'playing' && beat < 0) {
    ctx2d.fillStyle = 'rgba(250, 204, 21, 0.9)';
    ctx2d.font = '800 64px system-ui, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(String(beatInBar(score, Math.floor(beat)) + 1), cx, h * 0.18 + 30);
    ctx2d.font = '600 16px system-ui, sans-serif';
    ctx2d.fillText('준비 박 — 딸깍에 맞춰 바닥을 찍어 보세요', cx, h * 0.18 + 56);
  }

  // 판정 글자 (0.7초 동안 흐려짐)
  judgeEl.style.opacity = String(Math.max(0, 1 - (nowPerf - judgeAt) / 700));

  // 숫자 · 악보
  const started = ck.state !== 'waiting';
  $('bpm').textContent = started ? (60 / ck.spb).toFixed(0) : mode === 'practice' ? bpmInput.value : '—';
  $('dyn').textContent = DYN_LABELS.find(([lim]) => level < lim)![1];
  $('elev').textContent = sensorAiming() ? `${aim.e >= 0 ? '+' : ''}${aim.e.toFixed(0)}°` : '—';
  const bars = barOf(score, score.lengthBeats - 0.01);
  $('bar').textContent = Number.isFinite(beat) && beat >= 0 ? `${Math.max(1, Math.min(bars, barOf(score, beat)))} / ${bars}` : `— / ${bars}`;
  $('progress').style.width = `${Number.isFinite(beat) ? Math.max(0, Math.min(1, beat / score.lengthBeats)) * 100 : 0}%`;
  scoreView.draw(scoreCtx, scoreCanvas.clientWidth, scoreCanvas.clientHeight, beat);

  const st = `${mode}:${ck.state}`;
  if (st !== drawState) {
    drawState = st;
    // 연습 설정은 연주 중에는 숨긴다 (지휘 도형을 가리지 않게)
    $('practice').hidden = mode !== 'practice' || fixed.state === 'playing';
    renderMessage();
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------
const songSelect = $<HTMLSelectElement>('song');
let loadToken = 0;

/** 곡 바꾸기: 악보 · 무대 · 템포를 새 곡으로, 필요한 악기 소리만 더 받는다 */
async function selectSong(id: string): Promise<void> {
  score = SONGS.find((s) => s.id === id) ?? SONGS[0];
  songSelect.value = score.id;
  try {
    localStorage.setItem('airband.conduct.song', score.id);
  } catch {
    // 저장 불가 — 다음 방문에는 첫 곡
  }
  player.setScore(score);
  scoreView = new ScoreView(score);
  sections = seatsFor(score);
  bpmInput.value = String(score.practiceBpm);
  $('p-bpm-v').textContent = bpmInput.value;
  $('title').textContent = score.title;
  $('composer').textContent = score.composer;
  $('about').textContent = score.about;
  loaded = false;
  reset();
  const token = ++loadToken;
  try {
    await player.load((done, total) => token === loadToken && showMessage(`악기 소리 불러오는 중… ${done} / ${total}`));
    if (token !== loadToken) return;
    loaded = true;
    renderMessage();
  } catch (err) {
    showMessage('악기 소리를 불러오지 못했습니다', err instanceof Error ? err.message : String(err));
  }
}
songSelect.replaceChildren(
  ...SONGS.map((s) => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.title} — ${s.composer.split(' · ')[0]}`;
    return o;
  }),
);
songSelect.addEventListener('change', () => void selectSong(songSelect.value));

async function start(): Promise<void> {
  const support = webBluetoothSupport();
  if (!support.ok) {
    const el = $('support');
    el.textContent = support.reason!;
    el.hidden = false;
    connectBtn.disabled = true;
  }
  resize();
  setMode('practice');
  requestAnimationFrame(draw);
  let saved = '';
  try {
    saved = localStorage.getItem('airband.conduct.song') ?? '';
  } catch {
    saved = '';
  }
  await selectSong(saved || SONGS[0].id);
}
void start();
