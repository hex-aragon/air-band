// 지휘 템포 따라가기 — 박(ictus)이 올 때마다 "악보의 어느 박을 지금 연주해야 하는지"를 다시 맞춘다
//
// [한눈에 보기]
//   악보 위치(박) = 기준 박 + (지금 - 기준 시각) × 속도
//   ① 준비: 박 두 번 → 간격 = 템포. 세 번째 박이 올 시각에 1박째를 시작한다 (오케스트라가 준비 박을 보고 들어가듯)
//   ② 연주 중 박이 오면: 가장 가까운 박(k)에 맞춘 것으로 보고, "다음 박(k+1)에 정확히 닿도록" 속도를 고친다
//      → 지휘가 빨라지면 따라 빨라지고, 늦어지면 기다리듯 느려진다. 위치는 튀지 않고 이어진다
//   ③ 지휘를 멈추면(박 간격의 2배 넘게 안 옴) 그 자리에서 멈춰 기다린다. 다시 박이 오면 이어서 연주
//
//   시간 단위는 초(AudioContext.currentTime). 순수 계산이라 소리 없이 시험할 수 있다.

export type FollowState = 'waiting' | 'playing' | 'holding' | 'done';

/** 재생기가 쓰는 시계: 지휘를 따라가는 TempoFollower, 또는 연습용 고정 템포(FixedTempo) */
export interface Clock {
  state: FollowState;
  /** 지금 템포 (초/박) */
  spb: number;
  /** t초에 연주해야 할 악보 위치 (박). 시작 전이면 음수 */
  beatAt(t: number): number;
  /** 악보 위치 beat가 연주될 시각 */
  timeOf(beat: number): number;
  tick(now: number): void;
}

const MIN_SPB = 60 / 200; // 200 BPM
const MAX_SPB = 60 / 40; // 40 BPM
const clampSpb = (s: number) => Math.min(MAX_SPB, Math.max(MIN_SPB, s));
/** 박 간격 평활: 새 간격을 이만큼 반영 (클수록 즉각 반응, 작을수록 안정) */
const TEMPO_FOLLOW = 0.5;
/** 한 박 안에서 속도를 고치는 한계 (지금 템포의 배수) */
const RATE_MIN = 0.5;
const RATE_MAX = 1.8;
/** 박 간격의 이 배수 동안 박이 없으면 멈춰 기다린다 */
const HOLD_AFTER = 2.2;

export class TempoFollower implements Clock {
  state: FollowState = 'waiting';
  /** 지금 템포 (초/박) */
  spb: number;
  private anchorBeat = 0;
  private anchorTime = 0;
  private rate = 0; // 박/초
  private prep: number[] = [];
  private lastIctusTime = -Infinity;
  /** 박마다 기록 (분석 · 화면용): 시각, 그때 악보 위치, 템포 */
  readonly log: { t: number; beat: number; bpm: number }[] = [];

  constructor(
    private lengthBeats: number,
    defaultBpm: number,
  ) {
    this.spb = 60 / defaultBpm;
  }

  get bpm(): number {
    return 60 / this.spb;
  }

  /** 준비 박을 몇 번 받았는지 (화면 안내용) */
  get prepCount(): number {
    return this.prep.length;
  }

  /** t초에 연주해야 할 악보 위치 (박). 시작 전이면 음수 */
  beatAt(t: number): number {
    if (this.state === 'waiting') return -Infinity;
    const b = this.anchorBeat + (t - this.anchorTime) * this.rate;
    return Math.min(b, this.lengthBeats);
  }

  /** 악보 위치 beat가 연주될 시각 (지금 속도 기준). 멈춘 상태면 Infinity */
  timeOf(beat: number): number {
    if (this.rate <= 0) return Infinity;
    return this.anchorTime + (beat - this.anchorBeat) / this.rate;
  }

  onIctus(t: number): void {
    if (this.state === 'done') return;
    if (this.state === 'waiting') {
      this.prep.push(t);
      if (this.prep.length > 2) this.prep.shift();
      if (this.prep.length === 2) {
        const gap = this.prep[1] - this.prep[0];
        if (gap < MIN_SPB || gap > MAX_SPB) {
          this.prep = [t]; // 너무 빠르거나 느림 → 이번 박부터 다시 준비
          return;
        }
        this.spb = gap;
        this.rate = 1 / gap;
        this.anchorBeat = 0;
        this.anchorTime = t + gap;
        this.state = 'playing';
        this.lastIctusTime = t;
        this.log.push({ t, beat: -1, bpm: this.bpm });
      }
      return;
    }

    const b = this.beatAt(t);
    if (this.state === 'holding') {
      // 기다리던 자리에서 이어서 — 이 박부터 지금 템포로
      this.anchorBeat = b;
      this.anchorTime = t;
      this.rate = 1 / this.spb;
      this.state = 'playing';
      this.lastIctusTime = t;
      this.log.push({ t, beat: b, bpm: this.bpm });
      return;
    }

    const gap = t - this.lastIctusTime;
    if (gap >= MIN_SPB * 0.8 && gap <= MAX_SPB) this.spb = clampSpb(this.spb + TEMPO_FOLLOW * (gap - this.spb));
    // 시작 직후 1박째 전에 온 박은 1박째로 본다
    const k = Math.max(0, Math.round(b));
    const target = k + 1;
    let rate = (target - b) / this.spb;
    rate = Math.min(RATE_MAX / this.spb, Math.max(RATE_MIN / this.spb, rate));
    this.anchorBeat = b; // 위치는 그대로 이어 간다 (튀지 않게)
    this.anchorTime = t;
    this.rate = rate;
    this.lastIctusTime = t;
    this.log.push({ t, beat: b, bpm: this.bpm });
  }

  /** 주기적으로 불러 멈춤 · 끝 상태를 갱신한다 */
  tick(now: number): void {
    if (this.state !== 'playing') return;
    if (this.beatAt(now) >= this.lengthBeats) {
      this.state = 'done';
      return;
    }
    if (now - this.lastIctusTime > HOLD_AFTER * this.spb && this.beatAt(now) > 0) {
      this.anchorBeat = this.beatAt(now);
      this.anchorTime = now;
      this.rate = 0;
      this.state = 'holding';
    }
  }
}

/**
 * 연습 모드: 템포를 고정하고 오케스트라가 먼저 간다. 사용자는 공(지휘 도형)과 메트로놈을 보고 따라 지휘한다.
 * 준비 박(countIn)은 음수 박(-4 ~ -1)이다 → 메트로놈만 울리고 음악은 0박부터.
 */
export class FixedTempo implements Clock {
  state: FollowState = 'waiting';
  spb: number;
  private t0 = 0;

  constructor(
    private lengthBeats: number,
    bpm: number,
  ) {
    this.spb = 60 / bpm;
  }

  get bpm(): number {
    return 60 / this.spb;
  }

  /** now에서 조금 뒤 준비 박을 시작한다 */
  start(now: number, countIn: number): void {
    this.t0 = now + 0.15 + countIn * this.spb;
    this.state = 'playing';
  }

  beatAt(t: number): number {
    if (this.state === 'waiting') return -Infinity;
    return Math.min((t - this.t0) / this.spb, this.lengthBeats);
  }

  timeOf(beat: number): number {
    return this.t0 + beat * this.spb;
  }

  tick(now: number): void {
    if (this.state === 'playing' && this.beatAt(now) >= this.lengthBeats) this.state = 'done';
  }
}
