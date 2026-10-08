// TinyML: 스틱 궤적 → 드럼 분류 모델 (데이터 · 학습 · 평가 · C 코드 내보내기)
//
// [한눈에 보기]
//   입력  : 타격 직전 0.24초 동안의 스틱 방향 6개 (25Hz) = [좌우, 위아래] × 6 = 숫자 12개
//   모델  : 아주 작은 신경망 (12 → 은닉 16 → 4). 가중치 약 280개 = float 1KB 남짓
//   출력  : 스네어 · 하이햇 · 탐 · 크래시 중 하나 (킥은 발 = 버튼이라 제외)
//
//   지금 펌웨어는 "타격 순간 방향이 왼쪽 25° 넘으면 하이햇" 같은 고정 규칙(구역)으로 고른다.
//   모델은 (1) 사람마다 다른 경계(어떤 사람은 하이햇을 20°만 돌려서 친다)와
//   (2) 직전 궤적(어디서부터 내려왔는지)을 같이 보고 고른다. 그래서 경계 근처 오판이 줄어든다.
//
// [설명] 학습이란
//   예측 확률과 정답의 차이(손실, cross-entropy)를 줄이는 방향으로 가중치를 조금씩 고치는 일을 반복한다.
//   방향은 미분(역전파)으로 구하고, 고치는 보폭은 Adam이라는 방법이 자동으로 조절한다.
//   배열 연산 라이브러리 없이 이 파일만으로 돈다 (모델이 작아서 브라우저에서 1초 안에 끝남).

/** 모델이 고르는 드럼 class (audio.ts DRUM_CLASSES 번호). 출력 순서도 이 순서 */
export const STICK_CLASSES = [0, 2, 3, 4] as const;
/** 입력 창: 방향 샘플 개수와 간격 (펌웨어 zone_model.h에도 같은 값이 들어간다) */
export const WINDOW = 6;
export const FEATURE_HZ = 25;
export const INPUTS = WINDOW * 2;

export interface Sample {
  /** [h0, e0, h1, e1, …] 오래된 것 → 최신, 단위 도 */
  x: number[];
  /** 정답 드럼 class */
  y: number;
  /** 같은 타격에 대한 펌웨어 규칙(구역)의 판정. 모르면 -1 */
  rule: number;
  src: 'sensor' | 'synthetic';
}

export interface Model {
  hidden: number;
  mean: number[];
  std: number[];
  w1: number[]; // hidden × INPUTS (행 우선)
  b1: number[];
  w2: number[]; // classes × hidden
  b2: number[];
}

const K = STICK_CLASSES.length;
const classIndex = (cls: number) => STICK_CLASSES.indexOf(cls as (typeof STICK_CLASSES)[number]);

// ---------------------------------------------------------------------------
// 난수 (같은 seed면 같은 결과 — 학습을 다시 돌려도 비교할 수 있게)
// ---------------------------------------------------------------------------
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ---------------------------------------------------------------------------
// 규칙 (펌웨어 orientation.h zone()과 같음) — 비교 기준선
// ---------------------------------------------------------------------------
export const ZONE = { left: 25, right: 25, up: 25 };
export function ruleZone(h: number, e: number): number {
  if (e >= ZONE.up) return 4;
  if (h >= ZONE.left) return 2;
  if (h <= -ZONE.right) return 3;
  return 0;
}

// ---------------------------------------------------------------------------
// 가상 데이터 생성 (보드 없이 흐름을 익히는 용도)
// ---------------------------------------------------------------------------
// [설명] "어떤 한 사람"의 치는 습관을 흉내 낸다.
//   이 사람은 하이햇을 평균 30°만 돌려서 치고(규칙 경계 25°에 가까움), 크래시도 33° 정도만 든다.
//   그래서 규칙으로는 꽤 틀리고, 모델은 이 사람의 경계와 궤적을 배워서 더 잘 맞힌다.
//   진짜 효과는 실제 센서 데이터로 확인해야 한다 (가상 데이터 점수는 참고용).
const STYLE: Record<number, { h: number; e: number; sh: number; se: number; dh: number; de: number }> = {
  0: { h: 2, e: -2, sh: 11, se: 8, dh: 0, de: 28 }, // 스네어: 정면, 위에서 내려침
  2: { h: 27, e: 4, sh: 11, se: 7, dh: 7, de: 22 }, // 하이햇: 왼쪽, 바깥에서 안으로 들어오며
  3: { h: -31, e: -5, sh: 11, se: 7, dh: -7, de: 26 }, // 탐: 오른쪽
  4: { h: 10, e: 29, sh: 16, se: 9, dh: 0, de: 14 }, // 크래시: 위로, 크게 들었다가 짧게
};

export function synthesize(perClass: number, seed = Date.now()): Sample[] {
  const rand = rng(seed);
  const out: Sample[] = [];
  for (const cls of STICK_CLASSES) {
    const st = STYLE[cls];
    for (let n = 0; n < perClass; n++) {
      const hEnd = st.h + gauss(rand) * st.sh;
      const eEnd = st.e + gauss(rand) * st.se;
      const dh = st.dh + gauss(rand) * 4;
      const de = st.de + gauss(rand) * 7;
      const x: number[] = [];
      for (let k = 0; k < WINDOW; k++) {
        const back = 1 - k / (WINDOW - 1); // 1 = 가장 오래된 샘플, 0 = 타격 순간
        x.push(hEnd + dh * back ** 1.5 + gauss(rand) * 3);
        x.push(eEnd + de * back ** 2 + gauss(rand) * 3);
      }
      out.push({ x, y: cls, rule: ruleZone(x[INPUTS - 2], x[INPUTS - 1]), src: 'synthetic' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 학습 · 평가
// ---------------------------------------------------------------------------
export function split(samples: Sample[], valRatio: number, seed: number): { train: Sample[]; val: Sample[] } {
  const rand = rng(seed);
  const a = [...samples];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nVal = Math.round(a.length * valRatio);
  return { val: a.slice(0, nVal), train: a.slice(nVal) };
}

/** 확률 (STICK_CLASSES 순서) */
export function predictProbs(m: Model, raw: number[]): number[] {
  const x = raw.map((v, i) => (v - m.mean[i]) / m.std[i]);
  const a1 = new Array<number>(m.hidden);
  for (let j = 0; j < m.hidden; j++) {
    let z = m.b1[j];
    for (let i = 0; i < INPUTS; i++) z += m.w1[j * INPUTS + i] * x[i];
    a1[j] = z > 0 ? z : 0;
  }
  const z2 = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    let z = m.b2[k];
    for (let j = 0; j < m.hidden; j++) z += m.w2[k * m.hidden + j] * a1[j];
    z2[k] = z;
  }
  return softmax(z2);
}

/** 가장 확률 높은 드럼 class */
export function predict(m: Model, raw: number[]): number {
  const p = predictProbs(m, raw);
  return STICK_CLASSES[p.indexOf(Math.max(...p))];
}

function softmax(z: number[]): number[] {
  const mx = Math.max(...z);
  const e = z.map((v) => Math.exp(v - mx));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

export interface Evaluation {
  n: number;
  acc: number;
  /** 같은 샘플에 대한 규칙(구역)의 정확도. 규칙 판정을 모르는 샘플은 빼고 계산 */
  ruleAcc: number;
  ruleN: number;
  /** confusion[정답][예측], STICK_CLASSES 순서 */
  confusion: number[][];
}

export function evaluate(m: Model, samples: Sample[]): Evaluation {
  const confusion = STICK_CLASSES.map(() => new Array<number>(K).fill(0));
  let ok = 0;
  let ruleOk = 0;
  let ruleN = 0;
  for (const s of samples) {
    const p = predict(m, s.x);
    if (p === s.y) ok++;
    confusion[classIndex(s.y)][classIndex(p)]++;
    if (s.rule >= 0) {
      ruleN++;
      if (s.rule === s.y) ruleOk++;
    }
  }
  return { n: samples.length, acc: samples.length ? ok / samples.length : 0, ruleAcc: ruleN ? ruleOk / ruleN : 0, ruleN, confusion };
}

export interface TrainOptions {
  hidden: number;
  lr: number;
  l2: number;
  seed: number;
}

/**
 * 한 번에 다 돌지 않고 epoch 단위로 나눠 돌 수 있게 만든 학습기 (화면에 손실 곡선을 그리면서 학습하려고).
 * [설명] epoch = 학습 데이터를 한 바퀴 다 보는 것. 미니배치(16개씩)마다 가중치를 한 번 고친다.
 */
export class Trainer {
  readonly model: Model;
  epoch = 0;
  private rand: () => number;
  private xs: number[][];
  private ys: number[];
  // Adam 상태 (파라미터마다 기울기의 이동 평균 m, 제곱의 이동 평균 v)
  private mState: Record<'w1' | 'b1' | 'w2' | 'b2', number[]>;
  private vState: Record<'w1' | 'b1' | 'w2' | 'b2', number[]>;
  private steps = 0;

  constructor(
    data: Sample[],
    private opts: TrainOptions,
  ) {
    this.rand = rng(opts.seed);
    // 표준화: 입력마다 평균 0, 표준편차 1로 맞춰야 학습이 잘 된다 (펌웨어도 같은 값으로 바꾼다)
    const mean = new Array<number>(INPUTS).fill(0);
    const std = new Array<number>(INPUTS).fill(0);
    for (const s of data) s.x.forEach((v, i) => (mean[i] += v / data.length));
    for (const s of data) s.x.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / data.length));
    for (let i = 0; i < INPUTS; i++) std[i] = Math.sqrt(std[i]) || 1;

    const H = opts.hidden;
    const he = (fanIn: number) => () => gauss(this.rand) * Math.sqrt(2 / fanIn);
    this.model = {
      hidden: H,
      mean,
      std,
      w1: Array.from({ length: H * INPUTS }, he(INPUTS)),
      b1: new Array<number>(H).fill(0),
      w2: Array.from({ length: K * H }, he(H)),
      b2: new Array<number>(K).fill(0),
    };
    const zeros = () => ({
      w1: new Array<number>(H * INPUTS).fill(0),
      b1: new Array<number>(H).fill(0),
      w2: new Array<number>(K * H).fill(0),
      b2: new Array<number>(K).fill(0),
    });
    this.mState = zeros();
    this.vState = zeros();
    this.xs = data.map((s) => s.x.map((v, i) => (v - mean[i]) / std[i]));
    this.ys = data.map((s) => classIndex(s.y));
  }

  /** 1 epoch 학습하고 평균 손실을 돌려준다 */
  runEpoch(batch = 16): number {
    const n = this.xs.length;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let lossSum = 0;
    for (let start = 0; start < n; start += batch) {
      lossSum += this.step(order.slice(start, start + batch));
    }
    this.epoch++;
    return lossSum / n;
  }

  private step(idx: number[]): number {
    const m = this.model;
    const H = m.hidden;
    const g = {
      w1: new Array<number>(H * INPUTS).fill(0),
      b1: new Array<number>(H).fill(0),
      w2: new Array<number>(K * H).fill(0),
      b2: new Array<number>(K).fill(0),
    };
    let loss = 0;
    const z1 = new Array<number>(H);
    const a1 = new Array<number>(H);
    for (const n of idx) {
      const x = this.xs[n];
      // 앞으로 계산
      for (let j = 0; j < H; j++) {
        let z = m.b1[j];
        for (let i = 0; i < INPUTS; i++) z += m.w1[j * INPUTS + i] * x[i];
        z1[j] = z;
        a1[j] = z > 0 ? z : 0;
      }
      const z2 = new Array<number>(K);
      for (let k = 0; k < K; k++) {
        let z = m.b2[k];
        for (let j = 0; j < H; j++) z += m.w2[k * H + j] * a1[j];
        z2[k] = z;
      }
      const p = softmax(z2);
      loss -= Math.log(Math.max(1e-9, p[this.ys[n]]));
      // 뒤로 (역전파): 출력 오차 = 확률 - 정답(원-핫)
      const dz2 = p.map((v, k) => v - (k === this.ys[n] ? 1 : 0));
      for (let k = 0; k < K; k++) {
        g.b2[k] += dz2[k];
        for (let j = 0; j < H; j++) g.w2[k * H + j] += dz2[k] * a1[j];
      }
      for (let j = 0; j < H; j++) {
        if (z1[j] <= 0) continue;
        let da = 0;
        for (let k = 0; k < K; k++) da += m.w2[k * H + j] * dz2[k];
        g.b1[j] += da;
        for (let i = 0; i < INPUTS; i++) g.w1[j * INPUTS + i] += da * x[i];
      }
    }
    // Adam 업데이트 (+ 가중치에만 L2: 큰 가중치를 벌줘서 데이터가 적어도 덜 외우게)
    this.steps++;
    const { lr, l2 } = this.opts;
    const b1 = 0.9;
    const b2 = 0.999;
    for (const key of ['w1', 'b1', 'w2', 'b2'] as const) {
      const param = m[key];
      const grad = g[key];
      const ms = this.mState[key];
      const vs = this.vState[key];
      const decay = key === 'w1' || key === 'w2' ? l2 : 0;
      for (let i = 0; i < param.length; i++) {
        const gi = grad[i] / idx.length + decay * param[i];
        ms[i] = b1 * ms[i] + (1 - b1) * gi;
        vs[i] = b2 * vs[i] + (1 - b2) * gi * gi;
        const mh = ms[i] / (1 - b1 ** this.steps);
        const vh = vs[i] / (1 - b2 ** this.steps);
        param[i] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
      }
    }
    return loss;
  }
}

// ---------------------------------------------------------------------------
// 내보내기: 펌웨어용 C 헤더 (zone_model.h)
// ---------------------------------------------------------------------------
export function toCHeader(m: Model, info: { samples: number; valAcc: number; ruleAcc: number }): string {
  const arr = (a: number[], perLine = 8) => {
    const parts = a.map((v) => `${v.toFixed(6)}f`);
    const lines: string[] = [];
    for (let i = 0; i < parts.length; i += perLine) lines.push('  ' + parts.slice(i, i + perLine).join(', '));
    return lines.join(',\n');
  };
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `// zone_model.h — Air Band TinyML 드럼 분류 모델 (web/tinyml.html에서 자동 생성, ${stamp})
// 학습 샘플 ${info.samples}개 · 검증 정확도 ${(info.valAcc * 100).toFixed(1)}% (같은 데이터에서 규칙 ${(info.ruleAcc * 100).toFixed(1)}%)
//
// 사용법: 이 파일을 firmware/air_band_right/ 폴더에 넣고 업로드하면 classifyHit()이 규칙 대신 이 모델을 쓴다.
//         (air_band_right.ino의 USE_TINYML이 1이어야 함. 파일을 지우면 다시 규칙 기반)
// 입력: 타격 직전 방향 ${WINDOW}개 (${FEATURE_HZ}Hz) [좌우°, 위아래°] × ${WINDOW}, 오래된 것 → 최신
// 구조: ${INPUTS} → ${m.hidden}(ReLU) → ${K}  (가중치 ${m.w1.length + m.b1.length + m.w2.length + m.b2.length}개)
#pragma once
#include <stdint.h>

#define ZONE_MODEL_WINDOW ${WINDOW}
#define ZONE_MODEL_HZ     ${FEATURE_HZ}
#define ZONE_MODEL_INPUTS ${INPUTS}
#define ZONE_MODEL_HIDDEN ${m.hidden}
#define ZONE_MODEL_OUTPUTS ${K}

// 출력 순서 → 드럼 class (스네어 0 · 하이햇 2 · 탐 3 · 크래시 4)
static const uint8_t ZONE_MODEL_CLASSES[ZONE_MODEL_OUTPUTS] = { ${STICK_CLASSES.join(', ')} };

static const float ZONE_MODEL_MEAN[ZONE_MODEL_INPUTS] = {
${arr(m.mean)}
};
static const float ZONE_MODEL_STD[ZONE_MODEL_INPUTS] = {
${arr(m.std)}
};
static const float ZONE_MODEL_W1[ZONE_MODEL_HIDDEN * ZONE_MODEL_INPUTS] = {
${arr(m.w1)}
};
static const float ZONE_MODEL_B1[ZONE_MODEL_HIDDEN] = {
${arr(m.b1)}
};
static const float ZONE_MODEL_W2[ZONE_MODEL_OUTPUTS * ZONE_MODEL_HIDDEN] = {
${arr(m.w2)}
};
static const float ZONE_MODEL_B2[ZONE_MODEL_OUTPUTS] = {
${arr(m.b2)}
};

// x: [h0, e0, h1, e1, ...] (도). 반환: 드럼 class
static inline uint8_t zoneModelPredict(const float* x) {
  float in[ZONE_MODEL_INPUTS];
  for (int i = 0; i < ZONE_MODEL_INPUTS; i++) in[i] = (x[i] - ZONE_MODEL_MEAN[i]) / ZONE_MODEL_STD[i];
  float a1[ZONE_MODEL_HIDDEN];
  for (int j = 0; j < ZONE_MODEL_HIDDEN; j++) {
    float z = ZONE_MODEL_B1[j];
    for (int i = 0; i < ZONE_MODEL_INPUTS; i++) z += ZONE_MODEL_W1[j * ZONE_MODEL_INPUTS + i] * in[i];
    a1[j] = z > 0.0f ? z : 0.0f;
  }
  int best = 0;
  float bestZ = -1e30f;
  for (int k = 0; k < ZONE_MODEL_OUTPUTS; k++) {
    float z = ZONE_MODEL_B2[k];
    for (int j = 0; j < ZONE_MODEL_HIDDEN; j++) z += ZONE_MODEL_W2[k * ZONE_MODEL_HIDDEN + j] * a1[j];
    if (z > bestZ) { bestZ = z; best = k; }
  }
  return ZONE_MODEL_CLASSES[best];
}
`;
}

// ---------------------------------------------------------------------------
// CSV (데이터 백업 · 다른 도구로 옮기기)
// ---------------------------------------------------------------------------
export function toCsv(samples: Sample[]): string {
  const head = ['label', 'src', 'rule', ...Array.from({ length: WINDOW }, (_, k) => [`h${k}`, `e${k}`]).flat()];
  return [head.join(','), ...samples.map((s) => [s.y, s.src, s.rule, ...s.x.map((v) => v.toFixed(2))].join(','))].join('\n');
}

export function fromCsv(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    if (c.length !== 3 + INPUTS) continue;
    const y = Number(c[0]);
    if (classIndex(y) < 0) continue;
    const x = c.slice(3).map(Number);
    if (x.some((v) => !Number.isFinite(v))) continue;
    out.push({ y, src: c[1] === 'synthetic' ? 'synthetic' : 'sensor', rule: Number(c[2]), x });
  }
  return out;
}
