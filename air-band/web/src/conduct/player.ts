// 지휘 모드 재생기: 악보(박 단위)를 TempoFollower가 정한 시각에 맞춰 사운드폰트 샘플로 연주한다
//
// [한눈에 보기]
//   샘플     : public/sf/<악기>/<MIDI>.mp3 를 처음에 전부 AudioBuffer로 풀어 둔다 (연주 중에는 내려받지 않음)
//   예약     : 25ms마다 "지금 ~ 0.12초 뒤"에 연주될 음만 예약한다. 템포가 바뀌어도 이미 예약한 0.12초만 옛 템포다
//   소리 경로 : 음 → 파트 볼륨 → 묶음 볼륨(현악 / 관악·타악, 겨눈 방향으로 강조) → 전체 볼륨(셈여림) → 스피커
import { beatInBar, type Group, type Note, type Score } from './score';
import type { Clock } from './follower';

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

export class ConductPlayer {
  readonly ctx: AudioContext;
  private master: GainNode;
  private groups: Record<Group, GainNode>;
  private parts = new Map<string, GainNode>();
  private buffers = new Map<string, AudioBuffer>();
  private next = 0; // 다음에 예약할 음 번호 (score.notes는 박 순서로 정렬돼 있음)
  private timer = 0;
  /** 메트로놈(박마다 딸깍, 1박은 높게). 연습 모드에서 켠다 */
  metronome = false;
  /** false면 악보 음은 내지 않고 메트로놈만 (박 치기 연습) */
  music = true;
  /** 다음에 예약할 메트로놈 박 (준비 박은 음수) */
  private nextClick = 0;
  /** 파트별 마지막으로 소리 난 시각 (화면에서 파트를 반짝이게) */
  readonly lastPlayed = new Map<string, number>();

  private score!: Score;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    // 여러 음이 겹쳐도 깨지지 않게 마지막에 컴프레서
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.groups = { strings: this.ctx.createGain(), winds: this.ctx.createGain() };
    for (const g of Object.values(this.groups)) g.connect(this.master);
  }

  /** 곡 바꾸기: 파트별 볼륨을 새로 만들고 처음으로 되돌린다. 샘플은 load()로 */
  setScore(score: Score): void {
    this.stop();
    for (const g of this.parts.values()) g.disconnect();
    this.parts.clear();
    this.lastPlayed.clear();
    this.score = score;
    for (const p of score.parts) {
      const g = this.ctx.createGain();
      g.gain.value = p.gain;
      g.connect(this.groups[p.group]);
      this.parts.set(p.id, g);
    }
    this.rewind();
  }

  /** 지금 곡에 쓰인 샘플 중 아직 없는 것을 내려받아 푼다 (한 번 받은 소리는 곡을 바꿔도 남는다). onProgress(받은 수, 전체) */
  async load(onProgress: (done: number, total: number) => void): Promise<void> {
    const inst = new Map(this.score.parts.map((p) => [p.id, p.instrument]));
    const keys = [...new Set(this.score.notes.map((n) => `${inst.get(n.part)}/${n.midi}`))].filter((k) => !this.buffers.has(k));
    let done = 0;
    let failed = false;
    await Promise.all(
      keys.map(async (key) => {
        try {
          const res = await fetch(`sf/${key}.mp3`);
          if (!res.ok) throw new Error(`샘플 없음: ${key}`);
          this.buffers.set(key, await this.ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (err) {
          failed = true; // 하나라도 실패하면 진행 표시를 멈추고 오류를 보여 준다
          throw new Error(`악기 소리 ${key}: ${err instanceof Error ? err.message : err}`);
        }
        if (!failed) onProgress(++done, keys.length);
      }),
    );
  }

  resume(): Promise<void> {
    return this.ctx.resume();
  }

  /** 처음부터 다시: 예약 위치를 되돌린다. countIn = 메트로놈 준비 박 수 */
  rewind(countIn = 0): void {
    this.next = 0;
    this.nextClick = -countIn;
  }

  start(clock: Clock): void {
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.schedule(clock), TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** 셈여림: 0(아주 여리게) ~ 1(아주 세게). 0.15초에 걸쳐 부드럽게 바뀐다 */
  setDynamics(level: number): void {
    const g = 0.12 + 0.88 * Math.max(0, Math.min(1, level));
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.15);
  }

  /** 파트 강조: 겨눈 쪽 묶음은 키우고 반대쪽은 줄인다. bias -1(관악) ~ 0(같게) ~ 1(현악) */
  setBalance(bias: number): void {
    const b = Math.max(-1, Math.min(1, bias));
    const now = this.ctx.currentTime;
    this.groups.strings.gain.setTargetAtTime(1 + 0.5 * b, now, 0.2);
    this.groups.winds.gain.setTargetAtTime(1 - 0.5 * b, now, 0.2);
  }

  private schedule(f: Clock): void {
    f.tick(this.ctx.currentTime);
    if (f.state !== 'playing') return;
    const now = this.ctx.currentTime;
    const until = f.beatAt(now + LOOKAHEAD_S);
    if (this.metronome) {
      while (this.nextClick < until && this.nextClick < this.score.lengthBeats) {
        const b = this.nextClick++;
        const when = f.timeOf(b);
        if (when >= now - 0.01) this.click(when, beatInBar(this.score, b) === 0);
      }
    }
    const notes = this.score.notes;
    while (this.next < notes.length && notes[this.next].beat < until) {
      const n = notes[this.next++];
      if (!this.music) continue;
      const when = Math.max(now, f.timeOf(n.beat));
      this.play(n, when, n.dur * f.spb);
    }
  }

  /** 메트로놈 딸깍: 짧은 사인파. 마디 첫 박은 높고 크게 */
  private click(when: number, accent: boolean): void {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    osc.connect(env).connect(this.ctx.destination); // 셈여림(전체 볼륨)과 상관없이 같은 크기
    osc.start(when);
    osc.stop(when + 0.07);
  }

  private play(n: Note, when: number, durS: number): void {
    const part = this.score.parts.find((p) => p.id === n.part)!;
    const buf = this.buffers.get(`${part.instrument}/${n.midi}`);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const env = this.ctx.createGain();
    // 현악 · 호른은 살짝 부풀려 시작, 팀파니는 바로. 끝은 0.12초에 걸쳐 줄인다(뚝 끊기지 않게)
    const attack = part.instrument === 'timpani' ? 0.005 : 0.03;
    const end = when + Math.max(0.08, durS * 0.95);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(n.vel, when + attack);
    env.gain.setValueAtTime(n.vel, end);
    env.gain.linearRampToValueAtTime(0, end + 0.12);
    src.connect(env).connect(this.parts.get(n.part)!);
    src.start(when);
    src.stop(end + 0.15);
    this.lastPlayed.set(n.part, when);
  }
}
