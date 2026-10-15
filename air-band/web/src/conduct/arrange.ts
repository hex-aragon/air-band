// 간단 편곡기: 주제 선율 + 코드 기호 → 오케스트라 악보 (Score)
//
// [한눈에 보기]
//   선율은 [MIDI 번호, 4분음표 길이] 목록, 쉼표는 [null, 길이]. 코드는 "C:2 G7:2 Am/C:1"처럼 코드:길이(4분음표).
//   구간(section)마다 선율 악기 · 반주 모양 · 셈여림 · 호른/팀파니를 정한다 → 1절은 여리게, 2절은 세게 같은 구성.
//   화음은 코드 기호에서 만든다: 현악 화음(가운데 음역) · 베이스(코드 맨 아래 음) · 호른(근음+5음) · 팀파니(근음).
//   박 단위 변환: 악보(Score)는 "지휘 박" 단위라 4분음표 길이를 beatUnit으로 나눈다 (2/2면 2분음표 = 1박).
import type { Clef, Group, Note, Part, Score } from './score';

export type Mel = [number | null, number][];

export type Accomp =
  | 'pad' // 코드 동안 길게
  | 'waltz' // 1박 베이스, 2 · 3박 짧은 화음 (3/4)
  | 'syncop' // 1박 베이스, 8분 엇박마다 짧은 화음 (슈베르트)
  | 'arpeggio'; // 피아노 8분 분산화음 (라흐마니노프)

export interface Section {
  label: string;
  melody: Mel;
  chords: string;
  /** 선율 악기 (Part id) */
  lead: string;
  /** 선율 이조 (반음) */
  transpose?: number;
  /** 같은 선율을 다른 악기로 겹치기 */
  doubles?: { part: string; transpose: number }[];
  accomp: Accomp;
  /** 0~1 */
  dyn: number;
  horns?: boolean;
  timp?: boolean;
  clef?: Clef;
}

export interface SongSpec {
  id: string;
  title: string;
  composer: string;
  about: string;
  beatsPerBar: number;
  beatUnit: number;
  /** 못갖춘마디 길이 (4분음표) */
  anacrusisQ: number;
  keySig: number;
  practiceBpm: number;
  bpm: number;
  sections: Section[];
  /** 마지막 화음 (코드, 4분음표 길이) */
  ending: { chord: string; quarters: number; melody?: number };
}

/** 이 프로젝트가 쓰는 악기 (public/sf/<instrument>) */
export const INSTRUMENTS: Record<string, { name: string; instrument: string; group: Group; gain: number }> = {
  violin: { name: '바이올린', instrument: 'violin', group: 'strings', gain: 0.9 },
  cello: { name: '첼로', instrument: 'cello', group: 'strings', gain: 0.9 },
  pad: { name: '현악 화음', instrument: 'string_ensemble_1', group: 'strings', gain: 0.42 },
  bass: { name: '콘트라베이스', instrument: 'contrabass', group: 'strings', gain: 0.8 },
  oboe: { name: '오보에', instrument: 'oboe', group: 'winds', gain: 0.8 },
  horn: { name: '호른', instrument: 'french_horn', group: 'winds', gain: 0.5 },
  hornLead: { name: '호른 (선율)', instrument: 'french_horn', group: 'winds', gain: 0.85 },
  piano: { name: '피아노', instrument: 'acoustic_grand_piano', group: 'winds', gain: 0.55 },
  timp: { name: '팀파니', instrument: 'timpani', group: 'winds', gain: 0.9 },
};

// ---------------------------------------------------------------------------
// 코드 기호
// ---------------------------------------------------------------------------
const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function pcOf(name: string): number {
  let v = PC[name[0]];
  for (const ch of name.slice(1)) v += ch === '#' ? 1 : ch === 'b' ? -1 : 0;
  return ((v % 12) + 12) % 12;
}

interface Chord {
  root: number;
  tones: number[]; // 음이름(0~11), 근음부터
  bass: number;
}

/** "C" "Cm" "G7" "Dm7" "Bdim" "Am/C" "G7/B" "Cmaj7" */
export function parseChord(sym: string): Chord {
  const [main, slash] = sym.split('/');
  const m = /^([A-G][#b]?)(.*)$/.exec(main);
  if (!m) throw new Error(`코드 기호 오류: ${sym}`);
  const root = pcOf(m[1]);
  const q = m[2];
  let iv: number[];
  if (q === 'm') iv = [0, 3, 7];
  else if (q === '7') iv = [0, 4, 7, 10];
  else if (q === 'm7') iv = [0, 3, 7, 10];
  else if (q === 'maj7') iv = [0, 4, 7, 11];
  else if (q === 'dim') iv = [0, 3, 6];
  else if (q === '') iv = [0, 4, 7];
  else throw new Error(`모르는 코드 종류: ${sym}`);
  return { root, tones: iv.map((i) => (root + i) % 12), bass: slash ? pcOf(slash) : root };
}

/** "C:2 G7:1 G7:1" → [{chord, quarters}] (같은 코드가 이어지면 합친다) */
function parseChords(text: string): { sym: string; q: number }[] {
  const out: { sym: string; q: number }[] = [];
  for (const tok of text.trim().split(/\s+/)) {
    const [sym, len] = tok.split(':');
    const q = len === undefined ? 1 : Number(len);
    const last = out[out.length - 1];
    if (last && last.sym === sym) last.q += q;
    else out.push({ sym, q });
  }
  return out;
}

/** 음이름 pc를 [lo, lo+12) 안의 MIDI 번호로 */
const place = (pc: number, lo: number) => lo + ((((pc - lo) % 12) + 12) % 12);

// ---------------------------------------------------------------------------
// 편곡
// ---------------------------------------------------------------------------
export function arrange(spec: SongSpec): Score {
  const notes: Note[] = [];
  const used = new Set<string>();
  const U = spec.beatUnit;
  const push = (part: string, q: number, durQ: number, midi: number, vel: number, lead = false) => {
    notes.push({ beat: q / U, dur: durQ / U, midi, vel, part, ...(lead ? { lead } : {}) });
    used.add(part);
  };
  const marks: Score['marks'] = [];
  const clefs: Score['clefs'] = [];
  let at = 0; // 4분음표 단위 위치

  for (const sec of spec.sections) {
    marks.push({ beat: at / U, text: sec.label });
    clefs.push({ beat: at / U, clef: sec.clef ?? 'treble' });
    const v = sec.dyn;
    // 선율 (+ 겹치기)
    let t = at;
    for (const [m, q] of sec.melody) {
      if (m !== null) {
        push(sec.lead, t, q, m + (sec.transpose ?? 0), Math.min(1, v + 0.1), true);
        for (const d of sec.doubles ?? []) push(d.part, t, q, m + d.transpose, v);
      }
      t += q;
    }
    const melQ = t - at;
    // 반주
    let c = at;
    for (const { sym, q } of parseChords(sec.chords)) {
      const ch = parseChord(sym);
      const pad = ch.tones.slice(0, 3).map((pc) => place(pc, 53)); // F3 ~ E4
      const bass = place(ch.bass, 36); // C2 ~ B2
      switch (sec.accomp) {
        case 'pad':
          for (const m of pad) push('pad', c, q, m, v * 0.85);
          push('bass', c, q, bass, v);
          break;
        case 'waltz':
          for (let b = 0; b < q; b += 1) {
            // 마디 첫 박인지: 곡 처음의 못갖춘마디 길이만큼 밀어서 센다
            const barQ = spec.beatsPerBar * U;
            const pos = Math.round((c + b - spec.anacrusisQ) * 1000) / 1000;
            const downbeat = ((pos % barQ) + barQ) % barQ === 0;
            if (downbeat) push('bass', c + b, 1, bass, v);
            else for (const m of pad) push('pad', c + b, 0.8, m, v * 0.75);
          }
          break;
        case 'syncop':
          push('bass', c, Math.min(q, 1), bass, v);
          for (let b = 0.5; b < q; b += 1) for (const m of pad) push('pad', c + b, 0.45, m, v * 0.7);
          break;
        case 'arpeggio': {
          const r3 = place(ch.root, 48);
          const fig = [bass, place(ch.tones[2] ?? ch.tones[0], 48), r3 + 12, place(ch.tones[1], 60), r3 + 12, place(ch.tones[2] ?? ch.tones[0], 48)];
          for (let b = 0, i = 0; b < q - 0.01; b += 0.5, i++) push('piano', c + b, 0.5, fig[i % fig.length], v * (i % fig.length === 0 ? 0.9 : 0.7));
          push('bass', c, q, bass, v * 0.8);
          break;
        }
      }
      if (sec.horns) for (const pc of [ch.root, ch.tones[2] ?? ch.root]) push('horn', c, q, place(pc, 45), v * 0.8);
      if (sec.timp && (ch.root === pcOf(tonicName(spec)) || ch.root === (pcOf(tonicName(spec)) + 7) % 12)) push('timp', c, Math.min(1, q), place(ch.root, 38), v);
      c += q;
    }
    if (Math.abs(c - t) > 0.01) throw new Error(`${spec.id} · ${sec.label}: 선율 ${melQ} / 코드 ${c - at} 길이가 다름`);
    at = t;
  }

  // 마지막 화음 (모든 파트, 길게)
  const end = parseChord(spec.ending.chord);
  const last = spec.sections[spec.sections.length - 1];
  const q = spec.ending.quarters;
  marks.push({ beat: at / U, text: '마지막 화음' });
  if (spec.ending.melody !== undefined) push(last.lead, at, q, spec.ending.melody, 0.95, true);
  for (const m of end.tones.slice(0, 3).map((pc) => place(pc, 53))) push('pad', at, q, m, 0.8);
  push('bass', at, q, place(end.bass, 36), 0.95);
  for (const pc of [end.root, end.tones[2]]) push('horn', at, q, place(pc, 45), 0.8);
  push('timp', at, 1, place(end.root, 38), 1);
  at += q;

  notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const parts: Part[] = [...used].map((id) => ({ id, ...INSTRUMENTS[id] }));
  return {
    id: spec.id,
    title: spec.title,
    composer: spec.composer,
    about: spec.about,
    beatsPerBar: spec.beatsPerBar,
    beatUnit: U,
    anacrusis: spec.anacrusisQ / U,
    keySig: spec.keySig,
    clefs,
    marks,
    practiceBpm: spec.practiceBpm,
    bpm: spec.bpm,
    parts,
    notes,
    lengthBeats: at / U,
  };
}

/** 마지막 화음의 근음 = 으뜸음으로 본다 (팀파니는 으뜸음 · 딸림음만 친다) */
function tonicName(spec: SongSpec): string {
  return /^[A-G][#b]?/.exec(spec.ending.chord)![0];
}
