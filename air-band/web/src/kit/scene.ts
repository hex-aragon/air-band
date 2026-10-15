// 드럼 키트 화면: 실제 드럼 세트 모양을 그리고, 스틱 방향(모션 패킷)에 따라 화면 속 스틱이 드럼을 겨눈다.
//
// [한눈에 보기]
//   화면 좌표 = 스틱 각도. 가로는 좌우 각도(heading), 세로는 위아래 각도(elevation)를 그대로 늘린 것이다.
//   그래서 드럼을 "각도 공간"에 배치하면, 펌웨어의 구역 판정(ZONE_DEG)과 화면 속 드럼 위치가 저절로 맞는다.
//
//        위 35° 이상 ──────────  크래시
//        왼쪽 40° 이상 │ 정면 │ 오른쪽 40° 이상
//           하이햇     │스네어│    탐
//                       킥 (발 = 버튼 2 / 키 2)
//
//   매 프레임: 스틱 끝을 목표 지점으로 부드럽게 옮기고 → 뒤에서 앞 순서로 드럼을 그리고 → 스틱 → 불꽃 · 글자.
//   타격 효과: 드럼 헤드 번쩍 + 물결, 드럼 통통 튀기, 심벌 흔들림, 스틱 튕김, 불꽃, 이름 글자.
import { ZONE_DEG } from '../motion';

export const CLS = { snare: 0, kick: 1, hihat: 2, tom: 3, crash: 4 } as const;

/** 각도 공간의 드럼 배치 (도). r = 반지름, ratio = 위에서 내려다본 납작함(세로/가로) */
interface DrumSpot {
  id: string;
  cls: number;
  h: number; // + = 왼쪽
  e: number; // + = 위
  r: number;
  ratio: number;
}
// 경계(±40°, 위 35°) 사이에 여백이 생기도록 배치했다. ZONE_DEG를 바꾸면 여기 h·e도 같이 옮길 것
// 위 구역은 좌우 어디든 크래시라서 심벌을 양쪽에 하나씩 두었다 (맞으면 스틱에 가까운 쪽이 흔들림)
// 배열 순서 = 그리기 순서 (뒤 → 앞)
const SPOTS: DrumSpot[] = [
  { id: 'crash-l', cls: CLS.crash, h: 30, e: 52, r: 22, ratio: 0.34 },
  { id: 'crash-r', cls: CLS.crash, h: -36, e: 49, r: 20, ratio: 0.32 },
  { id: 'kick', cls: CLS.kick, h: 0, e: -42, r: 22, ratio: 0.97 },
  { id: 'hihat', cls: CLS.hihat, h: 64, e: 8, r: 17, ratio: 0.3 },
  { id: 'tom', cls: CLS.tom, h: -64, e: -8, r: 20, ratio: 0.42 },
  { id: 'snare', cls: CLS.snare, h: 0, e: -2, r: 18, ratio: 0.42 },
];
const spotOf = (id: string) => SPOTS.find((d) => d.id === id)!;

/** 화면에 담을 각도 범위 */
const VIEW_H = 95; // 좌우 ±
const VIEW_E_TOP = 76;
const VIEW_E_BOTTOM = -74;

const HIT_FX_MS = 900;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  hue: number;
}
interface Popup {
  text: string;
  x: number;
  y: number;
  born: number;
  hue: number;
  size: number;
}

export interface Aim {
  h: number;
  e: number;
}

/** 조준 각도 → 그 방향에서 치면 나올 드럼 (펌웨어 orientation.h zone()과 같은 규칙) */
export function zoneOfAim(a: Aim): number {
  if (a.e >= ZONE_DEG.up) return CLS.crash;
  if (a.h >= ZONE_DEG.left) return CLS.hihat;
  if (a.h <= -ZONE_DEG.right) return CLS.tom;
  return CLS.snare;
}

/** 화면 위 드럼 자리 (px) */
export interface DrumGeom {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export class KitScene {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  /** 1도 = 몇 px */
  private s = 1;
  private cx = 0;
  private cy = 0;

  /** 목표 조준 (센서 또는 포인터). null이면 쉬는 자세 */
  private aim: Aim | null = null;
  private aimZone = -1;
  /** 화면에 그려지는 스틱 끝 (목표를 부드럽게 따라감) */
  private tip = { x: 0, y: 0 };
  private tipReady = false;
  /** 버튼 · 키보드로 칠 때는 스틱이 잠깐 그 드럼으로 날아간다 */
  private snap: { spot: DrumSpot; until: number } | null = null;

  /** 드럼(spot.id)별 마지막 타격 */
  private hitAt = new Map<string, { t: number; strength: number }>();
  private stickHitAt = -Infinity;
  private stickHitStrength = 0;
  private sparks: Spark[] = [];
  private popups: Popup[] = [];
  private shakeUntil = 0;
  private shakeAmp = 0;

  showZones = false;
  /** 타격 때 드럼 이름 글자를 띄울지 (리듬 게임은 판정 글자를 따로 띄우므로 끔) */
  showNames = true;
  /** 장면 위에 덧그리기 (리듬 게임의 다가오는 링 · 판정 글자). 스틱 · 불꽃 다음에 불린다 */
  overlay: ((ctx: CanvasRenderingContext2D, now: number) => void) | null = null;
  /** 아래 안내 글 (센서 상태 등). 빈 문자열이면 안 그림 */
  hint = '';

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

  /** 조준 방향 갱신. zone은 그 방향에서 치면 나올 드럼 (센서면 보드가 판정한 값) */
  setAim(aim: Aim | null, zone = -1): void {
    this.aim = aim;
    this.aimZone = aim ? zone : -1;
  }

  /** 타격 효과. 스틱이 그 드럼을 겨누고 있지 않으면(버튼 · 키보드) 스틱이 잠깐 날아간다 */
  hit(cls: number, velocity: number): void {
    const now = performance.now();
    const strength = Math.max(0.1, Math.min(1, velocity / 127));
    const spot = this.nearestSpot(cls);
    if (!spot) return;
    this.hitAt.set(spot.id, { t: now, strength });
    if (cls === CLS.kick) {
      this.shakeUntil = now + 140;
      this.shakeAmp = 2 + 5 * strength;
    } else {
      if (this.aimZone !== cls) this.snap = { spot, until: now + 170 };
      this.stickHitAt = now;
      this.stickHitStrength = strength;
    }

    const { x, y } = this.spotXY(spot);
    const headY = cls === CLS.kick ? y : y - 2;
    const n = 6 + Math.round(strength * 12);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
      const sp = (0.25 + Math.random() * 0.55) * (0.5 + strength) * this.s * 0.9;
      this.sparks.push({ x, y: headY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, born: now, hue: this.hueOf(cls) });
    }
    if (this.sparks.length > 240) this.sparks.splice(0, this.sparks.length - 240);
    if (!this.showNames) return;
    const top = cls === CLS.kick ? y - spot.r * this.s : y - spot.r * spot.ratio * this.s - 14;
    this.popups.push({ text: this.labelOf(cls), x, y: top, born: now, hue: this.hueOf(cls), size: 14 + strength * 10 });
    if (this.popups.length > 12) this.popups.shift();
  }

  /** 그 드럼 종류의 화면 위 자리 (크래시는 2개) */
  geomAll(cls: number): DrumGeom[] {
    return SPOTS.filter((d) => d.cls === cls).map((spot) => {
      const { x, y } = this.spotXY(spot);
      const rx = spot.r * this.s;
      return { x, y, rx, ry: rx * spot.ratio };
    });
  }

  /** 화면 좌표 → 각도 (포인터 조준용) */
  toAngles(px: number, py: number): Aim {
    return { h: (this.cx - px) / this.s, e: (this.cy - py) / this.s };
  }

  /** 화면 좌표가 킥 드럼 위인지 (킥은 방향 구역이 아니라 따로 판정) */
  isOnKick(px: number, py: number): boolean {
    const spot = spotOf('kick');
    const { x, y } = this.spotXY(spot);
    const r = spot.r * this.s;
    return (px - x) ** 2 + (py - y) ** 2 <= r * r;
  }

  // -------------------------------------------------------------------------
  // 좌표
  // -------------------------------------------------------------------------
  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.s = Math.min(this.w / (VIEW_H * 2), this.h / (VIEW_E_TOP - VIEW_E_BOTTOM));
    this.cx = this.w / 2;
    this.cy = this.h / 2 + ((VIEW_E_TOP + VIEW_E_BOTTOM) / 2) * this.s;
  }
  private X(hDeg: number): number {
    return this.cx - hDeg * this.s;
  }
  private Y(eDeg: number): number {
    return this.cy - eDeg * this.s;
  }
  /** 그 드럼 종류 중 조준점에 가장 가까운 것 (크래시가 둘이라서) */
  private nearestSpot(cls: number): DrumSpot | undefined {
    // 화면 속 스틱 끝은 조준을 몇 프레임 늦게 따라가므로, 조준이 있으면 조준점으로 고른다
    const p = this.aim ? { x: this.X(this.aim.h), y: this.Y(this.aim.e) } : this.tip;
    let best: DrumSpot | undefined;
    let bestD = Infinity;
    for (const spot of SPOTS) {
      if (spot.cls !== cls) continue;
      const { x, y } = this.spotXY(spot);
      const d = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = spot;
      }
    }
    return best;
  }
  private spotXY(spot: DrumSpot): { x: number; y: number } {
    return { x: this.X(spot.h), y: this.Y(spot.e) };
  }
  /** 쉬는 자세: 스네어 위에서 살짝 숨쉬듯 */
  private restXY(now: number): { x: number; y: number } {
    const { x, y } = this.spotXY(spotOf('snare'));
    return { x: x + 6 * this.s, y: y - 9 * this.s + Math.sin(now / 600) * this.s * 1.2 };
  }

  // -------------------------------------------------------------------------
  // 프레임
  // -------------------------------------------------------------------------
  private frame = (now: number): void => {
    const { ctx, w, h } = this;
    ctx.save();
    if (now < this.shakeUntil) {
      const k = (this.shakeUntil - now) / 140;
      ctx.translate(0, Math.sin(now / 9) * this.shakeAmp * k);
    }
    this.drawStage();
    if (this.showZones) this.drawZones();

    // 스네어 스탠드는 킥 뒤로 지나가므로 킥보다 먼저 그린다
    const snare = spotOf('snare');
    this.drawStand(this.X(snare.h), this.Y(snare.e) + snare.r * this.s * 0.45);
    const aimedSpot = this.aimZone >= 0 ? this.nearestSpot(this.aimZone) : undefined;
    for (const spot of SPOTS) {
      const cls = spot.cls;
      const fx = this.fx(spot.id, now);
      const aimed = spot === aimedSpot;
      if (cls === CLS.crash) this.drawCymbal(spot, fx, aimed, now, false);
      else if (cls === CLS.hihat) this.drawCymbal(spot, fx, aimed, now, true);
      else if (cls === CLS.kick) this.drawKick(spot, fx);
      else this.drawShellDrum(spot, fx, aimed, cls === CLS.snare);
    }

    this.updateTip(now);
    this.drawStick(now);
    this.drawSparks(now);
    this.drawPopups(now);
    this.overlay?.(ctx, now);
    ctx.restore();

    if (this.hint) {
      ctx.font = `13px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      // 좁은 화면에서는 " · " 마디로 끊어 여러 줄로
      const lines: string[] = [];
      for (const part of this.hint.split(' · ')) {
        const last = lines.length - 1;
        if (last >= 0 && ctx.measureText(`${lines[last]} · ${part}`).width < w - 24) lines[last] += ` · ${part}`;
        else lines.push(part);
      }
      lines.forEach((line, i) => ctx.fillText(line, w / 2, h - 12 - (lines.length - 1 - i) * 17));
    }
    requestAnimationFrame(this.frame);
  };

  /** 타격 후 경과 (0 = 방금, 1 = 효과 끝). 효과 없으면 null */
  private fx(id: string, now: number): { t: number; strength: number; ms: number } | null {
    const hit = this.hitAt.get(id);
    if (!hit) return null;
    const ms = now - hit.t;
    if (ms > HIT_FX_MS) return null;
    return { t: ms / HIT_FX_MS, strength: hit.strength, ms };
  }

  private drawStage(): void {
    const { ctx, w, h } = this;
    const bg = ctx.createRadialGradient(w / 2, h * 0.35, 10, w / 2, h * 0.45, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#2a2f3d');
    bg.addColorStop(0.55, '#14171f');
    bg.addColorStop(1, '#07080b');
    ctx.fillStyle = bg;
    ctx.fillRect(-10, -10, w + 20, h + 20);
    // 바닥 러그
    const floorY = this.Y(-38);
    ctx.save();
    ctx.translate(w / 2, floorY + (h - floorY) * 0.55);
    ctx.scale(1, 0.32);
    const rug = ctx.createRadialGradient(0, 0, 10, 0, 0, w * 0.5);
    rug.addColorStop(0, 'rgba(120, 40, 50, 0.55)');
    rug.addColorStop(1, 'rgba(120, 40, 50, 0)');
    ctx.fillStyle = rug;
    ctx.beginPath();
    ctx.arc(0, 0, w * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 구역 경계 (펌웨어 ZONE_DEG와 같은 선). 조준이 어긋날 때 확인용 */
  private drawZones(): void {
    const { ctx, w, h } = this;
    const xL = this.X(ZONE_DEG.left);
    const xR = this.X(-ZONE_DEG.right);
    const yUp = this.Y(ZONE_DEG.up);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, yUp);
    ctx.lineTo(w, yUp);
    ctx.moveTo(xL, yUp);
    ctx.lineTo(xL, h);
    ctx.moveTo(xR, yUp);
    ctx.lineTo(xR, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`위 ${ZONE_DEG.up}°`, 8, yUp - 6);
    ctx.textAlign = 'center';
    ctx.fillText(`왼 ${ZONE_DEG.left}°`, xL, h - 30);
    ctx.fillText(`오 ${ZONE_DEG.right}°`, xR, h - 30);
    // 정면 십자
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(this.cx - 10, this.cy);
    ctx.lineTo(this.cx + 10, this.cy);
    ctx.moveTo(this.cx, this.cy - 10);
    ctx.lineTo(this.cx, this.cy + 10);
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 드럼 그리기
  // -------------------------------------------------------------------------
  private chromeStroke(x0: number, x1: number): CanvasGradient {
    const g = this.ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, '#6b717c');
    g.addColorStop(0.35, '#f4f6f8');
    g.addColorStop(0.6, '#9aa1ac');
    g.addColorStop(1, '#4b505a');
    return g;
  }

  /** 스탠드 (심벌 · 하이햇): 기둥 + 삼발이 */
  private drawStand(x: number, yTop: number): void {
    const { ctx } = this;
    const yFloor = this.Y(-64);
    ctx.strokeStyle = this.chromeStroke(x - 3, x + 3);
    ctx.lineWidth = Math.max(2, this.s * 0.45);
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yFloor);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, this.s * 0.32);
    const leg = this.s * 7;
    ctx.beginPath();
    ctx.moveTo(x, yFloor - leg * 0.6);
    ctx.lineTo(x - leg, yFloor + leg * 0.25);
    ctx.moveTo(x, yFloor - leg * 0.6);
    ctx.lineTo(x + leg, yFloor + leg * 0.25);
    ctx.moveTo(x, yFloor - leg * 0.6);
    ctx.lineTo(x + leg * 0.15, yFloor + leg * 0.45);
    ctx.stroke();
  }

  private drawShellDrum(
    spot: DrumSpot,
    fx: { t: number; strength: number; ms: number } | null,
    aimed: boolean,
    isSnare: boolean,
  ): void {
    const { ctx, s } = this;
    const { x } = this.spotXY(spot);
    let { y } = this.spotXY(spot);
    const rx = spot.r * s;
    const ry = rx * spot.ratio;
    const depth = rx * (isSnare ? 0.45 : 0.95);
    // 맞으면 통 튀기 (감쇠 진동)
    if (fx) y += Math.sin(fx.ms / 22) * Math.exp(-fx.ms / 90) * fx.strength * s * 1.1;

    // 다리 (플로어 탐). 스네어 스탠드는 frame()에서 킥보다 먼저 그린다
    if (!isSnare) {
      ctx.strokeStyle = this.chromeStroke(x - rx, x + rx);
      ctx.lineWidth = Math.max(2, s * 0.4);
      const yFloor = this.Y(-62);
      for (const k of [-0.82, 0.82, 0.25]) {
        ctx.beginPath();
        ctx.moveTo(x + rx * k, y + depth * 0.4);
        ctx.lineTo(x + rx * k * 1.12, yFloor + (k === 0.25 ? s * 2 : 0));
        ctx.stroke();
      }
    }

    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(x + s, y + depth + ry * 0.5, rx * 1.05, ry * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();

    // 통 (앞쪽 반원통)
    const shell = ctx.createLinearGradient(x - rx, 0, x + rx, 0);
    const stops = isSnare
      ? ['#4a4f58', '#c9ced6', '#ffffff', '#aab0ba', '#3c4048']
      : ['#2e0710', '#8f1a2c', '#e2667a', '#8f1a2c', '#2a060e'];
    stops.forEach((c, i) => shell.addColorStop([0, 0.3, 0.42, 0.62, 1][i], c));
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.moveTo(x - rx, y);
    ctx.lineTo(x - rx, y + depth);
    ctx.ellipse(x, y + depth, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(x + rx, y);
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI, false);
    ctx.closePath();
    ctx.fill();

    // 러그 (통의 금속 장식)
    ctx.fillStyle = this.chromeStroke(x - rx, x + rx);
    const lugH = depth * (isSnare ? 0.5 : 0.3);
    for (const deg of [18, 50, 90, 130, 162]) {
      const a = (deg * Math.PI) / 180;
      const lx = x + Math.cos(a) * rx * 0.97;
      const ly = y + Math.sin(a) * ry + depth * 0.5 - lugH / 2;
      const lw = Math.max(2, s * 0.9 * Math.sin(a));
      ctx.fillRect(lx - lw / 2, ly, lw, lugH);
    }

    // 아래 테두리
    ctx.strokeStyle = this.chromeStroke(x - rx, x + rx);
    ctx.lineWidth = Math.max(1.5, s * 0.35);
    ctx.beginPath();
    ctx.ellipse(x, y + depth, rx, ry, 0, 0, Math.PI);
    ctx.stroke();

    this.drawHead(x, y, rx, ry, fx, spot.cls, aimed);
  }

  /** 드럼 헤드 (가죽) + 테두리 + 타격 번쩍 · 물결 + 조준 표시 */
  private drawHead(
    x: number,
    y: number,
    rx: number,
    ry: number,
    fx: { t: number; strength: number; ms: number } | null,
    cls: number,
    aimed: boolean,
  ): void {
    const { ctx, s } = this;
    const head = ctx.createRadialGradient(x - rx * 0.3, y - ry * 0.4, rx * 0.05, x, y, rx);
    head.addColorStop(0, '#fbf8f0');
    head.addColorStop(1, '#cfc7b5');
    ctx.fillStyle = head;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // 가운데 점 (드럼을 치는 자리)
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 0.22, ry * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    const hue = this.hueOf(cls);
    if (fx) {
      const a = (1 - fx.t) ** 2 * (0.35 + 0.5 * fx.strength);
      ctx.fillStyle = `hsla(${hue}, 90%, 70%, ${a})`;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      // 물결 2겹
      for (const lag of [0, 0.18]) {
        const tt = fx.t * 1.6 - lag;
        if (tt <= 0 || tt >= 1) continue;
        ctx.strokeStyle = `hsla(${hue}, 90%, 45%, ${(1 - tt) * 0.8})`;
        ctx.lineWidth = 1 + 3 * fx.strength * (1 - tt);
        ctx.beginPath();
        ctx.ellipse(x, y, rx * tt, ry * tt, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 테두리 (후프)
    ctx.strokeStyle = this.chromeStroke(x - rx, x + rx);
    ctx.lineWidth = Math.max(2.5, s * 0.6);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (aimed) this.drawAimRing(x, y, rx, ry, hue);
  }

  private drawAimRing(x: number, y: number, rx: number, ry: number, hue: number): void {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 140);
    ctx.save();
    ctx.shadowColor = `hsl(${hue}, 90%, 60%)`;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = `hsla(${hue}, 90%, 62%, ${0.55 + 0.35 * pulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y, rx + 6, ry + 6 * Math.max(0.4, ry / rx), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawCymbal(
    spot: DrumSpot,
    fx: { t: number; strength: number; ms: number } | null,
    aimed: boolean,
    now: number,
    isHihat: boolean,
  ): void {
    const { ctx, s } = this;
    const { x, y } = this.spotXY(spot);
    const rx = spot.r * s;
    let ratio = spot.ratio;
    let tilt = isHihat ? 0 : -0.12;
    // 맞으면 흔들림: 기울기와 납작함이 진동하며 줄어든다 (하이햇은 짧게)
    if (fx) {
      const decay = Math.exp(-fx.ms / (isHihat ? 110 : 320));
      tilt += Math.sin(fx.ms / 32) * 0.16 * fx.strength * decay;
      ratio += Math.sin(fx.ms / 26 + 1) * 0.12 * fx.strength * decay;
    }
    // 크래시는 가만히 있어도 아주 살짝 흔들린다
    if (!isHihat) tilt += Math.sin(now / 900) * 0.01;
    const ry = rx * ratio;
    const gap = isHihat ? Math.max(3, s * (fx && fx.ms < 60 ? 0.3 : 1.2)) : 0;

    this.drawStand(x, y + gap);
    if (isHihat) this.drawCymbalDisc(x, y + gap, rx, ry, 0, 0.75);
    this.drawCymbalDisc(x, y, rx, ry, tilt, 1);

    if (fx) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(tilt);
      const a = (1 - fx.t) ** 2 * (0.3 + 0.55 * fx.strength);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * (1 + fx.t * 0.5));
      glow.addColorStop(0, `rgba(255, 244, 210, ${a})`);
      glow.addColorStop(1, 'rgba(255, 220, 150, 0)');
      ctx.fillStyle = glow;
      ctx.scale(1, ratio * 1.6);
      ctx.beginPath();
      ctx.arc(0, 0, rx * (1 + fx.t * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (aimed) this.drawAimRing(x, y, rx, ry, this.hueOf(spot.cls));
  }

  /** 심벌 한 장: 청동 그라데이션 + 선반 무늬 + 가운데 볼록한 벨 */
  private drawCymbalDisc(x: number, y: number, rx: number, ry: number, tilt: number, light: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    const g = ctx.createLinearGradient(-rx, -ry, rx, ry);
    g.addColorStop(0, `rgb(${120 * light}, ${78 * light}, ${24 * light})`);
    g.addColorStop(0.45, `rgb(${236 * light}, ${190 * light}, ${96 * light})`);
    g.addColorStop(0.55, `rgb(${250 * light}, ${222 * light}, ${150 * light})`);
    g.addColorStop(1, `rgb(${110 * light}, ${70 * light}, ${20 * light})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70, 40, 5, 0.22)';
    ctx.lineWidth = 1;
    for (let k = 0.3; k < 1; k += 0.12) {
      ctx.beginPath();
      ctx.ellipse(0, 0, rx * k, ry * k, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(60, 35, 5, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 벨
    ctx.fillStyle = `rgb(${226 * light}, ${178 * light}, ${84 * light})`;
    ctx.beginPath();
    ctx.ellipse(0, -ry * 0.12, rx * 0.2, ry * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3b3f46';
    ctx.beginPath();
    ctx.ellipse(0, -ry * 0.16, rx * 0.04, ry * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 킥: 연주자 쪽을 향한 큰 북 + 페달 비터 */
  private drawKick(spot: DrumSpot, fx: { t: number; strength: number; ms: number } | null): void {
    const { ctx, s } = this;
    const { x, y } = this.spotXY(spot);
    const r = spot.r * s;
    const ry = r * spot.ratio;
    // 통 옆면 (살짝 보이는 깊이)
    ctx.fillStyle = '#4a0c18';
    ctx.beginPath();
    ctx.ellipse(x, y - r * 0.08, r * 0.98, ry * 0.98, 0, 0, Math.PI * 2);
    ctx.fill();
    // 헤드
    const head = ctx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
    head.addColorStop(0, '#f6f2e8');
    head.addColorStop(1, '#c9c1ad');
    ctx.fillStyle = head;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.92, ry * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();
    // 로고
    ctx.fillStyle = 'rgba(143, 26, 44, 0.75)';
    ctx.font = `700 ${Math.round(r * 0.22)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('AIR BAND', x, y + r * 0.08);
    if (fx) {
      const a = (1 - fx.t) ** 2 * (0.3 + 0.5 * fx.strength);
      ctx.fillStyle = `hsla(${this.hueOf(CLS.kick)}, 90%, 70%, ${a})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.92, ry * 0.92, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // 나무 후프 + 클로
    ctx.strokeStyle = '#8f1a2c';
    ctx.lineWidth = Math.max(4, r * 0.09);
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.96, ry * 0.96, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = this.chromeStroke(x - r, x + r);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r * 0.96, y + Math.sin(a) * ry * 0.96, Math.max(2, r * 0.04), 0, Math.PI * 2);
      ctx.fill();
    }
    // 비터: 칠 때 헤드 쪽으로 (위로) 올라붙는다
    const swing = fx ? Math.max(0, 1 - fx.ms / 120) : 0;
    const bx = x;
    const by = y + r * (0.55 - 0.3 * swing);
    const pivotY = y + r * 1.25;
    ctx.strokeStyle = this.chromeStroke(bx - 3, bx + 3);
    ctx.lineWidth = Math.max(2, s * 0.35);
    ctx.beginPath();
    ctx.moveTo(bx, pivotY);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.fillStyle = '#e9e6df';
    ctx.beginPath();
    ctx.ellipse(bx, by, r * (0.11 + 0.03 * swing), r * (0.09 + 0.03 * swing), 0, 0, Math.PI * 2);
    ctx.fill();
    // 페달 발판
    ctx.fillStyle = '#2b2f37';
    ctx.beginPath();
    ctx.moveTo(bx - r * 0.12, pivotY);
    ctx.lineTo(bx + r * 0.12, pivotY);
    ctx.lineTo(bx + r * 0.16, pivotY + r * (0.5 - 0.08 * swing));
    ctx.lineTo(bx - r * 0.16, pivotY + r * (0.5 - 0.08 * swing));
    ctx.closePath();
    ctx.fill();
  }

  // -------------------------------------------------------------------------
  // 스틱
  // -------------------------------------------------------------------------
  private updateTip(now: number): void {
    let target: { x: number; y: number };
    let follow = 0.45; // 프레임당 따라가는 비율 (센서 25Hz 계단을 부드럽게, 지연은 1~2프레임)
    if (this.snap && now < this.snap.until) {
      target = this.spotXY(this.snap.spot);
      follow = 0.7;
    } else {
      this.snap = null;
      target = this.aim ? { x: this.X(this.aim.h), y: this.Y(this.aim.e) } : this.restXY(now);
      // 화면 밖 각도는 가장자리에 붙인다
      target.x = Math.max(8, Math.min(this.w - 8, target.x));
      target.y = Math.max(8, Math.min(this.h - 8, target.y));
    }
    if (!this.tipReady) {
      this.tip = { ...target };
      this.tipReady = true;
    }
    this.tip.x += (target.x - this.tip.x) * follow;
    this.tip.y += (target.y - this.tip.y) * follow;
  }

  private drawStick(now: number): void {
    const { ctx, s } = this;
    // 손 위치: 화면 아래 오른쪽 (오른손 스틱)
    const hx = this.w / 2 + Math.min(this.w * 0.24, s * 40);
    const hy = this.h + s * 6;
    let tx = this.tip.x;
    let ty = this.tip.y;
    // 타격 순간: 끝이 헤드로 살짝 눌렸다가 튀어 오른다
    const ms = now - this.stickHitAt;
    if (ms < 220) {
      const k = ms < 45 ? ms / 45 : 1 - (ms - 45) / 175;
      const down = ms < 45 ? 1 : -0.6 * Math.sin(((ms - 45) / 175) * Math.PI);
      ty += down * k * s * 3.5 * (0.4 + this.stickHitStrength);
    }
    const dx = tx - hx;
    const dy = ty - hy;
    const len = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    const wButt = Math.max(9, s * 2.4);
    const wTip = Math.max(4, s * 0.9);

    const shape = () => {
      ctx.beginPath();
      ctx.moveTo(0, -wButt / 2);
      ctx.lineTo(len - wTip * 2, -wTip / 2);
      ctx.lineTo(len - wTip * 2, wTip / 2);
      ctx.lineTo(0, wButt / 2);
      ctx.closePath();
    };

    ctx.save();
    // 그림자
    ctx.translate(hx + s * 2.5, hy + s * 3);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    shape();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(ang);
    const wood = ctx.createLinearGradient(0, -wButt / 2, 0, wButt / 2);
    wood.addColorStop(0, '#8a5a2b');
    wood.addColorStop(0.35, '#f0cf98');
    wood.addColorStop(1, '#9a6834');
    ctx.fillStyle = wood;
    shape();
    ctx.fill();
    // 손잡이 테이프
    ctx.fillStyle = 'rgba(25, 25, 30, 0.85)';
    ctx.fillRect(0, -wButt / 2, len * 0.22, wButt);
    // 팁 (구슬 모양)
    ctx.fillStyle = '#f6dfb2';
    ctx.beginPath();
    ctx.ellipse(len - wTip * 1.3, 0, wTip * 1.4, wTip * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 조준점 (스틱 끝이 가리키는 곳)
    if (this.aimZone >= 0) {
      ctx.fillStyle = `hsla(${this.hueOf(this.aimZone)}, 90%, 65%, 0.9)`;
      ctx.beginPath();
      ctx.arc(this.tip.x, this.tip.y, Math.max(3, s * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSparks(now: number): void {
    const { ctx } = this;
    const LIFE = 480;
    this.sparks = this.sparks.filter((p) => now - p.born < LIFE);
    for (const p of this.sparks) {
      const t = (now - p.born) / 16.7; // 프레임 단위
      const x = p.x + p.vx * t;
      const y = p.y + p.vy * t + 0.04 * this.s * t * t;
      const a = 1 - (now - p.born) / LIFE;
      ctx.strokeStyle = `hsla(${p.hue}, 95%, 70%, ${a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - p.vx * 2, y - p.vy * 2);
      ctx.stroke();
    }
  }

  private drawPopups(now: number): void {
    const { ctx } = this;
    const LIFE = 650;
    this.popups = this.popups.filter((p) => now - p.born < LIFE);
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      const t = (now - p.born) / LIFE;
      ctx.font = `700 ${p.size}px system-ui, sans-serif`;
      ctx.fillStyle = `hsla(${p.hue}, 90%, 72%, ${1 - t})`;
      ctx.fillText(p.text, p.x, p.y - t * 28);
    }
  }
}
