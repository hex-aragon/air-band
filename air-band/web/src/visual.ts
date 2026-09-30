// Canvas 타격 이펙트: 타격마다 원이 퍼지며 사라진다. 크기/밝기는 velocity에 비례.

// [설명] Canvas 2D 애니메이션 원리
//   requestAnimationFrame(frame) : 화면이 새로 그려질 때마다(보통 1초에 60번) frame()을 불러 달라는 요청.
//   frame()은 매번 캔버스를 지우고, 살아 있는 물결(ripple)을 "태어난 뒤 경과 시간"에 맞는 크기·투명도로 다시 그린다.
//   0.7초가 지난 물결은 목록에서 지운다.
//   devicePixelRatio : 고해상도 화면(레티나 등)에서 흐릿하지 않게 캔버스 실제 픽셀 수를 늘리는 값.
interface Ripple {
  x: number;
  y: number;
  born: number; // performance.now
  strength: number; // 0~1
  hue: number;
}

const RIPPLE_LIFE_MS = 700;

export class HitVisualizer {
  private ctx: CanvasRenderingContext2D;
  private ripples: Ripple[] = [];
  private flashUntil = 0;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    // 창 크기뿐 아니라 주변 레이아웃(패드 추가 등)으로 캔버스 크기가 바뀌어도 다시 맞춘다
    new ResizeObserver(() => this.resize()).observe(canvas);
    requestAnimationFrame(this.frame);
  }

  /** 타격 추가. 드럼 종류(cls)별로 가로 위치와 색을 나눈다 */
  hit(velocity: number, cls = 0, classCount = 1): void {
    const strength = Math.max(0.05, Math.min(1, velocity / 127));
    // 약간 흩뿌려서 연타가 겹쳐 보이지 않게
    const jitter = () => (Math.random() - 0.5) * 0.15;
    const col = (cls % classCount + 0.5) / classCount;
    this.ripples.push({
      x: this.w * (col + jitter() / classCount),
      y: this.h * (0.5 + jitter()),
      born: performance.now(),
      strength,
      hue: (200 + cls * 70) % 360,
    });
    this.flashUntil = performance.now() + 60;
    if (this.ripples.length > 40) this.ripples.shift();
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

  private frame = (now: number): void => {
    const { ctx, w, h } = this;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    ctx.clearRect(0, 0, w, h);
    if (now < this.flashUntil) {
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
      ctx.fillRect(0, 0, w, h);
    }

    const maxR = Math.min(w, h) * 0.45;
    this.ripples = this.ripples.filter((r) => now - r.born < RIPPLE_LIFE_MS);
    for (const r of this.ripples) {
      const t = (now - r.born) / RIPPLE_LIFE_MS; // 0 → 1
      const ease = 1 - Math.pow(1 - t, 3);
      const radius = 12 + ease * maxR * (0.35 + 0.65 * r.strength);
      const alpha = (1 - t) * (0.35 + 0.65 * r.strength);

      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.lineWidth = 2 + 10 * r.strength * (1 - t);
      ctx.strokeStyle = `hsla(${r.hue}, 85%, ${dark ? 65 : 45}%, ${alpha})`;
      ctx.stroke();

      if (t < 0.25) {
        ctx.beginPath();
        ctx.arc(r.x, r.y, 10 + 30 * r.strength * (1 - t * 4), 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${r.hue}, 85%, ${dark ? 65 : 50}%, ${alpha * 0.6})`;
        ctx.fill();
      }
    }

    requestAnimationFrame(this.frame);
  };
}
