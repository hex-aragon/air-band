// 내 노래로 치기: 노래의 박자를 찾아 리듬 게임 악보를 자동으로 만든다
//
// [한눈에 보기]
//   음악 파일   ─ analyzeAudio() ─▶ 대역별 "소리가 새로 터진 정도"(onset) ─▶ 박자 격자(BPM · 첫 박) ─▶ onsetChart()
//                                    낮은음 = 킥, 중간 = 스네어, 높은음 = 하이햇                          실제로 소리가 난 곳에만 노트
//   유튜브 영상 ─ (소리를 읽을 수 없음) ─ 사용자가 박마다 탭 ─ fitTaps() ─▶ 박자 격자 ─▶ templateChart()
//                                                                                       박자에 맞춘 기본 록 패턴
//
// [설명] 스틱은 한 개라서 같은 순간에 하이햇과 스네어를 같이 칠 수 없다.
//   그래서 한 칸(16분 · 8분 · 4분음표)에 스틱 노트는 하나만 둔다 (크래시 > 탐 > 스네어 > 하이햇). 킥은 발(버튼)이라 따로.
//
// [설명] 유튜브 소리는 다른 사이트(유튜브) 안에서 재생돼서 브라우저 보안 규칙상 파형을 읽을 수 없다.
//   그래서 유튜브는 "박자만" 맞추고, 노트는 박자 격자 위의 패턴으로 만든다 (곡의 실제 드럼과 같지는 않다).

import { LANE_OF, type Chart } from './charts';

export type Level = 1 | 2 | 3 | 4;
/** 아주 쉬움 = 2 · 4박(손뼉 자리)만, 쉬움 = 박마다, 보통 = 8분음표, 어려움 = 16분음표 */
export const LEVEL_NAMES: Record<Level, string> = { 1: '아주 쉬움', 2: '쉬움', 3: '보통', 4: '어려움' };

/** 박자 격자: 첫 박(1마디 1박) 시각과 1박 길이. 시각은 모두 노래 시작 기준 ms */
export interface BeatGrid {
  beatMs: number;
  firstBeatMs: number;
}

/** 음악 파일 분석 결과 (악보를 다시 만들 때 재사용) */
export interface Analysis {
  hopMs: number;
  /** 대역별 onset 세기 (프레임마다). 0 이상 */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  /** 세 대역을 합친 onset (박자 찾기용) */
  all: Float32Array;
  /** 프레임마다 소리 세기 (세 대역 에너지 합, log 아님) — 후렴처럼 커지는 곳 찾기용 */
  power: Float32Array;
  durationMs: number;
  /** 박마다 실제 시각 (전체 격자 + 박마다 조금씩 따라간 보정). beats[0] = 드럼이 시작하는 마디의 1박 */
  beats: number[];
  bpm: number;
}

const { snare: SNARE, kick: KICK, hihat: HIHAT, tom: TOM, crash: CRASH } = LANE_OF;

// ---------------------------------------------------------------------------
// 탭으로 박자 맞추기 (유튜브)
// ---------------------------------------------------------------------------
export interface TapFit {
  grid: BeatGrid;
  bpm: number;
  /** 탭이 격자에서 평균 얼마나 벗어났나 (ms). 크면 다시 */
  jitterMs: number;
}

/**
 * 박마다 친 시각(노래 기준 ms) → 박자 격자. 첫 탭 = 1박.
 * [설명] 간격의 중앙값으로 대략의 1박을 잡고, 탭마다 몇 번째 박인지 정한 뒤 직선 맞춤(최소제곱)으로
 *   "시각 = 첫 박 + 번호 × 1박"의 두 값을 구한다. 한두 번 놓친 박이 있어도 번호가 건너뛸 뿐 결과는 맞다.
 *   prior(앞서 맞춘 격자)가 있으면 그 격자로 번호를 매긴다 → 곡 앞부분 탭 + 중간 탭을 합쳐 BPM이 훨씬 정확해진다
 *   (탭 사이 거리가 길수록 1박 길이 오차가 줄어든다. 0.1% 틀리면 4분 곡 끝에서 0.2초 어긋남).
 */
export function fitTaps(taps: number[], prior?: BeatGrid): TapFit | null {
  if (taps.length < 6) return null;
  let ks: number[];
  if (prior) {
    ks = taps.map((t) => Math.round((t - prior.firstBeatMs) / prior.beatMs));
  } else {
    const gaps = taps.slice(1).map((t, i) => t - taps[i]).filter((g) => g > 200);
    if (gaps.length < 4) return null;
    const rough = median(gaps);
    if (rough < 250 || rough > 1300) return null; // 46~240 BPM 밖
    ks = taps.map((t) => Math.round((t - taps[0]) / rough));
  }
  const n = ks.length;
  const mk = ks.reduce((s, k) => s + k, 0) / n;
  const mt = taps.reduce((s, t) => s + t, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (ks[i] - mk) * (taps[i] - mt);
    sxx += (ks[i] - mk) ** 2;
  }
  if (sxx === 0) return null;
  const beatMs = sxy / sxx;
  const firstBeatMs = mt - beatMs * mk;
  const jitterMs = taps.reduce((s, t, i) => s + Math.abs(t - (firstBeatMs + ks[i] * beatMs)), 0) / n;
  return { grid: { beatMs, firstBeatMs }, bpm: 60000 / beatMs, jitterMs };
}

/**
 * 대략의 BPM을 아는 곡(인기곡)의 탭 → 박자 격자. 탭 하나 = tapEvery박 (2면 "짝"마다 = 2 · 4박).
 * [설명] 간격마다 "대략 1주기의 몇 배인지"로 번호를 매기고(놓친 탭이 있어도 됨) 직선 맞춤.
 *   사용자가 박마다(주기의 절반) 또는 두 주기마다 쳤으면 중앙값 간격으로 알아채고 맞춰 준다.
 *   tapEvery 2이면 첫 탭이 2박(스네어)이라 첫 박 = 첫 탭 - 1박.
 */
export function fitKnownTaps(taps: number[], approxBpm: number, tapEvery: 1 | 2): TapFit | null {
  if (taps.length < 5) return null;
  const gaps = taps.slice(1).map((t, i) => t - taps[i]).filter((g) => g > 150);
  if (gaps.length < 4) return null;
  let period = (60000 / approxBpm) * tapEvery;
  const r = median(gaps) / period;
  const mult = [0.5, 1, 2].reduce((a, b) => (Math.abs(Math.log(r / b)) < Math.abs(Math.log(r / a)) ? b : a));
  if (Math.abs(Math.log(r / mult)) > 0.2) return null; // 이 곡의 박자와 너무 다르게 침
  period *= mult;
  const beatsPerTap = tapEvery * mult;
  // 번호 매기기: 중앙값 간격(실제 주기에 가까움)으로, 앞 탭과의 간격이 몇 주기인지
  const p0 = median(gaps.filter((g) => Math.abs(g / period - 1) < 0.3).concat([period]));
  const ks = [0];
  for (let i = 1; i < taps.length; i++) ks.push(ks[i - 1] + Math.round((taps[i] - taps[i - 1]) / p0));
  // 같은 번호(두 번 친 탭)는 뒤의 것을 버린다
  let pts = taps.map((t, i) => ({ t, k: ks[i] })).filter((p, i, a) => i === 0 || p.k !== a[i - 1].k);
  let line = lineFit(pts);
  if (!line) return null;
  // 혼자 크게 벗어난 탭(주기의 15% 넘게)은 빼고 다시 맞춘다 — 한 번 놓치거나 늦게 친 탭이 전체를 끌고 가지 않게
  for (let round = 0; round < 2; round++) {
    const l = line;
    const keep = pts.filter((p) => Math.abs(p.t - (l.a + l.b * p.k)) < l.b * 0.15);
    if (keep.length === pts.length || keep.length < 5) break;
    pts = keep;
    line = lineFit(pts);
    if (!line) return null;
  }
  const { a: firstTap, b: tapPeriod } = line;
  const beatMs = tapPeriod / beatsPerTap;
  const jitterMs = pts.reduce((s, p) => s + Math.abs(p.t - (firstTap + p.k * tapPeriod)), 0) / pts.length;
  if (jitterMs > tapPeriod * 0.12) return null; // 너무 들쭉날쭉
  // 스네어 자리(2박)에 친 탭이면 1박 앞이 마디 첫 박
  const firstBeatMs = beatsPerTap === 2 ? firstTap - beatMs : firstTap;
  return { grid: { beatMs, firstBeatMs: Math.max(0, firstBeatMs) }, bpm: 60000 / beatMs, jitterMs };
}

/** 최소제곱 직선 t = a + b·k */
function lineFit(pts: { t: number; k: number }[]): { a: number; b: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  const mk = pts.reduce((s, p) => s + p.k, 0) / n;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.k - mk) * (p.t - mt);
    sxx += (p.k - mk) ** 2;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: mt - b * mk, b };
}

// ---------------------------------------------------------------------------
// 패턴 악보 (유튜브: 박자만 알 때)
// ---------------------------------------------------------------------------
type Bar = Partial<Record<'kick' | 'snare' | 'hihat' | 'tom' | 'crash', string>>;

/** 난이도별 [보통 마디, 필인 마디]. 16칸 = 1마디 */
const TEMPLATES: Record<Level, { groove: Bar; fill: Bar }> = {
  1: {
    groove: { kick: 'x.x.....x.x.....', snare: '....x.......x...' },
    fill: { kick: 'x.x.....x.x.....', snare: '....x.......x...' },
  },
  2: {
    groove: { kick: 'x.......x.......', snare: '....x.......x...' },
    fill: { kick: 'x...............', snare: '....x...', tom: '........x...x...' },
  },
  3: {
    groove: { kick: 'x.......x.x.....', snare: '....x.......x...', hihat: 'x.x.x.x.x.x.x.x.' },
    fill: { kick: 'x.......', hihat: 'x.x.', snare: '....x.x.', tom: '........x.x.x.x.' },
  },
  4: {
    groove: { kick: 'x..x..x...x..x..', snare: '....x..x....x...', hihat: 'x.xxx.x.x.xxx.x.' },
    fill: { kick: 'x.......', snare: 'x.xxx.xx', tom: '........xxxx.x.x' },
  },
};

/** 8마디 단위: 첫 마디 1박 크래시, 마지막 마디 필인 */
const PHRASE_BARS = 8;

/**
 * 박자 격자 위에 기본 록 패턴을 깐다. endMs(노래 끝)까지.
 * 스틱 노트는 한 칸에 하나: 크래시 > 탐 > 스네어 > 하이햇
 */
export function templateChart(grid: BeatGrid, level: Level, endMs: number): Chart {
  const { beatMs, firstBeatMs } = grid;
  const stepMs = beatMs / 4;
  const barMs = beatMs * 4;
  const bars = Math.max(1, Math.floor((endMs - firstBeatMs - beatMs) / barMs));
  const notes: Chart['notes'] = [];
  for (let b = 0; b < bars; b++) {
    const inPhrase = b % PHRASE_BARS;
    const last = b === bars - 1;
    const bar: Bar = { ...(inPhrase === PHRASE_BARS - 1 && !last ? TEMPLATES[level].fill : TEMPLATES[level].groove) };
    if (inPhrase === 0) bar.crash = 'x';
    if (last) Object.assign(bar, { crash: 'x', kick: 'x', snare: '', hihat: '', tom: '' });
    for (let s = 0; s < 16; s++) {
      const time = firstBeatMs + (b * 16 + s) * stepMs;
      if (bar.kick?.[s] === 'x') notes.push({ lane: KICK, time });
      const stick = (['crash', 'tom', 'snare', 'hihat'] as const).find((d) => bar[d]?.[s] === 'x');
      if (stick) notes.push({ lane: LANE_OF[stick], time });
    }
  }
  const beats = Array.from({ length: bars * 4 }, (_, i) => firstBeatMs + i * beatMs);
  return finishChart(notes, beats, beatMs);
}

// ---------------------------------------------------------------------------
// 음악 파일 분석
// ---------------------------------------------------------------------------
const SR = 22050; // 분석용 표본율 (드럼 소리를 구분하기에 충분하고 빠르다)
const HOP = 256; // 11.6ms마다 한 프레임
const WIN = 512;

/**
 * 오디오 → 대역 3개(낮은음 · 중간 · 높은음)로 나눠 onset을 구하고 박자를 찾는다.
 * [설명] OfflineAudioContext = 스피커로 내보내지 않고 "계산만" 하는 오디오 엔진. 곡 전체를 몇백 ms 만에 필터링한다.
 *   필터 3개를 ChannelMerger로 모아 채널 0/1/2 = 낮은음/중간/높은음 으로 한 번에 렌더링한다.
 */
export async function analyzeAudio(buffer: AudioBuffer, bpmHint?: number): Promise<Analysis> {
  const len = Math.ceil(buffer.duration * SR);
  const off = new OfflineAudioContext(3, len, SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  const merger = off.createChannelMerger(3);
  const chain = (specs: [BiquadFilterType, number, number][], input: number) => {
    let node: AudioNode = src;
    for (const [type, freq, q] of specs) {
      const f = off.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      node.connect(f);
      node = f;
    }
    node.connect(merger, 0, input);
  };
  chain([['lowpass', 110, 0.7], ['lowpass', 110, 0.7]], 0); // 킥: 베이스 드럼 몸통
  chain([['bandpass', 2200, 0.9]], 1); // 스네어: "딱" 하는 울림 · 잡음
  chain([['highpass', 8000, 0.7], ['highpass', 8000, 0.7]], 2); // 하이햇 · 심벌
  merger.connect(off.destination);
  src.start();
  const out = await off.startRendering();

  const [low, eLow] = onsetCurve(out.getChannelData(0));
  const [mid, eMid] = onsetCurve(out.getChannelData(1));
  const [high, eHigh] = onsetCurve(out.getChannelData(2));
  const all = new Float32Array(low.length);
  const power = new Float32Array(low.length);
  for (let i = 0; i < all.length; i++) {
    all[i] = low[i] + mid[i] + high[i];
    power[i] = eLow[i] + eMid[i] + eHigh[i];
  }
  const a: Analysis = { hopMs: (HOP / SR) * 1000, low, mid, high, all, power, durationMs: buffer.duration * 1000, beats: [], bpm: 0 };
  findBeats(a, bpmHint);
  return a;
}

/**
 * 한 대역 신호 → onset 곡선.
 * [설명] 프레임마다 소리 세기(에너지)를 log로 눌러 담고, "직전 몇 프레임보다 얼마나 커졌나"(양수만)를 onset으로 본다.
 *   북을 치는 순간 세기가 갑자기 커지므로 그 프레임에서 값이 튄다. 길게 이어지는 소리(기타 · 노래)는 거의 0.
 *   대역마다 평균으로 나눠 세 대역을 같은 눈금으로 맞춘다.
 */
function onsetCurve(x: Float32Array): [Float32Array, Float32Array] {
  const frames = Math.max(0, Math.floor((x.length - WIN) / HOP));
  const e = new Float32Array(frames);
  let mean = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const o = f * HOP;
    for (let i = 0; i < WIN; i++) s += x[o + i] * x[o + i];
    e[f] = s / WIN;
    mean += e[f];
  }
  mean = mean / Math.max(1, frames) + 1e-12;
  const L = e.map((v) => Math.log1p((100 * v) / mean));
  const on = new Float32Array(frames);
  let sum = 0;
  for (let f = 3; f < frames; f++) {
    const prev = Math.max(L[f - 1], L[f - 2], L[f - 3]) * 0.5 + ((L[f - 1] + L[f - 2] + L[f - 3]) / 3) * 0.5;
    on[f] = Math.max(0, L[f] - prev);
    sum += on[f];
  }
  const avg = sum / Math.max(1, frames) + 1e-9;
  for (let f = 0; f < frames; f++) on[f] /= avg;
  return [on, e];
}

/** 시각 → 프레임 번호. 창 가운데를 그 프레임의 시각으로 본다 (합성 드럼 시험에서 박 오차 평균 -6ms → 0 근처) */
const frameOf = (a: Analysis, ms: number) => Math.round((ms - (WIN / 2 / SR) * 1000) / a.hopMs);

/** ms 주변 ±radius 프레임 안의 최댓값 */
function peakNear(curve: Float32Array, a: Analysis, ms: number, radius: number): number {
  const c = frameOf(a, ms);
  let m = 0;
  for (let f = Math.max(0, c - radius); f <= Math.min(curve.length - 1, c + radius); f++) m = Math.max(m, curve[f]);
  return m;
}

/**
 * 박자 찾기: ① 자기상관으로 대략의 BPM ② BPM · 위상을 곡 전체에 맞춰 미세 조정 ③ 박마다 조금씩 따라가기
 * ④ 마디 첫 박 고르기(킥은 1 · 3박, 스네어는 2 · 4박에 많다) ⑤ 드럼이 시작 · 끝나는 마디 찾기
 * bpmHint가 있으면 그 근처에서만 찾는다 (BPM ×2 · ÷2 버튼).
 */
export function findBeats(a: Analysis, bpmHint?: number): void {
  const o = a.all;
  const hop = a.hopMs;

  // ① 자기상관 (사람이 흔히 느끼는 120 BPM 근처를 조금 더 믿는다)
  let bpm0 = bpmHint ?? 0;
  if (!bpmHint) {
    let mean = 0;
    for (const v of o) mean += v;
    mean /= o.length || 1;
    let best = -Infinity;
    for (let bpm = 60; bpm <= 190; bpm += 0.5) {
      const lag = 60000 / bpm / hop;
      const l0 = Math.floor(lag);
      const fr = lag - l0;
      let r = 0;
      for (let i = 0; i + l0 + 1 < o.length; i++) {
        const shifted = o[i + l0] * (1 - fr) + o[i + l0 + 1] * fr;
        r += (o[i] - mean) * (shifted - mean);
      }
      const w = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.8) ** 2);
      if (r * w > best) {
        best = r * w;
        bpm0 = bpm;
      }
    }
  }

  // ② 곡 전체 격자에 onset이 가장 많이 걸리는 BPM · 위상
  const scoreGrid = (beatMs: number, phase: number) => {
    let s = 0;
    for (let t = phase; t < a.durationMs; t += beatMs) s += peakNear(o, a, t, 1) + 0.5 * peakNear(o, a, t + beatMs / 2, 1);
    return s;
  };
  let bestBeat = 60000 / bpm0;
  let bestPhase = 0;
  let bestScore = -Infinity;
  const span = bpmHint ? 0.015 : 0.03;
  for (let bpm = bpm0 * (1 - span); bpm <= bpm0 * (1 + span); bpm += bpm0 * 0.0005) {
    const beatMs = 60000 / bpm;
    for (let p = 0; p < 48; p++) {
      const phase = (p / 48) * beatMs;
      const s = scoreGrid(beatMs, phase);
      if (s > bestScore) {
        bestScore = s;
        bestBeat = beatMs;
        bestPhase = phase;
      }
    }
  }

  // ③ 박마다 ±50ms 안에서 onset에 가장 잘 맞는 어긋남을 찾고, 앞뒤 박과 부드럽게 이어 준다 (라이브 녹음의 템포 흔들림)
  const raw: number[] = [];
  for (let t = bestPhase; t < a.durationMs - 100; t += bestBeat) raw.push(t);
  const shift = raw.map((t) => {
    let bestD = 0;
    let bestV = -1;
    for (let d = -50; d <= 50; d += 5) {
      let v = 0;
      for (let j = -2; j <= 2; j++) v += peakNear(o, a, t + d + j * bestBeat, 0) * (j === 0 ? 2 : 1);
      if (v > bestV + 1e-6) {
        bestV = v;
        bestD = d;
      }
    }
    return bestD;
  });
  const smooth = shift.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(shift.length - 1, i + 4); j++, n++) s += shift[j];
    return s / n;
  });
  let beats = raw.map((t, i) => t + smooth[i]);

  // ④ 마디 첫 박: 킥은 1 · 3박, 스네어는 2 · 4박
  let bar0 = 0;
  let barBest = -Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    beats.forEach((t, i) => {
      const pos = (i - k + 4) % 4;
      const kick = peakNear(a.low, a, t, 1);
      const snare = peakNear(a.mid, a, t, 1);
      s += pos % 2 === 0 ? kick - snare : snare - kick;
    });
    if (s > barBest) {
      barBest = s;
      bar0 = k;
    }
  }

  // ⑤ 드럼이 연주되는 구간: 2마디 평균 onset이 곡 전체의 상위 25% 값의 40%를 넘는 첫/마지막 마디
  const act = beats.map((t) => peakNear(a.low, a, t, 1) + peakNear(a.mid, a, t, 1) + peakNear(a.high, a, t, 1));
  const ref = quantile(act, 0.75) * 0.4;
  // 킥 · 스네어로는 1박과 3박을 구별할 수 없다(둘 다 킥). 드럼은 보통 마디 첫 박에서 시작하므로,
  // 처음 드럼이 들어온 박이 3박 자리에 걸리면 두 박 옮긴다.
  const firstHit = act.findIndex((v, i) => v >= ref && mean(act.slice(i, i + 8)) >= ref);
  if (firstHit >= 0 && (firstHit - bar0 + 4) % 4 === 2) bar0 = (bar0 + 2) % 4;
  const barStarts: number[] = [];
  for (let i = bar0; i + 4 <= beats.length; i += 4) barStarts.push(i);
  const active = (i: number) => mean(act.slice(i, i + 8)) >= ref;
  const first = barStarts.find(active) ?? bar0;
  const lastStart = [...barStarts].reverse().find(active) ?? barStarts[barStarts.length - 1] ?? first;
  beats = beats.slice(first, Math.min(beats.length, lastStart + 4));
  a.beats = beats;
  a.bpm = 60000 / bestBeat;
}

/** BPM 목표 비율 (×2, ÷2) 로 다시 찾기 */
export function refindBeats(a: Analysis, factor: number): void {
  findBeats(a, Math.max(40, Math.min(240, a.bpm * factor)));
}

/**
 * 분석 결과 → 악보. 실제로 소리가 난 곳에만 노트를 둔다.
 * [설명] 난이도에 따라 격자 간격(4분 · 8분 · 16분음표)을 정하고, 칸마다 세 대역 onset을 본다.
 *   점수가 높은 순서로 "1박에 몇 개" 목표만큼 고른다 → 곡마다 소리 크기가 달라도 노트 수가 알맞게 나온다.
 *   스네어는 2 · 4박에 더 잘 나오게, 엇박은 덜 나오게 보정한다(대부분의 대중음악 드럼 규칙).
 *   마디 세기가 앞 마디들보다 확 커지면(후렴 시작) 첫 박을 크래시로, 그 앞 마디 뒷부분은 탐(필인)으로.
 */
export function onsetChart(a: Analysis, level: Level): Chart {
  const beats = a.beats;
  if (beats.length < 8) return finishChart([], beats, 500);
  const beatMs = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
  const sub = level <= 2 ? 1 : level === 3 ? 2 : 4; // 1박을 몇 칸으로
  interface Cell { t: number; beat: number; s: number; l: number; m: number; h: number }
  const cells: Cell[] = [];
  for (let i = 0; i < beats.length; i++) {
    const next = beats[i + 1] ?? beats[i] + beatMs;
    for (let s = 0; s < sub; s++) {
      const t = beats[i] + ((next - beats[i]) * s) / sub;
      cells.push({ t, beat: i, s, l: peakNear(a.low, a, t, 2), m: peakNear(a.mid, a, t, 2), h: peakNear(a.high, a, t, 2) });
    }
  }
  // 대역마다 상위 10% 값으로 나눠 0~1 근처로
  const norm = (k: 'l' | 'm' | 'h') => {
    const q = quantile(cells.map((c) => c[k]), 0.9) || 1;
    for (const c of cells) c[k] /= q;
  };
  norm('l');
  norm('m');
  norm('h');

  const backbeat = (c: Cell) => c.s === 0 && c.beat % 2 === 1; // 2 · 4박
  const snareScore = (c: Cell) => c.m * (backbeat(c) ? 1.5 : c.s === 0 ? 0.8 : 0.7);
  const hatScore = (c: Cell) => c.h * (c.s % 2 === 0 ? 0.9 : 0.75);
  // 아주 쉬움: 2 · 4박(손뼉 · 스네어 자리)만
  const stickScore = (c: Cell) => (level === 1 ? (backbeat(c) ? Math.max(snareScore(c), hatScore(c)) : 0) : Math.max(snareScore(c), hatScore(c)));
  // 하이햇과 스네어가 같이 들리면 하이햇으로 (2 · 4박은 위에서 스네어를 1.5배로 밀어 줌)
  const isSnare = (c: Cell) => snareScore(c) > hatScore(c) * 1.2;

  const target = { 1: { stick: 0.5, kick: 0.5 }, 2: { stick: 0.9, kick: 0.5 }, 3: { stick: 1.4, kick: 0.6 }, 4: { stick: 2.1, kick: 0.85 } }[level];
  const pick = (score: (c: Cell) => number, perBeat: number, floor: number) => {
    const vals = cells.map(score).sort((x, y) => y - x);
    const thr = vals[Math.min(vals.length - 1, Math.floor(perBeat * beats.length))] ?? Infinity;
    return Math.max(thr, floor);
  };
  const stickThr = pick(stickScore, target.stick, 0.3);
  const kickThr = pick((c) => c.l, target.kick, 0.35);

  const notes: Chart['notes'] = [];
  const stickAt = new Map<number, number>(); // 칸 번호 → 스틱 노트 index (크래시 · 탐으로 바꾸려고)
  cells.forEach((c, i) => {
    if (c.l >= kickThr && (level > 2 || c.s === 0)) notes.push({ lane: KICK, time: c.t });
    if (stickScore(c) >= stickThr) {
      stickAt.set(i, notes.length);
      notes.push({ lane: level === 1 || isSnare(c) ? SNARE : HIHAT, time: c.t });
    }
  });

  // 마디 세기(에너지 평균) → 후렴 · 새 부분 시작에 크래시, 그 앞 마디 3 · 4박은 탐 필인
  const cellsPerBar = sub * 4;
  const bars = Math.floor(cells.length / cellsPerBar);
  const energy = Array.from({ length: bars }, (_, b) => {
    const f0 = Math.max(0, frameOf(a, beats[b * 4]));
    const f1 = Math.min(a.power.length, frameOf(a, beats[b * 4 + 3] + beatMs));
    let s = 0;
    for (let f = f0; f < f1; f++) s += a.power[f];
    return s / Math.max(1, f1 - f0);
  });
  let lastCrash = -4;
  for (let b = 0; b < bars; b++) {
    const before = Math.max(energy[b - 1] ?? 0, energy[b - 2] ?? 0);
    const rise = b === 0 || energy[b] > before * 1.6; // 세기(에너지)가 1.6배 = 소리 크기 약 1.3배
    if (!rise || b - lastCrash < 4) continue;
    lastCrash = b;
    const i0 = b * cellsPerBar;
    const idx = stickAt.get(i0);
    if (idx !== undefined) notes[idx].lane = CRASH;
    else {
      stickAt.set(i0, notes.length);
      notes.push({ lane: CRASH, time: cells[i0].t });
    }
    if (b > 0) {
      for (let i = i0 - cellsPerBar / 2; i < i0; i++) {
        const j = stickAt.get(i);
        if (j !== undefined && notes[j].lane === SNARE) notes[j].lane = TOM;
      }
    }
  }
  return finishChart(notes, beats.slice(0, bars * 4), beatMs);
}

function finishChart(notes: Chart['notes'], beats: number[], beatMs: number): Chart {
  notes.sort((x, y) => x.time - y.time || x.lane - y.lane);
  const last = notes.length ? notes[notes.length - 1].time : beats[beats.length - 1] ?? 0;
  return { notes, beats, beatMs, durationMs: last + beatMs * 4, startMs: beats[0] ?? 0 };
}

function median(xs: number[]): number {
  return quantile(xs, 0.5);
}
function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
