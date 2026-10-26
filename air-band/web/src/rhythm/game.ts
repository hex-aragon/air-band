// 리듬 게임 규칙: 노트 판정 · 점수 · 콤보 · 등급
//
// [한눈에 보기]
//   화면·소리와 무관한 순수 계산만 한다. 시각은 모두 "곡 시작 = 0ms" 기준의 게임 시각(ms)이다.
//   hit(lane, t)  : 사용자가 lane 줄을 t 시각에 쳤을 때 → 가장 가까운 노트를 찾아 판정
//   update(t)     : t 시각까지 판정 창을 지나친 노트 → Miss 처리
//
// [설명] 판정 창 (ms)
//   노트 시각과 친 시각의 차이(delta)의 절댓값으로 판정한다.
//     |delta| ≤ 45  → Perfect
//     |delta| ≤ 90  → Great
//     |delta| ≤ 140 → Good
//     그보다 멀면   → 이 노트를 친 것으로 보지 않음 (헛스윙, 벌점 없음)
//   노트가 판정선을 140ms 넘게 지나가도록 아무도 안 치면 → Miss (콤보 끊김)

export type Judgement = 'perfect' | 'great' | 'good' | 'miss';

export const WINDOW_MS = { perfect: 45, great: 90, good: 140 } as const;
export const POINTS: Record<Judgement, number> = { perfect: 100, great: 70, good: 40, miss: 0 };

export interface Note {
  lane: number; // 0 스네어, 1 킥, 2 하이햇, 3 탐, 4 크래시 (드럼 class 번호와 같음)
  time: number; // 곡 시작 기준 ms
  judgement: Judgement | null; // 아직 판정 전이면 null
}

export interface HitResult {
  note: Note;
  judgement: Judgement;
  delta: number; // 친 시각 - 노트 시각 (ms). 음수 = 빨리 침, 양수 = 늦게 침
}

export class RhythmGame {
  readonly notes: Note[];
  score = 0;
  combo = 0;
  maxCombo = 0;
  readonly counts: Record<Judgement, number> = { perfect: 0, great: 0, good: 0, miss: 0 };
  /** 맞힌 노트들의 delta 기록 (평균을 내서 입력 보정값 추천에 쓴다) */
  readonly deltas: number[] = [];

  /** 이 인덱스 앞의 노트는 모두 판정이 끝났다 (매번 처음부터 찾지 않으려고) */
  private firstPending = 0;

  constructor(notes: { lane: number; time: number }[]) {
    this.notes = notes.map((n) => ({ ...n, judgement: null })).sort((a, b) => a.time - b.time);
  }

  hit(lane: number, t: number): HitResult | null {
    // 이 줄의 아직 판정 안 된 노트 중 판정 창 안에서 가장 가까운 것
    let best: Note | null = null;
    for (let i = this.firstPending; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW_MS.good) break; // 이후 노트는 전부 너무 멀리 있다 (시간순 정렬)
      if (n.lane !== lane || n.judgement) continue;
      if (Math.abs(n.time - t) > WINDOW_MS.good) continue;
      if (!best || Math.abs(n.time - t) < Math.abs(best.time - t)) best = n;
    }
    if (!best) return null;

    const delta = t - best.time;
    const abs = Math.abs(delta);
    const judgement: Judgement = abs <= WINDOW_MS.perfect ? 'perfect' : abs <= WINDOW_MS.great ? 'great' : 'good';
    this.apply(best, judgement);
    this.deltas.push(delta);
    return { note: best, judgement, delta };
  }

  /**
   * 판정 창 안에 있는 아직 안 친 노트 중 t에 가장 가까운 것 (줄 상관없이).
   * 엉뚱한 드럼을 쳤을 때 "어느 쪽을 쳐야 했는지" 알려 주는 데 쓴다.
   */
  pendingNear(t: number): Note | null {
    let best: Note | null = null;
    for (let i = this.firstPending; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW_MS.good) break;
      if (n.judgement || Math.abs(n.time - t) > WINDOW_MS.good) continue;
      if (!best || Math.abs(n.time - t) < Math.abs(best.time - t)) best = n;
    }
    return best;
  }

  /** t 시각 기준으로 판정 창을 완전히 지나간 노트를 Miss 처리하고, 새로 Miss 된 노트를 돌려준다 */
  update(t: number): Note[] {
    const missed: Note[] = [];
    for (let i = this.firstPending; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (t - n.time <= WINDOW_MS.good) break;
      if (!n.judgement) {
        this.apply(n, 'miss');
        missed.push(n);
      }
    }
    while (this.firstPending < this.notes.length && this.notes[this.firstPending].judgement) this.firstPending++;
    return missed;
  }

  get finished(): boolean {
    return this.firstPending >= this.notes.length;
  }

  /** 정확도 0~1: 모든 노트를 Perfect로 쳤을 때 대비 얻은 점수 비율 */
  get accuracy(): number {
    return this.notes.length ? this.score / (this.notes.length * POINTS.perfect) : 0;
  }

  get rank(): 'S' | 'A' | 'B' | 'C' | 'D' {
    const a = this.accuracy;
    return a >= 0.95 ? 'S' : a >= 0.85 ? 'A' : a >= 0.7 ? 'B' : a >= 0.5 ? 'C' : 'D';
  }

  /** 평균 타이밍 (ms). 양수면 대체로 늦게, 음수면 빨리 친 것 */
  get meanDelta(): number {
    return this.deltas.length ? this.deltas.reduce((s, d) => s + d, 0) / this.deltas.length : 0;
  }

  private apply(note: Note, judgement: Judgement): void {
    note.judgement = judgement;
    this.counts[judgement]++;
    this.score += POINTS[judgement];
    if (judgement === 'miss') {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    }
  }
}
