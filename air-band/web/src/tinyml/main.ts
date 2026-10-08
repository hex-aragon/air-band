// TinyML 페이지 진입점: ② 데이터 모으기 → ③ 학습 → ④ zone_model.h 내보내기
//
// [한눈에 보기]
//
//   보드 ─BLE─▶ onMotion (25Hz 방향) ─▶ motionBuf (최근 0.8초)
//          └──▶ onHit ─▶ 수집 중이면: motionBuf에서 직전 6개를 잘라 (정답 = 고른 드럼) 샘플로 저장
//                       학습된 모델이 있으면: 같은 입력으로 예측해서 "실시간 시험"에 표시
//
//   샘플 · 모델은 브라우저(localStorage)에 저장해서 새로고침해도 남는다.
//   학습은 화면이 멈추지 않도록 한 프레임에 몇 epoch씩 나눠서 돌린다.
import { AirBandConnection, CMD, webBluetoothSupport, type MotionEvent } from '../ble';
import { DrumAudio } from '../audio';
import {
  FEATURE_HZ,
  INPUTS,
  STICK_CLASSES,
  WINDOW,
  ZONE,
  Trainer,
  evaluate,
  fromCsv,
  predict,
  split,
  synthesize,
  toCHeader,
  toCsv,
  type Model,
  type Sample,
} from './model';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const NAMES: Record<number, string> = { 0: '스네어', 1: '킥', 2: '하이햇', 3: '탐', 4: '크래시' };
const DIRS: Record<number, string> = { 0: '정면', 2: '왼쪽', 3: '오른쪽', 4: '위로' };
const hueOf = (cls: number) => (200 + cls * 70) % 360;
/** 수집 순서: 하이햇 → 스네어 → 탐 → 크래시 (왼쪽부터) */
const COLLECT_ORDER = [2, 0, 3, 4];
/** 스윙 판정: 직전 창의 가속도 최대가 이 값 미만이면 버튼 입력으로 보고 건너뛴다 */
const MIN_SWING_G = 1.8;
const STORE_SAMPLES = 'airband.tinyml.samples';
const STORE_MODEL = 'airband.tinyml.model';

const audio = new DrumAudio();
const conn = new AirBandConnection();

let samples: Sample[] = load<Sample[]>(STORE_SAMPLES, []);
let model: Model | null = load<Model | null>(STORE_MODEL, null);
let lastEval: { valAcc: number; ruleAcc: number; trainN: number } | null = null;

let label = COLLECT_ORDER[0];
let collecting = false;
const motionBuf: { h: number; e: number; g: number; t: number }[] = [];
let lastMotionAt = -Infinity;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장 불가(시크릿 창 등) — 이번 방문 동안만 유지
  }
}

// ---------------------------------------------------------------------------
// 탭
// ---------------------------------------------------------------------------
const tabs = [...document.querySelectorAll<HTMLButtonElement>('nav.tabs button')];
function showTab(name: string): void {
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const sec of document.querySelectorAll<HTMLElement>('section.tab')) sec.hidden = sec.id !== `tab-${name}`;
  if (name === 'data') drawScatter();
  if (name === 'train') drawLoss();
  history.replaceState(null, '', `#${name}`);
}
for (const b of tabs) b.addEventListener('click', () => showTab(b.dataset.tab!));

// ---------------------------------------------------------------------------
// 센서
// ---------------------------------------------------------------------------
const connectBtn = $<HTMLButtonElement>('connect');
const recenterBtn = $<HTMLButtonElement>('recenter');
const statusEl = $('status');
const connected = () => statusEl.dataset.state === 'connected';

conn.onState = (s, detail) => {
  statusEl.dataset.state = s;
  statusEl.textContent = s === 'connected' ? `연결됨 · ${detail ?? ''}` : s === 'connecting' ? '연결 중…' : detail ? `연결 안 됨 · ${detail}` : '연결 안 됨';
  connectBtn.textContent = s === 'connected' ? '연결 끊기' : s === 'connecting' ? '연결 중…' : '센서 연결';
  connectBtn.disabled = s === 'connecting';
  recenterBtn.disabled = s !== 'connected';
  if (s === 'connected') void conn.send(CMD.motionOn);
  if (s === 'disconnected') setCollecting(false);
  renderPrompt();
};
connectBtn.addEventListener('click', async () => {
  await audio.resume();
  if (connected()) return conn.disconnect();
  try {
    await conn.connect();
  } catch (err) {
    console.warn('BLE 연결 실패', err);
  }
});
const recenter = () => connected() && void conn.send(CMD.recenter);
recenterBtn.addEventListener('click', recenter);
window.addEventListener('keydown', (ev) => {
  if ((ev.key === 'c' || ev.key === 'C') && !(ev.target instanceof HTMLInputElement)) recenter();
});

conn.onMotion = (m: MotionEvent) => {
  lastMotionAt = m.receivedAt;
  motionBuf.push({ h: m.headingDeg, e: m.elevationDeg, g: m.accelG, t: m.receivedAt });
  while (motionBuf.length && m.receivedAt - motionBuf[0].t > 800) motionBuf.shift();
};

/**
 * 타격 직전 궤적 → 모델 입력 (오래된 것 → 최신).
 * 모션 패킷은 40ms 간격이라 최근 WINDOW개가 곧 직전 0.24초다. 중간에 패킷이 빠졌으면(간격이 너무 벌어짐) 버린다.
 */
function windowBefore(t: number): { x: number[]; maxG: number } | null {
  const before = motionBuf.filter((p) => p.t <= t + 5);
  if (before.length < WINDOW) return null;
  const w = before.slice(-WINDOW);
  const span = w[WINDOW - 1].t - w[0].t;
  if (t - w[WINDOW - 1].t > 120 || span > ((WINDOW - 1) * 1000) / FEATURE_HZ + 120) return null;
  return { x: w.flatMap((p) => [p.h, p.e]), maxG: Math.max(...w.map((p) => p.g)) };
}

conn.onHit = (e) => {
  audio.play(e.cls, e.velocity);
  if (e.cls === 1) return; // 킥(버튼 2)은 모델 대상이 아님
  const w = windowBefore(e.receivedAt);

  // 실시간 시험: 모델이 있으면 같은 타격을 모델로도 판정
  if (model && w) {
    const p = predict(model, w.x);
    $('live').innerHTML = `모델 <b style="color:hsl(${hueOf(p)} 70% 50%)">${NAMES[p]}</b> · 보드 판정 <b>${NAMES[e.cls] ?? e.cls}</b>${
      collecting ? ` · 정답 <b>${NAMES[label]}</b>` : ''
    }`;
  }

  if (!collecting) return;
  if (!w) return log('방향 데이터가 부족해 건너뜀 (모션 스트림 확인)');
  if (w.maxG < MIN_SWING_G) return log(`스윙이 약해 건너뜀 (최대 ${w.maxG.toFixed(1)}g) — 보드 버튼이 아니라 스틱으로 쳐 주세요`);
  // rule: 보드가 보낸 판정. 펌웨어가 규칙(classifier=rule)일 때만 "규칙 정확도" 비교가 의미 있다
  samples.push({ x: w.x, y: label, rule: e.cls, src: 'sensor' });
  save(STORE_SAMPLES, samples);
  const ok = e.cls === label;
  log(`${NAMES[label]} #${countOf(label, 'sensor')} 저장 · 보드 판정 ${NAMES[e.cls] ?? e.cls} ${ok ? '✓' : '✗ (규칙이 틀림 — 모델이 배울 데이터)'}`);
  const target = Number($<HTMLInputElement>('target').value) || 20;
  if ($<HTMLInputElement>('auto').checked && countOf(label, 'sensor') >= target) {
    const next = COLLECT_ORDER.find((c) => countOf(c, 'sensor') < target);
    if (next === undefined) {
      setCollecting(false);
      log('모든 드럼을 다 모았습니다 → ③ 학습으로 가세요');
    } else {
      label = next;
      renderLabels();
    }
  }
  renderPrompt();
  renderSummary();
};

const countOf = (cls: number, src?: Sample['src']) => samples.filter((s) => s.y === cls && (!src || s.src === src)).length;

function log(msg: string): void {
  $('collect-log').textContent = msg;
}

// ---------------------------------------------------------------------------
// ② 데이터 화면
// ---------------------------------------------------------------------------
function renderLabels(): void {
  const box = $('labels');
  box.replaceChildren();
  for (const cls of COLLECT_ORDER) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.style.setProperty('--hue', String(hueOf(cls)));
    b.setAttribute('aria-pressed', String(cls === label));
    b.textContent = `${NAMES[cls]} (${DIRS[cls]}) · ${countOf(cls, 'sensor')}`;
    b.addEventListener('click', () => {
      label = cls;
      renderLabels();
      renderPrompt();
    });
    box.append(b);
  }
}

function setCollecting(on: boolean): void {
  collecting = on;
  const btn = $<HTMLButtonElement>('collect');
  btn.textContent = on ? '■ 수집 멈춤' : '● 수집 시작';
  btn.classList.toggle('primary', !on);
  renderPrompt();
}
$('collect').addEventListener('click', () => {
  void audio.resume();
  setCollecting(!collecting);
});

function renderPrompt(): void {
  const target = Number($<HTMLInputElement>('target').value) || 20;
  const n = countOf(label, 'sensor');
  const el = $('prompt');
  if (!connected()) el.innerHTML = '센서를 연결하세요 <small>(보드 없이 해 보려면 아래 "가상 데이터")</small>';
  else if (performance.now() - lastMotionAt > 1500) el.innerHTML = '방향 데이터가 안 옵니다 <small>(IMU 연결 · 모션 스트림 확인)</small>';
  else if (!collecting) el.innerHTML = `준비됨 <small>— 스틱을 스네어 자리에 두고 정면 맞추기(C) → ● 수집 시작</small>`;
  else el.innerHTML = `${NAMES[label]} 쪽(${DIRS[label]})을 치세요 <small>${n} / ${target}</small>`;
  $('collect-bar').style.width = `${Math.min(1, n / target) * 100}%`;
  renderLabels();
}
setInterval(renderPrompt, 1000);
$('target').addEventListener('input', renderPrompt);

$('synth').addEventListener('click', () => {
  const n = Math.max(10, Math.min(300, Number($<HTMLInputElement>('synth-n').value) || 60));
  samples = samples.concat(synthesize(n));
  save(STORE_SAMPLES, samples);
  renderSummary();
  drawScatter();
});

function renderSummary(): void {
  const rows = STICK_CLASSES.map((cls) => {
    const sensor = samples.filter((s) => s.y === cls && s.src === 'sensor');
    const ruleOk = sensor.filter((s) => s.rule === s.y).length;
    return `<tr><td><span style="color:hsl(${hueOf(cls)} 70% 50%)">●</span> ${NAMES[cls]}</td>
      <td class="num">${sensor.length}</td><td class="num">${countOf(cls, 'synthetic')}</td>
      <td class="num">${sensor.length ? `${Math.round((ruleOk / sensor.length) * 100)}%` : '—'}</td></tr>`;
  });
  $('summary').innerHTML = `<tr><th>드럼</th><th class="num">센서</th><th class="num">가상</th><th class="num">보드가 맞힌 비율 (센서)</th></tr>${rows.join('')}`;
  renderLabels();
}

$('export-csv').addEventListener('click', () => {
  download(`airband-tinyml-${samples.length}.csv`, toCsv(samples), 'text/csv');
});
$<HTMLInputElement>('import-csv').addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const added = fromCsv(await file.text());
  samples = samples.concat(added);
  save(STORE_SAMPLES, samples);
  log(`CSV에서 ${added.length}개를 불러왔습니다`);
  renderSummary();
  drawScatter();
});
$('clear-synth').addEventListener('click', () => {
  samples = samples.filter((s) => s.src !== 'synthetic');
  save(STORE_SAMPLES, samples);
  renderSummary();
  drawScatter();
});
$('clear-all').addEventListener('click', () => {
  if (!window.confirm(`모은 데이터 ${samples.length}개를 모두 지울까요?`)) return;
  samples = [];
  save(STORE_SAMPLES, samples);
  renderSummary();
  drawScatter();
});

function download(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// 그래프 (캔버스 공통)
// ---------------------------------------------------------------------------
function prepCanvas(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number; dark: boolean } {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height, dark: window.matchMedia('(prefers-color-scheme: dark)').matches };
}

/** 타격 순간 방향(창의 마지막 샘플) 산점도 + 규칙 경계 */
function drawScatter(): void {
  const c = $<HTMLCanvasElement>('scatter');
  if (!c.offsetParent) return;
  const { ctx, w, h, dark } = prepCanvas(c);
  const H = 75;
  const E0 = -45;
  const E1 = 65;
  const X = (deg: number) => ((H - deg) / (2 * H)) * w; // 왼쪽(+)이 화면 왼쪽
  const Y = (deg: number) => ((E1 - deg) / (E1 - E0)) * h;
  const dim = dark ? '#8b93a1' : '#6b7280';
  ctx.strokeStyle = dim;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(0, Y(ZONE.up));
  ctx.lineTo(w, Y(ZONE.up));
  ctx.moveTo(X(ZONE.left), Y(ZONE.up));
  ctx.lineTo(X(ZONE.left), h);
  ctx.moveTo(X(-ZONE.right), Y(ZONE.up));
  ctx.lineTo(X(-ZONE.right), h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = dim;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('크래시 구역', w / 2, 16);
  ctx.fillText('하이햇', X(50), h - 8);
  ctx.fillText('스네어', X(0), h - 8);
  ctx.fillText('탐', X(-50), h - 8);
  ctx.textAlign = 'left';
  ctx.fillText('← 왼쪽', 6, Y(0) - 4);
  for (const s of samples) {
    const hd = s.x[INPUTS - 2];
    const el = s.x[INPUTS - 1];
    ctx.beginPath();
    ctx.arc(X(hd), Y(el), s.src === 'sensor' ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hueOf(s.y)}, 80%, ${dark ? 62 : 48}%, ${s.src === 'sensor' ? 0.95 : 0.55})`;
    ctx.fill();
  }
  if (samples.length === 0) {
    ctx.textAlign = 'center';
    ctx.fillText('아직 데이터가 없습니다', w / 2, h / 2);
  }
}
new ResizeObserver(() => drawScatter()).observe($('scatter'));

// ---------------------------------------------------------------------------
// ③ 학습
// ---------------------------------------------------------------------------
let losses: number[] = [];
let valCurve: number[] = [];
let training = false;

function drawLoss(): void {
  const c = $<HTMLCanvasElement>('loss');
  if (!c.offsetParent) return;
  const { ctx, w, h, dark } = prepCanvas(c);
  const dim = dark ? '#8b93a1' : '#6b7280';
  ctx.fillStyle = dim;
  ctx.font = '12px system-ui, sans-serif';
  if (losses.length < 2) {
    ctx.textAlign = 'center';
    ctx.fillText('학습을 시작하면 손실(파랑, 내려갈수록 좋음)과 검증 정확도(초록)가 그려집니다', w / 2, h / 2);
    return;
  }
  const maxL = Math.max(...losses);
  const n = losses.length;
  const plot = (vals: number[], max: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = 30 + (i / Math.max(1, n - 1)) * (w - 40);
      const y = h - 20 - (v / max) * (h - 36);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  plot(losses, maxL, dark ? '#60a5fa' : '#2563eb');
  plot(valCurve, 1, dark ? '#4ade80' : '#16a34a');
  ctx.textAlign = 'left';
  ctx.fillText(`epoch ${n} · 손실 ${losses[n - 1].toFixed(3)} · 검증 ${(valCurve[n - 1] * 100).toFixed(0)}%`, 30, 14);
}

$('train').addEventListener('click', () => {
  if (training) return;
  const which = $<HTMLSelectElement>('opt-data').value;
  const data = which === 'all' ? samples : samples.filter((s) => s.src === which);
  const note = $('train-note');
  const perClass = STICK_CLASSES.map((c) => data.filter((s) => s.y === c).length);
  if (Math.min(...perClass) < 5) {
    note.textContent = `드럼마다 최소 5개는 있어야 합니다 (지금 ${STICK_CLASSES.map((c, i) => `${NAMES[c]} ${perClass[i]}`).join(' · ')}). ② 데이터에서 더 모으세요.`;
    return;
  }
  note.textContent =
    data.length < 80 ? `데이터 ${data.length}개 — 적어서 검증 점수가 들쭉날쭉할 수 있습니다. 드럼마다 20개 이상 권장.` : `데이터 ${data.length}개로 학습합니다.`;

  const { train, val } = split(data, 0.2, 1);
  const trainer = new Trainer(train, { hidden: Number($<HTMLSelectElement>('opt-hidden').value), lr: 0.01, l2: 1e-3, seed: 7 });
  const epochs = Number($<HTMLSelectElement>('opt-epochs').value);
  losses = [];
  valCurve = [];
  training = true;
  $<HTMLButtonElement>('train').disabled = true;

  const tick = () => {
    for (let i = 0; i < 5 && trainer.epoch < epochs; i++) {
      losses.push(trainer.runEpoch());
      valCurve.push(evaluate(trainer.model, val).acc);
    }
    drawLoss();
    if (trainer.epoch < epochs) {
      requestAnimationFrame(tick);
      return;
    }
    training = false;
    $<HTMLButtonElement>('train').disabled = false;
    model = trainer.model;
    save(STORE_MODEL, model);
    const ev = evaluate(model, val);
    lastEval = { valAcc: ev.acc, ruleAcc: ev.ruleAcc, trainN: train.length };
    showScores(ev, train.length);
    renderDeploy();
  };
  requestAnimationFrame(tick);
});

function showScores(ev: ReturnType<typeof evaluate>, trainN: number): void {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const m = $('s-model');
  m.textContent = pct(ev.acc);
  m.className = ev.acc >= ev.ruleAcc ? 'good' : 'bad';
  $('s-rule').textContent = ev.ruleN ? pct(ev.ruleAcc) : '—';
  $('s-n').textContent = `${trainN} · ${ev.n}`;
  const head = `<tr><th>정답 \\ 예측</th>${STICK_CLASSES.map((c) => `<th class="num">${NAMES[c]}</th>`).join('')}</tr>`;
  const rows = STICK_CLASSES.map(
    (c, i) =>
      `<tr><td>${NAMES[c]}</td>${ev.confusion[i].map((v, j) => `<td class="num${i === j ? ' hit' : ''}">${v}</td>`).join('')}</tr>`,
  );
  $('confusion').innerHTML = head + rows.join('');
}

// ---------------------------------------------------------------------------
// ④ 보드에 넣기
// ---------------------------------------------------------------------------
function renderDeploy(): void {
  const btn = $<HTMLButtonElement>('download');
  btn.disabled = !model;
  if (!model) return;
  const params = model.w1.length + model.b1.length + model.w2.length + model.b2.length;
  $('model-info').textContent = lastEval
    ? `검증 정확도 ${(lastEval.valAcc * 100).toFixed(1)}% · 가중치 ${params}개 (${((params * 4) / 1024).toFixed(1)}KB)`
    : `저장된 모델 · 가중치 ${params}개 (이전 방문에 학습)`;
}
$('download').addEventListener('click', () => {
  if (!model) return;
  const info = lastEval ? { samples: lastEval.trainN, valAcc: lastEval.valAcc, ruleAcc: lastEval.ruleAcc } : { samples: 0, valAcc: 0, ruleAcc: 0 };
  download('zone_model.h', toCHeader(model, info), 'text/x-c');
});

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------
function init(): void {
  const support = webBluetoothSupport();
  if (!support.ok) {
    connectBtn.disabled = true;
    const el = $('support');
    el.textContent = `${support.reason} — 센서 없이도 가상 데이터로 학습 · 내보내기는 할 수 있습니다.`;
    el.hidden = false;
  }
  renderSummary();
  renderPrompt();
  renderDeploy();
  const tab = location.hash.slice(1);
  showTab(['intro', 'data', 'train', 'deploy'].includes(tab) ? tab : 'intro');
  void audio.init();
}
init();
