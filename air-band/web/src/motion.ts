// 스틱 방향 화면 (2단계): 보드가 25Hz로 보내는 모션 패킷을 받아 "지금 어디를 가리키는지" 그린다.

// [한눈에 보기]
//   가로 = 좌우 각도(왼쪽이 화면 왼쪽), 세로 = 위아래 각도. 가운데(0, 0)가 "정면 맞추기" 한 방향이다.
//   배경에 드럼 구역 4개(하이햇 · 스네어 · 탐 · 위쪽 크래시)를 칠하고, 스틱 방향을 점과 꼬리로 그린다.
//   어느 구역인지는 보드가 판정해서 보내 준 값(zone)을 그대로 쓴다. 화면의 경계선은 보기용이라
//   펌웨어 상수(ZONE_LEFT_DEG 등)를 바꾸면 아래 ZONE_DEG도 같이 바꿔야 그림이 맞는다.
import type { MotionEvent } from './ble';

/**
 * 드럼 간격 3단계 — 펌웨어 ZONE_PRESETS와 같은 값. 연결할 때 명령 '1' · '2' · '3'으로 보드에 알린다 (ui/header.ts).
 * 좌우 이 각도 이상 → 하이햇 / 탐, 위로 이 각도 이상 → 크래시
 */
export type ZoneWidth = 1 | 2 | 3;
export const ZONE_PRESETS: Record<ZoneWidth, { side: number; up: number; label: string }> = {
  1: { side: 25, up: 25, label: '좁게' },
  2: { side: 40, up: 35, label: '보통' },
  3: { side: 55, up: 45, label: '넓게' },
};
const ZONE_KEY = 'airband.zoneWidth';
function loadZoneWidth(): ZoneWidth {
  try {
    const v = Number(localStorage.getItem(ZONE_KEY));
    return v === 1 || v === 2 || v === 3 ? v : 3;
  } catch {
    return 3;
  }
}
let zoneWidth: ZoneWidth = loadZoneWidth();
/** 지금 구역 경계 (도). 값은 setZoneWidth()로만 바뀐다 — 그림 · 폰 모드 · 마우스 판정이 모두 이 객체를 읽는다 */
export const ZONE_DEG = { left: ZONE_PRESETS[zoneWidth].side, right: ZONE_PRESETS[zoneWidth].side, up: ZONE_PRESETS[zoneWidth].up };
const zoneListeners: (() => void)[] = [];
export const getZoneWidth = () => zoneWidth;
export function setZoneWidth(w: ZoneWidth): void {
  zoneWidth = w;
  ZONE_DEG.left = ZONE_DEG.right = ZONE_PRESETS[w].side;
  ZONE_DEG.up = ZONE_PRESETS[w].up;
  try {
    localStorage.setItem(ZONE_KEY, String(w));
  } catch {
    // 저장 불가 — 이번 방문만
  }
  for (const f of zoneListeners) f();
}
export function onZoneChange(f: () => void): void {
  zoneListeners.push(f);
}
/** 펌웨어 HIT_THRESHOLD_G — 가속도 막대에 기준선으로 표시 */
const HIT_THRESHOLD_G = 2.5;
const ACCEL_MAX_G = 16;

/** 화면 범위 (도) */
const H_RANGE = 90;
const E_MIN = -60;
const E_MAX = 60;
const TRAIL_MS = 600;

interface TrailPoint {
  h: number;
  e: number;
  t: number;
}

export class MotionView {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private last: MotionEvent | null = null;
  private trail: TrailPoint[] = [];
  private flashZone = -1;
  private flashUntil = 0;

  /**
   * @param hueOf 드럼 클래스 → 색상(hue). 패드 · 물결과 같은 색을 쓰려고 밖에서 받는다
   * @param labelOf 드럼 클래스 → 표시 이름
   */
  constructor(
    private canvas: HTMLCanvasElement,
    private hueOf: (cls: number) => number,
    private labelOf: (cls: number) => string,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    requestAnimationFrame(this.frame);
  }

  update(m: MotionEvent): void {
    this.last = m;
    this.trail.push({ h: m.headingDeg, e: m.elevationDeg, t: m.receivedAt });
    while (this.trail.length && m.receivedAt - this.trail[0].t > TRAIL_MS) this.trail.shift();
  }

  /** 타격이 들어오면 그 구역을 잠깐 밝힌다 */
  hit(cls: number): void {
    this.flashZone = cls;
    this.flashUntil = performance.now() + 150;
  }

  /** 최근 모션을 받은 지 얼마나 됐는지 (ms). 받은 적 없으면 Infinity */
  age(now = performance.now()): number {
    return this.last ? now - this.last.receivedAt : Infinity;
  }

  clear(): void {
    this.last = null;
    this.trail = [];
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 각도 → 화면 좌표. 왼쪽(+heading)이 화면 왼쪽으로 오도록 부호를 뒤집는다.
  // 오른쪽 46px은 가속도 막대 자리
  private plotW(): number {
    return this.w - 46;
  }
  private x(hDeg: number): number {
    const c = Math.max(-H_RANGE, Math.min(H_RANGE, hDeg));
    return ((H_RANGE - c) / (2 * H_RANGE)) * this.plotW();
  }
  private y(eDeg: number): number {
    const c = Math.max(E_MIN, Math.min(E_MAX, eDeg));
    return ((E_MAX - c) / (E_MAX - E_MIN)) * this.h;
  }

  private frame = (now: number): void => {
    const { ctx, w, h } = this;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const text = dark ? '#e8eaef' : '#16181d';
    const dim = dark ? '#8b93a1' : '#6b7280';
    ctx.clearRect(0, 0, w, h);

    const pw = this.plotW();
    const active = this.last && this.age(now) < 1000 ? this.last.zone : -1;
    const flash = now < this.flashUntil ? this.flashZone : -1;

    // 구역 칠하기: 크래시(위 띠) → 하이햇(왼쪽) · 스네어(가운데) · 탐(오른쪽)
    const yUp = this.y(ZONE_DEG.up);
    const xL = this.x(ZONE_DEG.left);
    const xR = this.x(-ZONE_DEG.right);
    const regions: [number, number, number, number, number][] = [
      [4, 0, 0, pw, yUp],
      [2, 0, yUp, xL, h - yUp],
      [0, xL, yUp, xR - xL, h - yUp],
      [3, xR, yUp, pw - xR, h - yUp],
    ];
    for (const [cls, rx, ry, rw, rh] of regions) {
      const hue = this.hueOf(cls);
      const a = cls === flash ? 0.5 : cls === active ? 0.24 : 0.07;
      ctx.fillStyle = `hsla(${hue}, 75%, 50%, ${a})`;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.fillStyle = cls === active ? text : dim;
      ctx.font = `${cls === active ? 600 : 400} 13px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(this.labelOf(cls), rx + rw / 2, ry + 18);
    }

    // 정면 십자선
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.x(0), 0);
    ctx.lineTo(this.x(0), h);
    ctx.moveTo(0, this.y(0));
    ctx.lineTo(pw, this.y(0));
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.last) {
      const stale = this.age(now) > 1000;
      // 꼬리: 최근 0.6초 경로
      for (let i = 1; i < this.trail.length; i++) {
        const p0 = this.trail[i - 1];
        const p1 = this.trail[i];
        ctx.strokeStyle = `hsla(${this.hueOf(this.last.zone)}, 80%, ${dark ? 65 : 45}%, ${(i / this.trail.length) * 0.6})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(this.x(p0.h), this.y(p0.e));
        ctx.lineTo(this.x(p1.h), this.y(p1.e));
        ctx.stroke();
      }
      // 현재 방향 점
      const px = this.x(this.last.headingDeg);
      const py = this.y(this.last.elevationDeg);
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fillStyle = stale ? dim : `hsl(${this.hueOf(this.last.zone)}, 80%, ${dark ? 65 : 45}%)`;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = dark ? '#0f1115' : '#fff';
      ctx.stroke();

      // 숫자: 좌우 · 위아래 각도
      ctx.fillStyle = dim;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      const lr = this.last.headingDeg >= 0 ? `왼쪽 ${this.last.headingDeg.toFixed(0)}°` : `오른쪽 ${(-this.last.headingDeg).toFixed(0)}°`;
      const ud = this.last.elevationDeg >= 0 ? `위 ${this.last.elevationDeg.toFixed(0)}°` : `아래 ${(-this.last.elevationDeg).toFixed(0)}°`;
      ctx.fillText(`${lr} · ${ud}${stale ? ' (수신 없음)' : ''}`, 8, h - 8);
    } else {
      ctx.fillStyle = dim;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('센서를 연결하면 스틱 방향이 표시됩니다', pw / 2, h / 2 + 4);
    }

    this.drawAccelBar(dark, dim);
    requestAnimationFrame(this.frame);
  };

  // 오른쪽 세로 막대: 가속도 크기. 타격 임계값(2.5g)에 선을 그어 튜닝할 때 참고한다
  private drawAccelBar(dark: boolean, dim: string): void {
    const { ctx, h } = this;
    const x = this.w - 30;
    const top = 22;
    const bh = h - top - 22;
    ctx.fillStyle = dark ? '#262a33' : '#e3e5ea';
    ctx.fillRect(x, top, 14, bh);
    const g = this.last && this.age() < 1000 ? this.last.accelG : 0;
    const frac = Math.min(1, g / ACCEL_MAX_G);
    ctx.fillStyle = g >= HIT_THRESHOLD_G ? (dark ? '#fbbf24' : '#d97706') : dark ? '#60a5fa' : '#2563eb';
    ctx.fillRect(x, top + bh * (1 - frac), 14, bh * frac);
    const ty = top + bh * (1 - HIT_THRESHOLD_G / ACCEL_MAX_G);
    ctx.strokeStyle = dark ? '#fbbf24' : '#b45309';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, ty);
    ctx.lineTo(x + 18, ty);
    ctx.stroke();
    ctx.fillStyle = dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${g.toFixed(1)}g`, x + 7, top - 8);
  }
}
