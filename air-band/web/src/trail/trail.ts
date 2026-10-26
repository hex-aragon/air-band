// 연주 궤적: 스틱이 지나간 길을 검은 바탕 위의 빛나는 선으로 그린다 (영상 · 그림 저장용)
//
// [한눈에 보기]
//   TrailRecorder : 연주하는 동안 스틱 방향(모션 패킷 25Hz)과 타격(드럼 · 세기)을 시각과 함께 모은다 → TrailTake
//   TrailRenderer : TrailTake를 시각 t까지 그린다. 매 프레임 render(t)를 부르면 애니메이션, finalFrame()은 완성 그림
//
// [설명] 그림 구성 (위에서부터 겹침)
//   1) 작품 층(art): 지나간 길이 옅은 선으로 계속 쌓인다 — 곡이 끝나면 한 장의 그림으로 남는다
//   2) 꼬리(live): 최근 0.7초의 길은 밝고 굵게, 빠르게 휘두를수록 굵게
//   3) 타격 불꽃: 친 자리에서 드럼 색 고리 + 불티. 세게 칠수록 크게
//   선은 'lighter'(빛 더하기)로 그려서 겹칠수록 밝아진다 → 빛으로 그린 사진(light painting) 느낌
//
// [설명] 좌표: 좌우 각도 h(+ = 왼쪽) → 화면 x는 왼쪽, 위아래 각도 e(+ = 위) → 화면 위.
//   모션은 25Hz라 그대로 이으면 각져 보여서 Catmull-Rom 곡선으로 점 사이를 6개씩 메운다.
//   스틱 없이(키보드 · 터치) 친 연주는 모션이 없으므로, 드럼 자리 사이를 들어 올렸다 내려치는 가상의 길을 만든다.

export interface TrailPoint {
  t: number; // 곡 시작 기준 ms
  h: number; // 좌우 각도 (+ = 왼쪽)
  e: number; // 위아래 각도 (+ = 위)
}
export interface TrailHit {
  t: number;
  cls: number; // 0 스네어 · 1 킥 · 2 하이햇 · 3 탐 · 4 크래시
  vel: number; // 0~127
}
export interface TrailTake {
  title: string;
  sub: string; // 예: "S · 12,340점"
  date: string;
  durationMs: number;
  points: TrailPoint[]; // 비어 있으면 가상 길
  hits: TrailHit[];
}

/** 드럼별 색 (hue) — 하이햇 금색 · 스네어 흰빛 하늘 · 탐 빨강 · 크래시 파랑 · 킥 보라 */
const DRUM_HUE: Record<number, [number, number]> = { 0: [195, 40], 1: [275, 85], 2: [45, 95], 3: [355, 90], 4: [215, 95] };
/** 스틱 없이 친 연주의 드럼 자리 (센서 각도 단위, 펌웨어 구역 가운데쯤) */
const DRUM_SPOT: Record<number, [number, number]> = { 0: [0, -12], 1: [0, -34], 2: [52, -6], 3: [-52, -12], 4: [24, 46] };

export class TrailRecorder {
  private points: TrailPoint[] = [];
  private hits: TrailHit[] = [];
  private on = false;

  start(): void {
    this.points = [];
    this.hits = [];
    this.on = true;
  }
  motion(t: number, h: number, e: number): void {
    if (!this.on || !Number.isFinite(h) || !Number.isFinite(e)) return;
    const last = this.points[this.points.length - 1];
    if (last && t <= last.t) return;
    this.points.push({ t, h, e });
  }
  hit(t: number, cls: number, vel: number): void {
    if (this.on) this.hits.push({ t, cls, vel });
  }
  get recording(): boolean {
    return this.on;
  }
  finish(title: string, sub: string, durationMs: number): TrailTake | null {
    this.on = false;
    if (!this.hits.length && this.points.length < 10) return null;
    const t0 = Math.min(this.hits[0]?.t ?? Infinity, this.points[0]?.t ?? Infinity);
    const shift = Math.max(0, t0 - 1500); // 앞쪽 빈 시간은 잘라서 바로 시작하게
    const d = new Date();
    return {
      title,
      sub,
      date: `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`,
      durationMs: Math.max(1000, durationMs - shift),
      points: this.points.map((p) => ({ ...p, t: p.t - shift })),
      hits: this.hits.map((x) => ({ ...x, t: x.t - shift })),
    };
  }
}

/** 하이라이트: 타격이 가장 많은 lenMs 구간만 잘라 낸 연주 */
export function highlight(take: TrailTake, lenMs: number): TrailTake {
  if (take.durationMs <= lenMs + 2000) return take;
  let best = 0;
  let bestN = -1;
  for (let s = 0; s + lenMs <= take.durationMs; s += 500) {
    const n = take.hits.filter((x) => x.t >= s && x.t < s + lenMs).reduce((a, x) => a + 0.5 + x.vel / 127, 0);
    if (n > bestN) {
      bestN = n;
      best = s;
    }
  }
  const pts = take.points.filter((p) => p.t >= best - 200 && p.t <= best + lenMs + 200);
  return {
    ...take,
    durationMs: lenMs,
    points: pts.map((p) => ({ ...p, t: p.t - best })),
    hits: take.hits.filter((x) => x.t >= best && x.t < best + lenMs).map((x) => ({ ...x, t: x.t - best })),
  };
}

// ---------------------------------------------------------------------------
// 길 만들기 (곡선으로 메우기 · 스틱 없을 때 가상 길)
// ---------------------------------------------------------------------------
function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** 거친 점들 → 촘촘한 점들 (점 사이를 sub개로) */
function densify(pts: TrailPoint[], sub: number): TrailPoint[] {
  if (pts.length < 3) return pts.slice();
  const out: TrailPoint[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    // 한참 끊겼던 구간(0.3초 넘게)은 곡선으로 잇지 않고 그대로
    const n = p2.t - p1.t > 300 ? 1 : sub;
    for (let k = 0; k < n; k++) {
      const u = k / n;
      out.push({ t: p1.t + (p2.t - p1.t) * u, h: catmull(p0.h, p1.h, p2.h, p3.h, u), e: catmull(p0.e, p1.e, p2.e, p3.e, u) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** 스틱 없이 친 연주: 드럼 자리 사이를 "들어 올렸다 → 내려치는" 길 */
function syntheticPath(take: TrailTake): TrailPoint[] {
  const hits = take.hits.filter((x) => x.cls !== 1 || take.hits.length < 4);
  if (!hits.length) return [];
  // 같은 사람이 친 것처럼 매번 조금씩 다른 자리 (고정 씨앗 난수 → 미리보기와 저장 결과가 같다)
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pts: TrailPoint[] = [];
  let prev: [number, number] = [DRUM_SPOT[0][0], DRUM_SPOT[0][1] + 20];
  pts.push({ t: Math.max(0, hits[0].t - 600), h: prev[0], e: prev[1] });
  for (const x of hits) {
    const spot = DRUM_SPOT[x.cls] ?? DRUM_SPOT[0];
    const to: [number, number] = [spot[0] + (rnd() - 0.5) * 10, spot[1] + (rnd() - 0.5) * 6];
    const last = pts[pts.length - 1];
    const gap = Math.max(120, x.t - last.t);
    const lift = 14 + (x.vel / 127) * 22;
    // 들어 올린 꼭대기 → 내려친 자리 → 살짝 되튐
    pts.push({ t: x.t - gap * 0.45, h: (prev[0] + to[0]) / 2 + (rnd() - 0.5) * 8, e: Math.max(prev[1], to[1]) + lift });
    pts.push({ t: x.t, h: to[0], e: to[1] });
    pts.push({ t: x.t + Math.min(90, gap * 0.25), h: to[0] + (rnd() - 0.5) * 4, e: to[1] + lift * 0.35 });
    prev = to;
  }
  return pts.sort((a, b) => a.t - b.t).filter((p, i, a) => i === 0 || p.t > a[i - 1].t);
}

// ---------------------------------------------------------------------------
// 그리기
// ---------------------------------------------------------------------------
interface Spark {
  dx: number;
  dy: number;
  life: number;
}

export class TrailRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private art: HTMLCanvasElement;
  private actx: CanvasRenderingContext2D;
  private path: TrailPoint[];
  private drawnIdx = 0; // 작품 층에 어디까지 그렸나
  private drawnHits = 0;
  private sparks: Spark[][]; // 타격마다 불티 방향 (고정)
  private scale = 1;
  private cx = 0;
  private cy = 0;
  /** 곡이 끝난 뒤 완성 그림을 보여 주는 시간 */
  static readonly OUTRO_MS = 3500;

  constructor(
    readonly take: TrailTake,
    readonly width: number,
    readonly height: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    this.art = document.createElement('canvas');
    this.art.width = width;
    this.art.height = height;
    this.actx = this.art.getContext('2d')!;
    const real = take.points.length >= 10;
    this.path = densify(real ? take.points : syntheticPath(take), real ? 6 : 14);
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    this.sparks = take.hits.map((x) =>
      Array.from({ length: 10 + Math.round((x.vel / 127) * 14) }, () => {
        const a = rnd() * Math.PI * 2;
        const v = 0.4 + rnd() * 0.8;
        return { dx: Math.cos(a) * v, dy: Math.sin(a) * v, life: 0.5 + rnd() * 0.6 };
      }),
    );
    this.fit();
    this.reset();
  }

  /** 길 전체가 화면에 들어오게 (위아래 · 좌우 같은 배율) */
  private fit(): void {
    const hs = this.path.map((p) => p.h);
    const es = this.path.map((p) => p.e);
    for (const x of this.take.hits) {
      const p = this.posAt(x.t);
      hs.push(p.h);
      es.push(p.e);
    }
    const pad = 8;
    const minH = Math.min(-40, ...hs) - pad;
    const maxH = Math.max(40, ...hs) + pad;
    const minE = Math.min(-30, ...es) - pad;
    const maxE = Math.max(30, ...es) + pad;
    const W = this.width;
    const H = this.height;
    const portrait = H > W;
    const boxW = W * 0.86;
    const boxH = H * (portrait ? 0.62 : 0.74);
    this.scale = Math.min(boxW / (maxH - minH), boxH / (maxE - minE));
    this.cx = W / 2 + ((maxH + minH) / 2) * this.scale; // 좌우 각도 +가 왼쪽이라 부호 반대
    this.cy = H * (portrait ? 0.46 : 0.47) + ((maxE + minE) / 2) * this.scale;
  }

  private xy(h: number, e: number): [number, number] {
    return [this.cx - h * this.scale, this.cy - e * this.scale];
  }

  /** 시각 t의 스틱 자리 (촘촘한 길에서 보간) */
  private posAt(t: number): TrailPoint {
    const p = this.path;
    if (!p.length) return { t, h: 0, e: 0 };
    if (t <= p[0].t) return p[0];
    if (t >= p[p.length - 1].t) return p[p.length - 1];
    let lo = 0;
    let hi = p.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (p[m].t <= t) lo = m;
      else hi = m;
    }
    const a = p[lo];
    const b = p[hi];
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return { t, h: a.h + (b.h - a.h) * u, e: a.e + (b.e - a.e) * u };
  }

  /** 시간에 따라 천천히 바뀌는 선 색 */
  private hueAt(t: number): number {
    return 190 + (t / Math.max(1, this.take.durationMs)) * 145; // 청록 → 파랑 → 보라 → 분홍
  }

  reset(): void {
    this.drawnIdx = 0;
    this.drawnHits = 0;
    this.actx.globalCompositeOperation = 'source-over';
    this.actx.clearRect(0, 0, this.width, this.height);
  }

  /** 작품 층에 t까지의 길을 이어 그린다 (뒤로 가면 처음부터) */
  private growArt(t: number): void {
    const p = this.path;
    const c = this.actx;
    const u = this.width / 1080; // 해상도 단위
    c.lineCap = 'round';
    c.lineJoin = 'round';
    while (this.drawnIdx + 1 < p.length && p[this.drawnIdx + 1].t <= t) {
      const a = p[this.drawnIdx];
      const b = p[this.drawnIdx + 1];
      this.drawnIdx++;
      if (b.t - a.t > 300) continue;
      const [x1, y1] = this.xy(a.h, a.e);
      const [x2, y2] = this.xy(b.h, b.e);
      const speed = Math.hypot(x2 - x1, y2 - y1) / Math.max(1, b.t - a.t) / u; // px/ms (1080 기준)
      const hue = this.hueAt(b.t);
      const w = (1.6 + Math.min(5, speed * 1.4)) * u;
      // 넓고 옅은 빛(더하기: 자주 지나간 길이 은은하게 밝아짐) + 가는 심(덮어 그리기: 여러 번 지나가도 하얗게 타지 않고 제 색)
      c.globalCompositeOperation = 'lighter';
      c.strokeStyle = `hsla(${hue}, 95%, 55%, 0.022)`;
      c.lineWidth = w * 6;
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
      c.globalCompositeOperation = 'source-over';
      c.strokeStyle = `hsla(${hue}, 100%, 70%, 0.32)`;
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
    }
    // 친 자리에 남는 작은 별
    while (this.drawnHits < this.take.hits.length && this.take.hits[this.drawnHits].t <= t) {
      const x = this.take.hits[this.drawnHits++];
      const pos = this.posAt(x.t);
      const [px, py] = this.xy(pos.h, pos.e);
      const [hue, sat] = DRUM_HUE[x.cls] ?? DRUM_HUE[0];
      const r = (2 + (x.vel / 127) * 6) * u;
      c.globalCompositeOperation = 'lighter';
      const g = c.createRadialGradient(px, py, 0, px, py, r * 3);
      g.addColorStop(0, `hsla(${hue}, ${sat}%, 80%, 0.1)`);
      g.addColorStop(1, `hsla(${hue}, ${sat}%, 60%, 0)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(px, py, r * 3, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** 시각 t의 한 장면 */
  render(t: number): void {
    if (t < (this.path[this.drawnIdx]?.t ?? 0) - 1) this.reset();
    this.growArt(t);
    const c = this.ctx;
    const W = this.width;
    const H = this.height;
    const u = W / 1080;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    // 은은한 바닥 빛
    const bg = c.createRadialGradient(W / 2, H * 0.5, 0, W / 2, H * 0.5, Math.max(W, H) * 0.7);
    bg.addColorStop(0, 'rgba(40, 30, 80, 0.35)');
    bg.addColorStop(1, 'rgba(0, 0, 0, 0)');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    const end = this.take.durationMs;
    const outro = Math.min(1, Math.max(0, (t - end) / 1200));
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.85 + outro * 0.4;
    c.drawImage(this.art, 0, 0);
    c.globalAlpha = 1;

    if (t <= end + 300) {
      this.drawTail(t, u);
      this.drawBursts(t, u);
      // 스틱 끝
      const pos = this.posAt(Math.min(t, end));
      const [px, py] = this.xy(pos.h, pos.e);
      const g = c.createRadialGradient(px, py, 0, px, py, 26 * u);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.25, `hsla(${this.hueAt(t)}, 100%, 75%, 0.6)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(px, py, 26 * u, 0, Math.PI * 2);
      c.fill();
    }
    this.drawText(t, outro, u);
  }

  private drawTail(t: number, u: number): void {
    const c = this.ctx;
    const TAIL = 700;
    const p = this.path;
    // t-TAIL 이후의 첫 점
    let i = this.drawnIdx;
    while (i > 0 && p[i].t > t - TAIL) i--;
    c.lineCap = 'round';
    for (; i + 1 < p.length && p[i + 1].t <= t; i++) {
      const a = p[i];
      const b = p[i + 1];
      if (b.t - a.t > 300) continue;
      const age = (t - b.t) / TAIL; // 0 = 지금
      if (age > 1) continue;
      const [x1, y1] = this.xy(a.h, a.e);
      const [x2, y2] = this.xy(b.h, b.e);
      const speed = Math.hypot(x2 - x1, y2 - y1) / Math.max(1, b.t - a.t);
      const w = (3 + Math.min(14, speed * 4)) * u * (1 - age * 0.6);
      const hue = this.hueAt(b.t);
      const fade = (1 - age) ** 1.6;
      // 넓고 옅은 빛 + 가늘고 밝은 심
      c.strokeStyle = `hsla(${hue}, 95%, 60%, ${0.18 * fade})`;
      c.lineWidth = w * 4;
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
      c.strokeStyle = `hsla(${hue}, 100%, 82%, ${0.9 * fade})`;
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
    }
  }

  private drawBursts(t: number, u: number): void {
    const c = this.ctx;
    const hits = this.take.hits;
    for (let k = this.drawnHits - 1; k >= 0; k--) {
      const x = hits[k];
      const age = (t - x.t) / 900;
      if (age < 0) continue;
      if (age > 1) break;
      const pos = this.posAt(x.t);
      const [px, py] = this.xy(pos.h, pos.e);
      const [hue, sat] = DRUM_HUE[x.cls] ?? DRUM_HUE[0];
      const power = 0.4 + (x.vel / 127) * 0.9;
      const ease = 1 - (1 - age) ** 3;
      // 번쩍 (처음 0.15초)
      if (age < 0.18) {
        const fl = 1 - age / 0.18;
        const g = c.createRadialGradient(px, py, 0, px, py, 90 * u * power);
        g.addColorStop(0, `hsla(${hue}, ${sat}%, 92%, ${0.8 * fl})`);
        g.addColorStop(1, `hsla(${hue}, ${sat}%, 60%, 0)`);
        c.fillStyle = g;
        c.beginPath();
        c.arc(px, py, 90 * u * power, 0, Math.PI * 2);
        c.fill();
      }
      // 퍼지는 고리
      c.strokeStyle = `hsla(${hue}, ${sat}%, 70%, ${0.7 * (1 - age)})`;
      c.lineWidth = 3 * u * (1 - age) + 0.5;
      c.beginPath();
      c.arc(px, py, (14 + 120 * power * ease) * u, 0, Math.PI * 2);
      c.stroke();
      // 불티
      for (const s of this.sparks[k]) {
        const la = age / s.life;
        if (la > 1) continue;
        const d = (1 - (1 - la) ** 2) * 170 * power * u;
        const sx = px + s.dx * d;
        const sy = py + s.dy * d + la * la * 40 * u; // 살짝 떨어짐
        c.fillStyle = `hsla(${hue}, ${sat}%, 80%, ${1 - la})`;
        c.beginPath();
        c.arc(sx, sy, (2.6 * (1 - la) + 0.6) * u, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  private drawText(t: number, outro: number, u: number): void {
    const c = this.ctx;
    const W = this.width;
    const H = this.height;
    c.globalCompositeOperation = 'source-over';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    const font = '"Pretendard Variable", Pretendard, system-ui, sans-serif';
    // 왼쪽 아래 작게 (연주 중)
    c.globalAlpha = 0.75 * (1 - outro);
    c.fillStyle = '#fff';
    c.font = `700 ${28 * u}px ${font}`;
    c.fillText(this.take.title, 48 * u, H - 72 * u);
    c.globalAlpha = 0.5 * (1 - outro);
    c.font = `500 ${22 * u}px ${font}`;
    c.fillText(`AIR BAND · ${this.take.date}`, 48 * u, H - 40 * u);
    // 끝: 가운데 아래 크게
    if (outro > 0) {
      c.textAlign = 'center';
      c.globalAlpha = outro;
      c.font = `800 ${52 * u}px ${font}`;
      c.fillStyle = '#fff';
      c.shadowColor = 'rgba(160, 120, 255, 0.8)';
      c.shadowBlur = 30 * u;
      c.fillText(this.take.title, W / 2, H * (H > W ? 0.86 : 0.88));
      c.shadowBlur = 0;
      c.globalAlpha = outro * 0.8;
      c.font = `600 ${28 * u}px ${font}`;
      c.fillText(`${this.take.sub}  ·  ${this.take.date}`, W / 2, H * (H > W ? 0.86 : 0.88) + 46 * u);
      c.globalAlpha = outro * 0.45;
      c.font = `700 ${20 * u}px ${font}`;
      c.fillText('A I R   B A N D', W / 2, H * (H > W ? 0.08 : 0.09));
    }
    c.globalAlpha = 1;
    void t;
  }

  /** 완성 그림 (마지막 장면) */
  finalFrame(): void {
    this.reset();
    this.render(this.take.durationMs + TrailRenderer.OUTRO_MS);
  }
}
