// 지휘 모드 악보: 베토벤 교향곡 9번 4악장 "환희의 송가" 주제 (퍼블릭 도메인 곡, 편곡은 이 프로젝트에서 직접)
//
// [한눈에 보기]
//   음은 "몇 번째 박에서 시작해 몇 박 동안"으로 적는다(초가 아니라 박). 그래서 지휘 템포가 바뀌면
//   같은 악보가 빨라지거나 느려진다. 녹음 파일을 빨리 트는 것과 달리 음 높이는 그대로다.
//   1절: 바이올린 선율 + 현악 화음 + 콘트라베이스 (여리게)
//   2절: 바이올린 한 옥타브 위 + 호른 + 팀파니 추가 (세게) → 마지막 화음은 늘임표처럼 길게
//
// [설명] MIDI 번호: 가온 도(C4) = 60, 반음마다 1. D4 = 62, A4 = 69.

export type Group = 'strings' | 'winds';

export interface Part {
  id: string;
  name: string;
  /** public/sf/<instrument>/<midi>.mp3 */
  instrument: string;
  /** 파트 강조 묶음: 왼쪽 겨누기 = 현악, 오른쪽 = 관악 · 타악 */
  group: Group;
  gain: number;
}

export interface Note {
  /** 시작 박 (0부터, 4분음표 = 1박) */
  beat: number;
  /** 길이 (박) */
  dur: number;
  midi: number;
  /** 0~1 */
  vel: number;
  part: string;
  /** 주선율 (악보에 그리는 음) */
  lead?: boolean;
}

export type Clef = 'treble' | 'bass';

export interface Score {
  id: string;
  title: string;
  composer: string;
  /** 어느 대목인지 · 출처 (화면 아래 표시) */
  about: string;
  /** 한 마디에 지휘 박 몇 개 (2 · 3 · 4 → 지휘 도형) */
  beatsPerBar: number;
  /** 지휘 박 하나 = 4분음표 몇 개 (4/4 · 3/4 = 1, 2/2 = 2). 악보는 박 단위, 그림은 이 값으로 음표 모양을 정한다 */
  beatUnit: number;
  /** 못갖춘마디: 첫 마디 첫 박 전에 오는 박 수 (0이면 첫 박부터) */
  anacrusis: number;
  /** 조표: + 샵 개수, - 플랫 개수 */
  keySig: number;
  /** 악보 음자리표 (박 위치부터) */
  clefs: { beat: number; clef: Clef }[];
  /** 악보 위 표시 글 (1절 · 2절 등) */
  marks: { beat: number; text: string }[];
  /** 연습 모드 기본 템포 (박/분) */
  practiceBpm: number;
  /** 시작 템포 기본값 (지휘 준비 박이 없을 때만 씀) */
  bpm: number;
  parts: Part[];
  notes: Note[];
  /** 마지막 음이 끝나는 박 */
  lengthBeats: number;
}

/** 박 b가 마디 안 몇 번째 박인지 (0부터). 못갖춘마디를 반영한다 */
export function beatInBar(score: Score, b: number): number {
  const n = score.beatsPerBar;
  return ((((Math.floor(b) - score.anacrusis) % n) + n) % n);
}

/** 박 b가 몇 번째 마디인지 (1부터, 못갖춘마디는 0) */
export function barOf(score: Score, b: number): number {
  return Math.floor((b - score.anacrusis) / score.beatsPerBar) + 1;
}

// 선율 (D장조) — 마디마다 [MIDI, 박 길이]
type Bar = [number, number][];
const D4 = 62, E4 = 64, Fs4 = 66, G4 = 67, A4 = 69, A3 = 57;
const PHRASE_A: Bar[] = [
  [[Fs4, 1], [Fs4, 1], [G4, 1], [A4, 1]],
  [[A4, 1], [G4, 1], [Fs4, 1], [E4, 1]],
  [[D4, 1], [D4, 1], [E4, 1], [Fs4, 1]],
];
const MELODY: Bar[] = [
  ...PHRASE_A,
  [[Fs4, 1.5], [E4, 0.5], [E4, 2]],
  ...PHRASE_A,
  [[E4, 1.5], [D4, 0.5], [D4, 2]],
  [[E4, 1], [E4, 1], [Fs4, 1], [D4, 1]],
  [[E4, 1], [Fs4, 0.5], [G4, 0.5], [Fs4, 1], [D4, 1]],
  [[E4, 1], [Fs4, 0.5], [G4, 0.5], [Fs4, 1], [E4, 1]],
  [[D4, 1], [E4, 1], [A3, 2]],
  ...PHRASE_A,
  [[E4, 1.5], [D4, 0.5], [D4, 2]],
];

// 화음: 마디마다 [앞 2박, 뒤 2박]. D = 으뜸화음, A = 딸림화음
type Chord = 'D' | 'A';
const CHORDS: [Chord, Chord][] = [
  ['D', 'D'], ['D', 'A'], ['D', 'D'], ['D', 'A'],
  ['D', 'D'], ['D', 'A'], ['D', 'D'], ['A', 'D'],
  ['A', 'D'], ['A', 'D'], ['A', 'A'], ['D', 'A'],
  ['D', 'D'], ['D', 'A'], ['D', 'D'], ['A', 'D'],
];
const PAD: Record<Chord, number[]> = { D: [50, 54, 57], A: [49, 52, 57] }; // D3 F#3 A3 / C#3 E3 A3
const BASS: Record<Chord, number> = { D: 38, A: 33 }; // D2 / A1
const HORN: Record<Chord, number[]> = { D: [45, 50], A: [45, 52] }; // A2 D3 / A2 E3
const TIMP: Record<Chord, number> = { D: 38, A: 33 };

export const PARTS: Part[] = [
  { id: 'melody', name: '바이올린', instrument: 'violin', group: 'strings', gain: 0.9 },
  { id: 'pad', name: '현악 화음', instrument: 'string_ensemble_1', group: 'strings', gain: 0.45 },
  { id: 'bass', name: '콘트라베이스', instrument: 'contrabass', group: 'strings', gain: 0.8 },
  { id: 'horn', name: '호른', instrument: 'french_horn', group: 'winds', gain: 0.45 },
  { id: 'timp', name: '팀파니', instrument: 'timpani', group: 'winds', gain: 0.9 },
];

function build(): Score {
  const notes: Note[] = [];
  const BAR = 4;
  for (let verse = 0; verse < 2; verse++) {
    const loud = verse === 1;
    const base = verse * MELODY.length * BAR;
    MELODY.forEach((bar, i) => {
      let b = base + i * BAR;
      for (const [midi, dur] of bar) {
        notes.push({ beat: b, dur, midi: loud ? midi + 12 : midi, vel: loud ? 0.9 : 0.7, part: 'melody', lead: true });
        b += dur;
      }
    });
    CHORDS.forEach((pair, i) => {
      const bar = base + i * BAR;
      pair.forEach((ch, half) => {
        const at = bar + half * 2;
        for (const m of PAD[ch]) notes.push({ beat: at, dur: 2, midi: m, vel: loud ? 0.75 : 0.55, part: 'pad' });
        notes.push({ beat: at, dur: 1.5, midi: BASS[ch], vel: loud ? 0.9 : 0.7, part: 'bass' });
        if (loud) for (const m of HORN[ch]) notes.push({ beat: at, dur: 2, midi: m, vel: 0.7, part: 'horn' });
      });
      if (loud) notes.push({ beat: bar, dur: 1, midi: TIMP[pair[0]], vel: i % 4 === 0 ? 1 : 0.75, part: 'timp' });
    });
  }
  // 마지막: 으뜸화음을 한 마디 길게 (모든 파트)
  const end = 2 * MELODY.length * BAR;
  notes.push({ beat: end, dur: 4, midi: 74, vel: 0.95, part: 'melody', lead: true });
  for (const m of PAD.D) notes.push({ beat: end, dur: 4, midi: m, vel: 0.8, part: 'pad' });
  notes.push({ beat: end, dur: 4, midi: BASS.D, vel: 0.95, part: 'bass' });
  for (const m of HORN.D) notes.push({ beat: end, dur: 4, midi: m, vel: 0.8, part: 'horn' });
  notes.push({ beat: end, dur: 1, midi: TIMP.D, vel: 1, part: 'timp' });
  notes.sort((a, b) => a.beat - b.beat);
  return {
    id: 'ode',
    title: '환희의 송가',
    composer: '베토벤 · 교향곡 9번 4악장 주제',
    about: '주제 선율 · 편곡 Air Band',
    beatsPerBar: BAR,
    beatUnit: 1,
    anacrusis: 0,
    keySig: 2,
    clefs: [{ beat: 0, clef: 'treble' }],
    marks: [
      { beat: 0, text: '1절 · 여리게' },
      { beat: 64, text: '2절 · 세게 (한 옥타브 위)' },
      { beat: 128, text: '마지막 화음' },
    ],
    practiceBpm: 66,
    bpm: 96,
    parts: PARTS,
    notes,
    lengthBeats: end + 4,
  };
}

export const ODE_TO_JOY = build();
