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

import { mountHeader, attachStick, calibrate, stickConnected } from '../ui/header';
mountHeader('rhythm');

import { AirBandConnection, CMD } from '../ble';
import { DrumAudio } from '../audio';
import { RhythmGame, WINDOW_MS, POINTS, type Judgement } from './game';
import { SONGS, POP_SONGS, buildChart, type Chart, type Song, type PopSong } from './charts';
import { zoneOfAim } from '../kit/scene';
import { createKitView } from '../kit/view';
import { fitTaps, fitKnownTaps, templateChart, LEVEL_NAMES, type BeatGrid, type Level } from './music';
import { YouTubeTrack, YT_STATE, parseVideoId } from './youtube';

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

/** 화면 맨 위 큰 판정 글자. 칠 때마다 애니메이션을 처음부터 다시 */
function showJudge(j: Judgement, delta: number): void {
  const el = $('judge-big');
  const st = JUDGE_STYLE[j];
  const combo = game?.combo ?? 0;
  $('jb-text').textContent = j === 'perfect' ? 'PERFECT!' : j === 'miss' ? 'MISS' : st.text;
  const d = Math.round(delta);
  $('jb-sub').textContent = j === 'miss' || Math.abs(d) <= WINDOW_MS.perfect ? '' : d < 0 ? `빠름 ${-d}ms` : `늦음 ${d}ms`;
  $('jb-combo').innerHTML = combo >= 2 ? `${combo}<small>COMBO</small>` : '';
  el.className = '';
  void el.offsetWidth; // 애니메이션 다시 시작
  el.className = `go ${j}${combo > 0 && combo % 10 === 0 ? ' milestone' : ''}`;
}

// ---------------------------------------------------------------------------
// 설정 · 최고 기록 (브라우저에 저장. 저장이 막혀 있어도 게임은 동작)
// ---------------------------------------------------------------------------
interface Settings {
  guide: boolean;
  metronome: boolean;
  speed: number;
  offsetMs: number; // 입력 보정: 양수면 "늦게 쳐도 맞게" 판정
  view: 'kit' | 'lanes';
  level: Level; // 내 노래 악보 난이도
  autoKick: boolean; // 킥은 게임이 대신 친다 (스틱 하나일 때)
}
const DEFAULT_SETTINGS: Settings = { guide: true, metronome: true, speed: 1, offsetMs: 0, view: 'kit', level: 2, autoKick: true };
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
// 유튜브 노래 (인기곡 · 링크로 추가한 곡)
// ---------------------------------------------------------------------------
// [설명] 내장 곡은 악보 문자열(charts.ts)로, 노래는 유튜브 영상 + 박자 격자에서 악보를 만든다(music.ts templateChart).
//   유튜브 소리는 읽을 수 없어서, 노래를 틀면 사용자가 박자를 8번 탭 → 박자 격자 → 그대로 게임 시작.
//   인기곡은 공식 뮤직비디오 · 대략 BPM · "짝마다 탭" 안내가 정해져 있다(charts.ts POP_SONGS). 박자는 브라우저에 저장.
interface Track {
  id: string; // 'yt:영상id'
  title: string;
  videoId: string;
  grid?: BeatGrid; // 탭으로 맞춘 박자
  taps?: number[];
  mediaMs: number; // 노래 길이 (모르면 0)
  pop?: PopSong; // 인기곡이면
}
type SavedTrack = Omit<Track, 'pop'> & { popId?: string };
/** 곡 고르기에서 고른 것: 연습곡 · 내 노래(파일 · 유튜브) · 아직 파일을 안 고른 인기곡 */
type Pick_ = { kind: 'song'; song: Song } | { kind: 'track'; track: Track } | { kind: 'pop'; pop: PopSong };
type Tab = 'practice' | 'pop' | 'mine';
let tab: Tab = 'pop';
let levelFilter: 0 | Level = 0;


const tracks: Track[] = load<{ list: SavedTrack[] }>('airband.rhythm.tracks', { list: [] }).list.map(({ popId, ...t }) => ({
  ...t,
  pop: POP_SONGS.find((p) => p.id === popId || p.videoId === t.videoId),
}));
function saveTracks(): void {
  const list: SavedTrack[] = tracks.map(({ id, title, videoId, grid, taps, mediaMs, pop }) => ({ id, title, videoId, grid, taps, mediaMs, popId: pop?.id }));
  save('airband.rhythm.tracks', { list });
}
const bestKey = (p: Pick_) => (p.kind === 'song' ? p.song.id : p.kind === 'pop' ? `pop:${p.pop.id}:${settings.level}` : p.track.pop ? `pop:${p.track.pop.id}:${settings.level}` : `${p.track.id}:${settings.level}`);
const titleOf = (p: Pick_) => (p.kind === 'song' ? p.song.title : p.kind === 'pop' ? `${p.pop.title} — ${p.pop.artist}` : p.track.title);

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
type State = 'menu' | 'play' | 'result';
let state: State = 'menu';
let song: Song = SONGS[0];
/** 곡 선택에서 고른 것 (내장 곡 또는 내 노래) */
let pick: Pick_ = { kind: 'song', song: SONGS[0] };
let chart: Chart | null = null;
let game: RhythmGame | null = null;
let songStart = 0; // 곡의 0ms가 되는 performance.now() 값

interface AudioEvent {
  time: number; // 게임 시각 ms
  kind: 'click' | 'guide' | 'auto'; // auto = 킥 자동 (소리 + 화면 킥 흔들림)
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

const audio = new DrumAudio();
const conn = new AirBandConnection();
const canvas = $<HTMLCanvasElement>('game');
const ctx2d = canvas.getContext('2d')!;
const kitCanvas = $<HTMLCanvasElement>('kit');
const scene = createKitView(kitCanvas, hueOf, (cls) => DRUM_NAMES[cls]);
scene.showNames = false;
scene.overlay = drawKitOverlay;
let clickBuffers: { normal: AudioBuffer; accent: AudioBuffer } | null = null;

// 내 노래 재생
const yt = new YouTubeTrack($('yt-player'));
let media: 'none' | 'youtube' = 'none'; // 지금 게임 · 탭 맞추기에서 쓰는 노래 시계
let mediaLastT = 0; // 유튜브가 멈췄을 때(버퍼링) 시계를 이 위치에 붙잡아 둔다
let mediaLastRead = -1;
/** 탭으로 박자 맞추는 중이면 그 곡 */
let tapping: Track | null = null;
/** 유튜브 곡: 치는 박자를 따라 남은 노트를 조금씩 옮긴다 (탭으로 맞춘 BPM이 조금 틀려도 곡 끝까지 맞게) */
let driftEma = 0;
let driftTotal = 0;
let taps: number[] = [];

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
    else if (ev.kind === 'auto') {
      audio.playAt(ev.lane, INPUT_VELOCITY, when);
      const at = songStart + ev.time;
      setTimeout(() => scene.hit(ev.lane, 90), Math.max(0, at - performance.now()));
    } else audio.playAt(ev.lane, GUIDE_VELOCITY, when);
  }
}

// ---------------------------------------------------------------------------
// 게임 진행
// ---------------------------------------------------------------------------
/** 고른 곡의 악보. 유튜브 곡인데 아직 박자를 안 맞췄으면 null */
function chartOf(p: Pick_): Chart | null {
  if (p.kind === 'pop') return null;
  if (p.kind === 'song') return buildChart(p.song);
  const t = p.track;
  if (t.grid) return templateChart(t.grid, settings.level, t.mediaMs || t.grid.firstBeatMs + 180000);
  return null;
}

function startSong(): void {
  void audio.resume();
  stopTapping();
  if (pick.kind === 'pop') {
    selectPick({ kind: 'track', track: popTrack(pick.pop) });
  }
  if (pick.kind === 'track' && !pick.track.grid) {
    // 처음 치는 노래: 영상을 틀고 박자를 몇 번 탭 → 그대로 게임 시작
    void startTapping(pick.track);
    return;
  }
  startGame();
}

/** 게임 시작. continueMs가 있으면 유튜브를 멈추지 않고 그 시각부터 (인기곡 탭 직후) */
function startGame(continueMs?: number): void {
  let c = chartOf(pick);
  if (!c || pick.kind === 'pop') {
    $('track-msg').textContent = '먼저 "박자 맞추기"로 이 노래의 박자를 알려 주세요';
    return;
  }
  if (pick.kind === 'track' && (!yt.loaded || yt.videoId !== pick.track.videoId)) {
    $('track-msg').textContent = '영상이 아직 준비되지 않았습니다 — 잠시 뒤 다시';
    return;
  }
  if (continueMs === undefined) stopMedia();
  chart = c;
  driftEma = 0;
  driftTotal = 0;
  if (continueMs !== undefined) {
    // 이미 지나간 노트는 빼고, 한 박 반 뒤부터
    const from = continueMs + c.beatMs * 1.5;
    chart = c = { ...c, notes: c.notes.filter((n) => n.time >= from) };
  }
  // 킥 자동: 킥 노트는 판정에서 빼고, 연습곡이면 그 자리에 킥 소리를 대신 낸다 (내 노래는 음악에 킥이 이미 있음)
  const kicks = settings.autoKick ? chart.notes.filter((n) => n.lane === KICK) : [];
  game = new RhythmGame(settings.autoKick ? chart.notes.filter((n) => n.lane !== KICK) : chart.notes);
  popups.length = 0;
  events = [];

  if (pick.kind === 'track') {
    // 내 노래: 노래 자체가 박자를 알려 주므로 카운트인 · 메트로놈 · 가이드 소리 없이 노래만
    media = 'youtube';
    if (continueMs === undefined) {
      songStart = performance.now();
      mediaLastT = 0;
      yt.play(0);
    }
    setState('play');
    $('hud-title').textContent = titleOf(pick);
    return;
  }

  song = pick.song;
  // 소리 이벤트 목록: 카운트인(항상) + 메트로놈 + 가이드
  for (let i = 0; i < LEAD_IN_BEATS; i++) {
    events.push({ time: -(LEAD_IN_BEATS - i) * chart.beatMs, kind: 'click', lane: 0, accent: i === 0 });
  }
  if (settings.metronome) {
    chart.beats.forEach((b, i) => events.push({ time: b, kind: 'click', lane: 0, accent: i % 4 === 0 }));
  }
  if (settings.guide) {
    for (const n of game.notes) events.push({ time: n.time, kind: 'guide', lane: n.lane, accent: false });
  }
  for (const n of kicks) events.push({ time: n.time, kind: 'auto', lane: KICK, accent: false });
  events.sort((a, b) => a.time - b.time);
  nextEvent = 0;

  // 0.5초 여유 + 카운트인 뒤에 곡 시작
  songStart = performance.now() + 500 + LEAD_IN_BEATS * chart.beatMs;
  setState('play');
  $('hud-title').textContent = song.title;
}

function finishSong(): void {
  if (!game) return;
  stopMedia();
  const key = bestKey(pick);
  const prev = best[key];
  if (!prev || game.score > prev.score) {
    best[key] = { score: game.score, rank: game.rank };
    save('airband.rhythm.best', best);
  }
  showResult();
  setState('result');
}

function stopMedia(): void {
  if (media === 'youtube') yt.pause();
  media = 'none';
}

/**
 * 유튜브 시계: 영상 재생 위치로 songStart(곡 0ms의 performance 시각)를 맞춘다. 매 프레임.
 * [설명] getCurrentTime()은 값이 띄엄띄엄 바뀔 수 있어서, 값이 바뀐 순간에만 읽고 조금씩(15%) 따라간다.
 *   200ms 넘게 어긋나면(넘기기 · 버퍼링 뒤) 한 번에 맞춘다. 멈춰 있으면 시계도 그 자리에 붙잡는다.
 */
function syncMediaClock(now: number): void {
  if (media !== 'youtube') return;
  if (yt.playing) {
    const tm = yt.timeMs;
    if (tm !== mediaLastRead) {
      mediaLastRead = tm;
      const d = now - tm - songStart;
      songStart = Math.abs(d) > 200 ? now - tm : songStart + d * 0.15;
    }
    mediaLastT = now - songStart;
  } else {
    songStart = now - mediaLastT;
  }
}

function quitToMenu(): void {
  stopMedia();
  game = null;
  chart = null;
  events = [];
  renderSongs();
  setState('menu');
}

function setState(s: State): void {
  state = s;
  document.body.classList.toggle('playing', s === 'play');
  $('dock').hidden = s !== 'menu';
  if (s !== 'menu') $('settings').hidden = true;
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
  if (tapping) {
    addTap(perfTime);
    return;
  }
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
    showJudge(r.judgement, r.delta);
    if (media === 'youtube') followDrift(r.delta);
    return;
  }
  // 타이밍은 맞는데 다른 드럼을 쳤다 → 쳐야 했던 줄에 방향 힌트
  const want = game.pendingNear(t);
  if (want && want.lane !== cls) hints.push({ lane: want.lane, text: directionHint(cls, want.lane), at: now });
}

/**
 * 유튜브 곡 박자 따라가기: 탭으로 맞춘 BPM이 0.2%만 틀려도 3분 뒤엔 0.4초 어긋난다.
 * 사람은 노래를 듣고 치므로, 친 시각이 계속 한쪽으로 밀리면 노래 쪽 박자가 밀린 것 → 남은 노트를 절반씩 옮긴다.
 * 한 번에 많이 옮기지 않고(±40ms), 전체로도 ±600ms까지만.
 */
function followDrift(delta: number): void {
  if (!game || !chart) return;
  driftEma = driftEma * 0.7 + delta * 0.3;
  if (Math.abs(driftEma) < 18) return;
  const shift = Math.max(-40, Math.min(40, driftEma * 0.5));
  if (Math.abs(driftTotal + shift) > 600) return;
  driftTotal += shift;
  driftEma -= shift;
  for (const n of game.notes) if (!n.judgement) n.time += shift;
  const now = performance.now() - songStart;
  chart.beats = chart.beats.map((b) => (b > now ? b + shift : b));
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
  onInput(e.cls, e.boardMs + minOffset, e.velocity);
};
conn.onMotion = (m) => {
  aimCls = m.zone;
  aimAt = m.receivedAt;
  scene.setAim({ h: m.headingDeg, e: m.elevationDeg }, m.zone);
};

window.addEventListener('keydown', (ev) => {
  if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target instanceof HTMLInputElement && ev.target.type !== 'range') return; // 링크 입력 중
  if (tapping && ev.key === 'Escape') {
    ev.preventDefault();
    stopTapping();
    return;
  }
  const cls = KEY_TO_DRUM[ev.key.toLowerCase()];
  if (cls !== undefined) {
    ev.preventDefault();
    onInput(cls, ev.timeStamp);
    return;
  }
  if (ev.key === 'c' || ev.key === 'C') return calibrate('center');
  if (ev.key === 'a' || ev.key === 'A') return calibrate('axis');
  if (ev.key === 'Escape' && state === 'play') quitToMenu();
  if (ev.key === 'Enter' && state !== 'play' && !(ev.target instanceof HTMLButtonElement)) {
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
  if (document.hidden) stopTapping();
});

// ---------------------------------------------------------------------------
// 그리기
// ---------------------------------------------------------------------------
let W = 0;
let H = 0;
const dark = { matches: true }; // 리듬 게임은 항상 어두운 화면

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
    // 큰 글자는 화면 맨 위(showJudge). 드럼 위에는 어느 드럼이었는지만 작게
    c.font = '800 15px system-ui, sans-serif';
    c.fillText(st.text, x, y - age * 30);
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
  if (chart && chart.beats.length) {
    const firstBeat = -LEAD_IN_BEATS;
    const lastBeat = chart.beats.length;
    for (let b = firstBeat; b <= lastBeat; b++) {
      const y = yOf(b >= 0 && b < lastBeat ? chart.beats[b] : chart.beats[0] + b * chart.beatMs);
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

}

// ---------------------------------------------------------------------------
// 매 프레임
// ---------------------------------------------------------------------------
function frame(now: number): void {
  syncMediaClock(now);
  if (tapping) renderTapping();
  if (state === 'play' && game && chart) {
    const t = now - songStart;
    scheduleAudio(t);

    for (const n of game.update(t - settings.offsetMs)) {
      popups.push({ lane: n.lane, judgement: 'miss', at: now, delta: 0 });
      showJudge('miss', 0);
    }

    // 카운트다운 숫자
    const countEl = $('count');
    if (t < chart.startMs) {
      const left = Math.ceil((chart.startMs - t) / chart.beatMs);
      countEl.hidden = left > LEAD_IN_BEATS;
      countEl.textContent = String(left);
    } else {
      countEl.hidden = true;
    }

    updateHud(t);
    if (game.finished && t > chart.durationMs) finishSong();
    else if (media === 'youtube' && yt.state === YT_STATE.ended) finishSong();
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
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

const LV_HUE: Record<Level, number> = { 1: 150, 2: 200, 3: 265, 4: 330 };
const samePick = (a: Pick_, b: Pick_) =>
  a.kind === b.kind && (a.kind === 'song' ? a.song === (b as { song: Song }).song : a.kind === 'pop' ? a.pop === (b as { pop: PopSong }).pop : a.track === (b as { track: Track }).track);
/** 인기곡의 유튜브 곡 (없으면 만들어서 목록에 넣는다. 박자는 브라우저에 저장) */
function popTrack(p: PopSong): Track {
  let t = tracks.find((x) => x.pop === p || x.videoId === p.videoId);
  if (!t) {
    t = { id: `yt:${p.videoId}`, title: '', videoId: p.videoId, mediaMs: 0 };
    tracks.push(t);
  }
  t.pop = p;
  t.title = `${p.title} — ${p.artist}`;
  return t;
}

/** 곡 카드: 표지(색 + 그림) · 난이도 · 최고 등급 · 제목 · 설명 */
function card(it: Pick_): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = 'card';
  el.setAttribute('aria-pressed', String(samePick(it, pick) || (it.kind === 'pop' && pick.kind === 'track' && pick.track.pop === it.pop)));
  let level: Level;
  let emoji = '🎵';
  let title: string;
  let sub: string;
  let desc = '';
  let need = '';
  let saved: Track | undefined;
  if (it.kind === 'song') {
    level = it.song.level;
    emoji = it.song.emoji ?? '🥁';
    title = it.song.title;
    const c = buildChart(it.song);
    sub = `BPM ${it.song.bpm} · ${Math.round(c.durationMs / 1000)}초`;
    desc = it.song.description;
  } else if (it.kind === 'pop') {
    level = it.pop.level;
    emoji = it.pop.emoji;
    title = it.pop.title;
    sub = it.pop.artist;
    desc = it.pop.why;
    saved = tracks.find((t) => t.pop === it.pop);
    need = saved?.grid ? '▶ 바로 시작' : '▶ 유튜브';
  } else {
    const t = it.track;
    level = settings.level;
    emoji = '▶️';
    title = t.title;
    sub = `유튜브${t.grid ? ` · BPM ${(60000 / t.grid.beatMs).toFixed(0)}` : ''}${t.mediaMs ? ` · ${mmss(t.mediaMs)}` : ''}`;
    desc = t.grid ? '박자 저장됨 — 바로 시작' : '처음 한 번 박자 8번 탭';
  }
  const b = best[bestKey(it)];
  el.style.setProperty('--h', String(LV_HUE[level] + (title.length * 7) % 40));
  el.innerHTML = `
    <div class="cover">${emoji}<span class="lv">${LEVEL_NAMES[level]}</span>${b ? `<span class="rank">${b.rank}</span>` : ''}${need ? `<span class="need">${need}</span>` : ''}</div>
    <div class="body"><span class="t">${escapeHtml(title)}</span><span class="a">${escapeHtml(sub)}</span>${desc ? `<span class="d">${escapeHtml(desc)}</span>` : ''}</div>`;
  if (it.kind === 'track') {
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '목록에서 지우기';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      tracks.splice(tracks.indexOf(it.track), 1);
      saveTracks();
      if (samePick(it, pick)) selectPick({ kind: 'song', song: SONGS[0] });
      renderSongs();
    });
    el.append(del);
  }
  el.addEventListener('click', () => selectPick(it.kind === 'pop' ? { kind: 'track', track: popTrack(it.pop) } : it));
  el.addEventListener('dblclick', startSong);
  return el;
}

function renderSongs(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const filters = $('filters');
  filters.replaceChildren();
  for (const lv of [0, 1, 2, 3, 4] as (0 | Level)[]) {
    if (tab === 'mine') break;
    const f = document.createElement('button');
    f.textContent = lv === 0 ? '전체' : LEVEL_NAMES[lv];
    f.setAttribute('aria-pressed', String(levelFilter === lv));
    f.addEventListener('click', () => {
      levelFilter = lv;
      renderSongs();
    });
    filters.append(f);
  }
  const list = $('songs');
  list.replaceChildren();
  const items: Pick_[] =
    tab === 'practice'
      ? SONGS.filter((s) => !levelFilter || s.level === levelFilter).map((s) => ({ kind: 'song' as const, song: s }))
      : tab === 'pop'
        ? POP_SONGS.filter((p) => !levelFilter || p.level === levelFilter).map((p) => ({ kind: 'pop' as const, pop: p }))
        : tracks.filter((t) => !t.pop).map((t) => ({ kind: 'track' as const, track: t }));
  for (const it of items) list.append(card(it));
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = tab === 'mine' ? '아직 없어요 — 위 칸에 유튜브 링크를 붙여 넣으면 여기에 생깁니다' : '이 난이도의 곡이 없어요';
    list.append(e);
  }
  $('mytrack').hidden = tab !== 'mine';
  renderDock();
}

/** 아래 막대: 고른 곡 · 난이도(유튜브 곡만) · 시작 */
function renderDock(): void {
  $('sel-title').textContent = titleOf(pick);
  const c = chartOf(pick);
  const notes = c ? c.notes.filter((n) => !settings.autoKick || n.lane !== KICK).length : 0;
  const t = pick.kind === 'track' ? pick.track : null;
  $('sel-info').textContent =
    t && !t.grid
      ? `처음 한 번: 노래가 나오면 ${tapHintOf(t)} ${TAPS_NEEDED}번 탭 → 바로 게임`
      : c
        ? `${pick.kind === 'song' ? LEVEL_NAMES[pick.song.level] : LEVEL_NAMES[settings.level]} · 노트 ${notes}개${settings.autoKick ? ' · 킥 자동' : ''}`
        : '';
  $('opt-level').hidden = pick.kind === 'song';
  $('start').textContent = t && !t.grid ? '▶ 노래 틀기' : '▶ 시작';
  $('yt-sync').hidden = !t;
  $('yt-resync').hidden = !t?.grid || !!tapping;
}

function selectPick(p: Pick_): void {
  if (p.kind === 'pop') p = { kind: 'track', track: popTrack(p.pop) };
  if (p.kind === 'track' && p.track.pop && !(pick.kind === 'track' && pick.track === p.track)) {
    // 인기곡을 새로 고르면 추천 난이도로
    settings.level = p.track.pop.level;
    save('airband.rhythm.settings', settings);
    renderLevelSeg();
  }
  if (tapping && !(p.kind === 'track' && p.track === tapping)) stopTapping();
  pick = p;
  if (p.kind === 'song') song = p.song;
  const t = p.kind === 'track' ? p.track : null;
  $('yt-box').hidden = !t;
  if (t && yt.videoId !== t.videoId) {
    void yt.load(t.videoId).then(
      () => {
        if (yt.title && !t.pop && t.title !== yt.title) {
          t.title = yt.title;
          saveTracks();
          if (pick.kind === 'track' && pick.track === t) selectPick(pick);
          else renderSongs();
        }
      },
      (err) => ($('track-msg').textContent = `⚠ ${err instanceof Error ? err.message : err}`),
    );
  }
  $('track-msg').textContent = t
    ? t.grid
      ? `🎬 ${t.title} — 박자 저장됨 (BPM ${(60000 / t.grid.beatMs).toFixed(1)}). ▶ 시작을 누르세요`
      : `🎬 ${t.title} — ▶ 노래 틀기를 누르고, 노래에서 ${tapHintOf(t)} 스페이스(또는 스틱)를 ${TAPS_NEEDED}번 치면 바로 시작합니다`
    : '';
  renderSongs();
}

// ---------------------------------------------------------------------------
// 유튜브 노래: 링크 추가 · 박자 탭 → 바로 게임
// ---------------------------------------------------------------------------
// [설명] 흐름: ▶ 노래 틀기 → 영상 재생 → 박마다(인기곡은 "짝"마다) 탭 8번 → 박자 격자 → 영상을 멈추지 않고 지금 위치부터 게임.
//   박자는 브라우저에 저장되어 다음부터는 ▶ 시작으로 처음부터 바로 친다. 곡 중간에 박자가 조금 밀려도 followDrift가 따라간다.
const TAPS_NEEDED = 8;
const tapHintOf = (t: Track) => t.pop?.tapHint ?? '박(쿵 · 짝)마다';

yt.onError = (msg) => {
  $('track-msg').textContent = `⚠ ${msg}`;
  stopTapping();
};

async function addYouTube(): Promise<void> {
  const input = $<HTMLInputElement>('yt-url');
  const id = parseVideoId(input.value);
  if (!id) {
    if (input.value.trim()) $('track-msg').textContent = '유튜브 링크를 알아볼 수 없습니다 (예: https://www.youtube.com/watch?v=… 또는 https://youtu.be/…)';
    return;
  }
  input.value = '';
  const pop = POP_SONGS.find((p) => p.videoId === id);
  let t = pop ? popTrack(pop) : tracks.find((x) => x.videoId === id);
  if (!t) {
    t = { id: `yt:${id}`, title: '유튜브 영상 불러오는 중…', videoId: id, mediaMs: 0 };
    tracks.push(t);
    saveTracks();
  }
  selectPick({ kind: 'track', track: t });
}

/** 영상을 처음부터 틀고 탭을 받기 시작 (영상이 아직 안 불러졌으면 기다렸다가) */
async function startTapping(t: Track): Promise<void> {
  if (!yt.loaded || yt.videoId !== t.videoId) {
    $('track-msg').textContent = '영상 불러오는 중…';
    try {
      await yt.load(t.videoId);
    } catch (err) {
      $('track-msg').textContent = `⚠ ${err instanceof Error ? err.message : err}`;
      return;
    }
  }
  void audio.resume();
  stopMedia();
  tapping = t;
  taps = [];
  media = 'youtube';
  songStart = performance.now();
  mediaLastT = 0;
  yt.play(0);
  renderTapping();
  renderDock();
}

function fitOf(t: Track, xs: number[]) {
  return t.pop ? fitKnownTaps(xs, t.pop.bpm, t.pop.tapEvery) : fitTaps(xs);
}

function addTap(perfTime: number): void {
  const t = tapping;
  if (!t || !yt.playing) return;
  taps.push(perfTime - songStart);
  scene.hit(0, 90);
  audio.play(0, 60);
  const pad = $('yt-tap');
  pad.classList.remove('flash');
  void pad.offsetWidth; // 애니메이션 다시 시작
  pad.classList.add('flash');
  if (taps.length >= TAPS_NEEDED && fitOf(t, taps)) return finishTapping();
  if (taps.length >= TAPS_NEEDED + 8) {
    // 계속 못 맞추면 처음부터
    taps = [];
    $('track-msg').textContent = '⚠ 간격이 들쭉날쭉해요 — 같은 간격으로 다시 8번';
    return;
  }
  renderTapping();
}

function renderTapping(): void {
  const t = tapping;
  document.body.classList.toggle('tapping', !!t);
  $('tap-overlay').hidden = !t;
  if (!t) return;
  const left = TAPS_NEEDED - taps.length;
  $('tap-title').textContent = taps.length === 0 ? '노래에 맞춰 탭!' : left > 0 ? `${left}번 더` : '같은 간격으로 계속';
  $('tap-hint').textContent = `${tapHintOf(t)} 스페이스 · 스틱 · 아래 버튼 — ${TAPS_NEEDED}번 치면 바로 게임 시작`;
  $('tap-dots').innerHTML = Array.from({ length: TAPS_NEEDED }, (_, i) => `<i class="${i < taps.length ? 'on' : ''}"></i>`).join('');
  $('track-msg').textContent =
    taps.length === 0
      ? `🎵 노래가 나오면 ${tapHintOf(t)} 스페이스 · 스틱 · 👏 버튼 — ${TAPS_NEEDED}번 치면 바로 게임 시작`
      : left > 0
        ? `👏 ${taps.length}번 — ${left}번 더`
        : '박자를 아직 못 잡았어요 — 같은 간격으로 계속';
}

/** 탭으로 박자를 정하고, 영상을 멈추지 않고 지금 위치부터 게임 */
function finishTapping(): void {
  const t = tapping;
  if (!t) return;
  const fit = fitOf(t, taps);
  if (!fit) return;
  t.grid = fit.grid;
  t.taps = taps.map((x) => Math.round(x));
  if (yt.durationMs > 0) t.mediaMs = yt.durationMs;
  saveTracks();
  tapping = null;
  renderTapping();
  startGame(performance.now() - songStart);
}

function stopTapping(): void {
  if (!tapping) return;
  tapping = null;
  stopMedia();
  renderTapping();
  renderDock();
}

function setupTracks(): void {
  const url = $<HTMLInputElement>('yt-url');
  $('yt-load').addEventListener('click', () => void addYouTube());
  url.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void addYouTube();
  });
  // 붙여 넣으면 바로 추가
  url.addEventListener('paste', () => setTimeout(() => void addYouTube(), 0));
  $('yt-tap').addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    addTap(ev.timeStamp);
  });
  $('tap-cancel').addEventListener('click', stopTapping);
  $('yt-resync').addEventListener('click', () => {
    if (pick.kind !== 'track') return;
    pick.track.grid = undefined;
    pick.track.taps = undefined;
    saveTracks();
    startSong();
  });
  renderLevelSeg();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab as Tab;
      levelFilter = 0;
      renderSongs();
    });
  }
}

function renderLevelSeg(): void {
  segmented<Level>('opt-level', [[1, '아주 쉬움'], [2, '쉬움'], [3, '보통'], [4, '어려움']], () => settings.level, (v) => {
    settings.level = v;
    renderSongs();
  });
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
  segmented('opt-autokick', [[true, '자동'], [false, '내가 치기']], () => settings.autoKick, (v) => {
    settings.autoKick = v;
    renderDock();
  });
  segmented('opt-guide', [[true, '켜기'], [false, '끄기']], () => settings.guide, (v) => (settings.guide = v));
  segmented('opt-metro', [[true, '켜기'], [false, '끄기']], () => settings.metronome, (v) => (settings.metronome = v));
  segmented<Settings['view']>('opt-view', [['kit', '드럼 키트'], ['lanes', '줄']], () => settings.view, (v) => {
    settings.view = v;
    applyView();
  });
  segmented('opt-speed', [[0.75, '느리게'], [1, '보통'], [1.5, '빠르게']], () => settings.speed, (v) => (settings.speed = v));

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
  $('res-title').textContent = titleOf(pick);
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
conn.onState = (s) => {
  if (s === 'connected') {
    minOffset = Infinity;
    void conn.send(CMD.motionOn); // 겨눈 곳 표시용
  } else if (s === 'disconnected') aimAt = -Infinity;
  renderStickLine();
};
// 위 메뉴의 "스틱 연결"이 이 숨은 버튼들을 누른다 (ui/header.ts)
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

/** 메뉴 오른쪽 위 한 줄: 스틱 상태 · 지금 겨눈 드럼 */
function renderStickLine(): void {
  const motion = performance.now() - aimAt < AIM_STALE_MS;
  $('stick-line').innerHTML = !stickConnected()
    ? '스틱 없이도 OK — 키보드 <b>D F J K</b> · <b>스페이스</b>(킥) · 화면 터치'
    : motion
      ? `🟢 스틱 연결됨 · 지금 겨눈 곳 <b>${DRUM_NAMES[aimCls] ?? '?'}</b>`
      : '🟢 스틱 연결됨 · 방향 데이터 없음 (보드 버튼으로 칠 수 있어요)';
}
setInterval(renderStickLine, 300);

$('start').addEventListener('click', startSong);
$('res-retry').addEventListener('click', startSong);
$('res-menu').addEventListener('click', quitToMenu);
$('settings-btn').addEventListener('click', () => ($('settings').hidden = !$('settings').hidden));
document.addEventListener('pointerdown', (ev) => {
  const st = $('settings');
  if (!st.hidden && !st.contains(ev.target as Node) && ev.target !== $('settings-btn')) st.hidden = true;
});

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------
async function init(): Promise<void> {
  renderStickLine();
  setupTracks();
  // 처음엔 인기곡 탭 · We Will Rock You
  selectPick({ kind: 'pop', pop: POP_SONGS[0] });
  setupOptions();
  applyView();
  resize();
  requestAnimationFrame(frame);
  await audio.init();
  clickBuffers = { normal: makeClick(1000), accent: makeClick(1600) };
}

void init();
