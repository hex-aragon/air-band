// 지휘 박(ictus) 감지 — 펌웨어 firmware/air_band_right/ictus.h와 같은 규칙 (폰 단독 모드가 쓴다)
//
// 두 가지 신호 중 하나만 잡혀도 박이다 (초보자도 쉽게 잡히도록)
//   ① 위아래: 지휘봉 끝의 위아래 각도가 내려가다 위로 돌아서는 바닥점 (꼭대기 → 바닥이 minDropDeg 이상)
//   ② 툭 멈춤: 박을 찍는 순간 손목이 멈췄다 튀어 오르며 생기는 순간 가속도(중력 뺀 값)의 봉우리 → 센서 방향과 상관없음
//   같은 박을 두 신호가 거의 동시에 잡으므로 박 사이 최소 간격 안의 두 번째는 버린다.
//   박 크기(셈여림) = 위아래 폭 · 좌우 폭 · 가속도×40 중 가장 큰 것 (도).

export interface IctusConfig {
  /** 이보다 빠르게 내려가야 "내려치는 중" (°/s) */
  downDps: number;
  /** 꼭대기 → 바닥이 이보다 작으면 손 떨림으로 보고 무시 (도) */
  minDropDeg: number;
  /** 툭 멈춤: 움직임 가속도 봉우리가 이 이상이면 박 (g) */
  minAccG: number;
  /** 박 사이 최소 간격 (ms) */
  minGapMs: number;
  /** 각도 · 속도 평활 계수 (0~1) */
  velAlpha: number;
}

export const ICTUS_DEFAULT: IctusConfig = { downDps: 12, minDropDeg: 2.5, minAccG: 0.22, minGapMs: 220, velAlpha: 0.35 };

export interface Ictus {
  /** 박 시각 (입력과 같은 시간축, ms) */
  ms: number;
  /** 박 크기 (도) */
  size: number;
}

export class IctusDetector {
  private started = false;
  private descending = false;
  private prevMs = 0;
  private prevE = 0;
  private vel = 0;
  private maxE = 0;
  private minE = 0;
  private minMs = 0;
  private maxH = 0;
  private minH = 0;
  private maxA = 0;
  private a1 = 0;
  private a2 = 0;
  private a1Ms = 0;
  private lastBeatMs = 0;

  constructor(private cfg: IctusConfig = ICTUS_DEFAULT) {}

  reset(): void {
    this.started = false;
  }

  /** 새 샘플. linAccG = 움직임 가속도 크기(중력 뺀 값, g). 박이면 Ictus, 아니면 null */
  update(ms: number, elevDeg: number, headingDeg: number, linAccG = 0): Ictus | null {
    if (!this.started) {
      this.started = true;
      this.prevMs = ms;
      this.prevE = elevDeg;
      this.vel = 0;
      this.descending = false;
      this.a1 = this.a2 = 0;
      this.a1Ms = ms;
      this.resetRange(ms, elevDeg, headingDeg);
      this.lastBeatMs = ms - this.cfg.minGapMs;
      return null;
    }
    const dt = (ms - this.prevMs) / 1000;
    if (dt <= 0) return null;
    // 손 떨림을 줄이려고 각도 자체도 평활한 값으로 속도 · 꼭대기 · 바닥을 잰다
    const e = this.prevE + this.cfg.velAlpha * (elevDeg - this.prevE);
    this.vel += this.cfg.velAlpha * ((e - this.prevE) / dt - this.vel);
    this.prevMs = ms;
    this.prevE = e;

    if (e > this.maxE) this.maxE = e;
    if (e < this.minE) {
      this.minE = e;
      this.minMs = ms;
    }
    if (headingDeg > this.maxH) this.maxH = headingDeg;
    if (headingDeg < this.minH) this.minH = headingDeg;
    if (linAccG > this.maxA) this.maxA = linAccG;

    let beat = false;
    let at = ms;
    // ② 툭 멈춤: 가속도 봉우리
    const a0 = this.a1 + 0.5 * (linAccG - this.a1);
    if (this.a1 >= this.cfg.minAccG && this.a1 > this.a2 && this.a1 >= a0) {
      beat = true;
      at = this.a1Ms;
    }
    this.a2 = this.a1;
    this.a1 = a0;
    this.a1Ms = ms;

    // ① 위아래: 내려가다 위로 돌아선 바닥점
    if (this.vel < -this.cfg.downDps) this.descending = true;
    if (this.descending && this.vel > 0) {
      this.descending = false;
      if (this.maxE - this.minE >= this.cfg.minDropDeg && !beat) {
        beat = true;
        at = this.minMs;
      }
    }

    if (!beat || at - this.lastBeatMs < this.cfg.minGapMs) return null;
    const size = Math.max(this.maxE - this.minE, this.maxH - this.minH, this.maxA * 40);
    this.lastBeatMs = at;
    this.descending = false;
    this.resetRange(ms, e, headingDeg);
    return { ms: at, size };
  }

  private resetRange(ms: number, e: number, h: number): void {
    this.maxE = this.minE = e;
    this.minMs = ms;
    this.maxH = this.minH = h;
    this.maxA = 0;
  }
}
