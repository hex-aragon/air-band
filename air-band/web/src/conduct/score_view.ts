// 흐르는 한 줄 악보: 주선율을 오선에 그리고, 지금 연주 중인 음을 노랗게 · 박 세기(1 2 3 …)를 아래에 표시한다
//
// [한눈에 보기]
//   가로 = 박. 재생선(왼쪽에서 22%)은 고정이고 악보가 왼쪽으로 흘러간다 → 지휘 템포가 빨라지면 빨리 흐른다
//   세로 = 음 높이. 음자리표에 따라 맨 아랫줄이 다르다 (높은음자리표 E4, 낮은음자리표 G2). 한 칸/줄 = 한 음
//   조표(♯ · ♭ 개수)에 맞춰 음 이름을 정하고, 조표와 다른 음에만 임시표(♯ ♭ ♮)를 붙인다 (마디 안 반복도 매번 붙임)
import { beatInBar, type Clef, type Note, type Score } from './score';

const LETTER_STEP = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B 의 반음 위치
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B (음이름 번호 C=0)
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
const BOTTOM: Record<Clef, number> = { treble: 4 * 7 + 2, bass: 2 * 7 + 4 }; // 맨 아랫줄: E4 / G2 (도레미 번호)
// 조표 위치 (맨 아랫줄에서 몇 계단): 높은음자리표 기준, 낮은음자리표는 2계단 아래
const SHARP_POS = [8, 5, 9, 6, 3, 7, 4];
const FLAT_POS = [4, 7, 3, 6, 2, 5, 1];

interface Spelled {
  /** 도레미 번호 = 옥타브 × 7 + 음이름 */
  step: number;
  /** -1 ♭, 0 제자리, +1 ♯ */
  acc: number;
}

/** 조표에서 이 음이름(0~6)에 붙는 변화 */
function keyAcc(keySig: number, letter: number): number {
  if (keySig > 0 && SHARP_ORDER.slice(0, keySig).includes(letter)) return 1;
  if (keySig < 0 && FLAT_ORDER.slice(0, -keySig).includes(letter)) return -1;
  return 0;
}

/** MIDI 번호 → 음 이름 (조표에 맞는 쪽을 고른다: 조표에 있는 ♯/♭이면 그 이름, 아니면 샵 조는 ♯, 플랫 조는 ♭) */
function spell(midi: number, keySig: number): Spelled {
  const pc = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  const cands: { letter: number; acc: number }[] = [];
  for (let l = 0; l < 7; l++) {
    const d = (((pc - LETTER_STEP[l]) % 12) + 12) % 12;
    if (d === 0) cands.push({ letter: l, acc: 0 });
    else if (d === 1) cands.push({ letter: l, acc: 1 });
    else if (d === 11) cands.push({ letter: l, acc: -1 });
  }
  const pick =
    cands.find((c) => c.acc === keyAcc(keySig, c.letter)) ??
    cands.find((c) => c.acc === 0) ??
    cands.find((c) => c.acc === (keySig < 0 ? -1 : 1)) ??
    cands[0];
  // B♯ · C♭처럼 옥타브 경계를 넘는 이름 보정
  let oct = octave;
  if (pick.letter === 0 && pick.acc === -1) oct = octave + 1; // C♭은 한 옥타브 위 C의 이름
  if (pick.letter === 6 && pick.acc === 1) oct = octave - 1; // B♯은 아래 옥타브 B의 이름
  return { step: oct * 7 + pick.letter, acc: pick.acc };
}

export interface ScoreViewColors {
  ink: string;
  dim: string;
  now: string;
  line: string;
  bg: string;
}

const DARK: ScoreViewColors = { ink: '#e8eaef', dim: '#5b6372', now: '#facc15', line: '#6b7280', bg: '#0c0e13' };

export class ScoreView {
  private notes: Note[];

  constructor(
    private score: Score,
    private colors: ScoreViewColors = DARK,
  ) {
    this.notes = score.notes.filter((n) => n.lead);
  }

  private clefAt(beat: number): Clef {
    let c: Clef = this.score.clefs[0]?.clef ?? 'treble';
    for (const k of this.score.clefs) if (k.beat <= beat + 1e-6) c = k.clef;
    return c;
  }

  /** cur: 지금 악보 위치(박). 시작 전이면 음수 · -Infinity 가능 */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, cur: number): void {
    const c = this.colors;
    const sc = this.score;
    const beat = Number.isFinite(cur) ? cur : -1;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);

    const gap = Math.max(7, Math.min(11, h / 14)); // 줄 간격
    const top = h * 0.3;
    const bottom = top + gap * 4;
    const yOfStep = (rel: number) => bottom - (rel * gap) / 2; // rel: 맨 아랫줄에서 몇 계단
    const playX = Math.max(130, w * 0.22);
    const pxPerBeat = Math.max(44, Math.min(80, w / 13)) * Math.sqrt(sc.beatUnit);
    const xOf = (b: number) => playX + (b - beat) * pxPerBeat;
    const firstBeat = Math.floor(beat - (playX - 100) / pxPerBeat) - 1;
    const lastBeat = Math.ceil(beat + (w - playX) / pxPerBeat) + 1;

    // 오선
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(0, top + i * gap);
      ctx.lineTo(w, top + i * gap);
      ctx.stroke();
    }

    // 마디줄 · 마디 번호 · 박 세기
    ctx.textAlign = 'center';
    for (let b = Math.max(0, firstBeat); b <= Math.min(lastBeat, sc.lengthBeats - 1); b++) {
      const x = xOf(b);
      const inBar = beatInBar(sc, b);
      if (inBar === 0) {
        const bx = x - pxPerBeat * 0.3;
        ctx.strokeStyle = c.line;
        ctx.beginPath();
        ctx.moveTo(bx, top);
        ctx.lineTo(bx, bottom);
        ctx.stroke();
        if (!sc.marks.some((m) => Math.abs(m.beat - b) < 0.6)) {
          ctx.fillStyle = c.dim;
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(String(Math.floor((b - sc.anacrusis) / sc.beatsPerBar) + 1), bx, top - gap * 2.6);
        }
      }
      const isNow = beat >= b && beat < b + 1;
      const cy = bottom + gap * 3.4;
      if (isNow) {
        ctx.fillStyle = c.now;
        ctx.beginPath();
        ctx.arc(x, cy - 4, 10, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = isNow ? '#111' : c.dim;
      ctx.font = `${isNow ? 700 : 500} 13px system-ui, sans-serif`;
      ctx.fillText(String(inBar + 1), x, cy);
    }

    // 표시 글 (1절 · 2절 등)
    ctx.textAlign = 'left';
    ctx.font = '600 12px system-ui, sans-serif';
    for (const m of sc.marks) {
      const x = xOf(m.beat);
      if (x < 100 || x > w) continue;
      ctx.fillStyle = c.ink;
      ctx.fillText(m.text, x - pxPerBeat * 0.3 + 4, top - gap * 2.6);
    }
    // 중간에 음자리표가 바뀌면 작은 음자리표
    for (const k of sc.clefs.slice(1)) {
      const x = xOf(k.beat) - pxPerBeat * 0.55;
      if (x < 100 || x > w) continue;
      this.clef(ctx, k.clef, x, bottom, gap * 0.75, c.ink);
    }

    // 음표
    for (const n of this.notes) {
      if (n.beat + n.dur < firstBeat || n.beat > lastBeat) continue;
      const clef = this.clefAt(n.beat);
      const x = xOf(n.beat);
      const sp = spell(n.midi, sc.keySig);
      const rel = sp.step - BOTTOM[clef];
      const y = yOfStep(rel);
      const playing = beat >= n.beat && beat < n.beat + n.dur;
      const past = beat >= n.beat + n.dur;
      const col = playing ? c.now : past ? c.dim : c.ink;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.2;

      // 덧줄
      for (let s = -2; s >= rel; s -= 2) this.ledger(ctx, x, yOfStep(s), gap);
      for (let s = 10; s <= rel; s += 2) this.ledger(ctx, x, yOfStep(s), gap);

      // 임시표 (조표와 다를 때)
      const letter = ((sp.step % 7) + 7) % 7;
      if (sp.acc !== keyAcc(sc.keySig, letter)) {
        ctx.font = `600 ${gap * 1.7}px serif`;
        ctx.textAlign = 'center';
        ctx.fillText(sp.acc === 1 ? '♯' : sp.acc === -1 ? '♭' : '♮', x - gap * 1.5, y + gap * 0.6);
      }

      const q = n.dur * sc.beatUnit; // 4분음표 길이
      const hollow = q >= 2 - 1e-6;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.35);
      ctx.beginPath();
      ctx.ellipse(0, 0, gap * 0.62, gap * 0.42, 0, 0, Math.PI * 2);
      if (hollow) {
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else ctx.fill();
      ctx.restore();

      // 기둥 · 꼬리 (온음표 이상은 기둥 없음). 가운데 줄보다 낮으면 위로
      if (q < 4 - 1e-6) {
        const up = rel < 4;
        const sx = up ? x + gap * 0.55 : x - gap * 0.55;
        const sy = up ? y - gap * 3.3 : y + gap * 3.3;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(sx, y);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        const flags = q < 0.375 ? 2 : q < 1 - 1e-6 ? 1 : 0;
        for (let f = 0; f < flags; f++) {
          const fy = sy + (up ? 1 : -1) * f * gap * 0.9;
          ctx.beginPath();
          ctx.moveTo(sx, fy);
          ctx.quadraticCurveTo(sx + gap * 1.1, fy + (up ? gap * 1.2 : -gap * 1.2), sx + gap * 0.6, fy + (up ? gap * 2.4 : -gap * 2.4));
          ctx.stroke();
        }
      }
      // 점음표 (3/2배 길이)
      if ([0.75, 1.5, 3, 6].some((d) => Math.abs(q - d) < 1e-6)) {
        ctx.beginPath();
        ctx.arc(x + gap * 1.1, y - (rel % 2 === 0 ? gap * 0.5 : 0), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 왼쪽: 음자리표 · 조표 (악보가 그 밑으로 흘러 들어간다)
    const fade = ctx.createLinearGradient(96, 0, 126, 0);
    fade.addColorStop(0, c.bg);
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, 96, h);
    ctx.fillStyle = fade;
    ctx.fillRect(96, 0, 30, h);
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(0, top + i * gap);
      ctx.lineTo(96, top + i * gap);
      ctx.stroke();
    }
    const clef = this.clefAt(Math.max(0, beat));
    this.clef(ctx, clef, 24, bottom, gap, c.ink);
    ctx.fillStyle = c.ink;
    ctx.textAlign = 'left';
    ctx.font = `600 ${gap * 1.8}px serif`;
    const shift = clef === 'bass' ? -2 : 0;
    const n = Math.abs(sc.keySig);
    for (let i = 0; i < n; i++) {
      const pos = (sc.keySig > 0 ? SHARP_POS : FLAT_POS)[i] + shift;
      ctx.fillText(sc.keySig > 0 ? '♯' : '♭', 44 + i * 8, yOfStep(pos) + gap * 0.62);
    }

    // 재생선
    ctx.strokeStyle = c.now;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playX, top - gap * 1.6);
    ctx.lineTo(playX, bottom + gap * 1.6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** 음자리표 (글꼴에 𝄞 · 𝄢가 없는 기기도 있어 직접 그린다). bottom = 맨 아랫줄 y */
  private clef(ctx: CanvasRenderingContext2D, clef: Clef, x: number, bottom: number, g: number, color: string): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.6, g * 0.22);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (clef === 'treble') {
      const yG = bottom - g; // 둘째 줄 (G4)
      ctx.moveTo(x + 0.2 * g, yG - 0.1 * g);
      ctx.bezierCurveTo(x + 0.2 * g, yG + 0.9 * g, x - 1.1 * g, yG + 0.8 * g, x - 1.0 * g, yG - 0.2 * g);
      ctx.bezierCurveTo(x - 0.9 * g, yG - 1.4 * g, x + 1.2 * g, yG - 1.6 * g, x + 1.1 * g, yG - 0.1 * g);
      ctx.bezierCurveTo(x + 1.0 * g, yG + 1.6 * g, x - 1.6 * g, yG + 1.6 * g, x - 1.5 * g, yG - 0.6 * g);
      ctx.bezierCurveTo(x - 1.4 * g, yG - 2.2 * g, x + 0.6 * g, yG - 3.0 * g, x + 0.5 * g, yG - 4.4 * g);
      ctx.bezierCurveTo(x + 0.45 * g, yG - 5.4 * g, x - 0.4 * g, yG - 5.0 * g, x - 0.2 * g, yG - 3.6 * g);
      ctx.lineTo(x + 0.4 * g, yG + 3.0 * g);
      ctx.bezierCurveTo(x + 0.5 * g, yG + 3.8 * g, x - 0.6 * g, yG + 3.9 * g, x - 0.5 * g, yG + 3.1 * g);
      ctx.stroke();
    } else {
      const yF = bottom - 3 * g; // 넷째 줄 (F3)
      ctx.arc(x - 0.6 * g, yF, 0.38 * g, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 0.95 * g, yF);
      ctx.bezierCurveTo(x - 0.9 * g, yF - 1.4 * g, x + 1.6 * g, yF - 1.3 * g, x + 1.3 * g, yF + 0.6 * g);
      ctx.bezierCurveTo(x + 1.1 * g, yF + 1.8 * g, x - 0.2 * g, yF + 2.8 * g, x - 1.0 * g, yF + 3.1 * g);
      ctx.stroke();
      for (const dy of [-0.5, 0.5]) {
        ctx.beginPath();
        ctx.arc(x + 2.0 * g, yF + dy * g, 0.18 * g, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private ledger(ctx: CanvasRenderingContext2D, x: number, y: number, gap: number): void {
    ctx.beginPath();
    ctx.moveTo(x - gap, y);
    ctx.lineTo(x + gap, y);
    ctx.stroke();
  }
}
