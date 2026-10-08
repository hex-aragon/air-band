// 리듬 게임 곡(악보) 데이터
//
// [설명] 악보 적는 법
//   한 마디 = 16칸 (16분음표). 4칸 = 1박. 'x' = 여기서 친다, '.' = 쉼
//     칸 번호  : 1 . . . 2 . . . 3 . . . 4 . . .   ← 박자 세기 "하나 둘 셋 넷"
//     hihat    : x . x . x . x . x . x . x . x .   ← 8분음표로 하이햇
//     snare    : . . . . x . . . . . . . x . . .   ← 2, 4박에 스네어
//   sections는 [마디, 반복 횟수] 목록. 곡 길이 = 모든 마디 수.
//   새 곡을 추가하려면 SONGS 배열에 하나 더 적으면 된다.

export type DrumName = 'snare' | 'kick' | 'hihat' | 'tom' | 'crash';

/** 드럼 이름 → 드럼 class 번호 (audio.ts DRUM_CLASSES · 펌웨어와 같다). 화면의 줄 위치는 main.ts COLUMN_OF가 정한다 */
export const LANE_OF: Record<DrumName, number> = { snare: 0, kick: 1, hihat: 2, tom: 3, crash: 4 };

type Bar = Partial<Record<DrumName, string>>;

interface Section {
  bar: Bar;
  repeat?: number;
}

export interface Song {
  id: string;
  title: string;
  bpm: number; // 1분에 몇 박
  level: 1 | 2 | 3;
  description: string;
  sections: Section[];
}

export interface Chart {
  notes: { lane: number; time: number }[]; // time: 곡 시작 기준 ms
  beats: number[]; // 박마다 시각 (ms). 메트로놈·박자선 그리기용
  beatMs: number; // 1박 길이 (ms)
  durationMs: number;
}

const STEPS_PER_BAR = 16;

// 자주 쓰는 마디
const ROCK: Bar = {
  hihat: 'x.x.x.x.x.x.x.x.',
  kick: 'x.......x.x.....',
  snare: '....x.......x...',
};
/** 필인 다음 마디: 첫 박을 하이햇 대신 크래시로 */
const ROCK_CRASH: Bar = {
  crash: 'x...............',
  hihat: '..x.x.x.x.x.x.x.',
  kick: 'x.......x.x.....',
  snare: '....x.......x...',
};
const FILL_SNARE_TOM: Bar = {
  snare: 'x.x.x.x.........',
  tom: '........x.x.x.x.',
};

export const SONGS: Song[] = [
  {
    id: 'first-steps',
    title: '첫걸음',
    bpm: 80,
    level: 1,
    description: '4분음표로 천천히. 정면(스네어) → 킥 → 왼쪽(하이햇) → 오른쪽(탐) → 위(크래시) 순서로 방향을 하나씩 익힙니다.',
    sections: [
      { bar: { snare: 'x...x...x...x...' }, repeat: 2 },
      { bar: { kick: 'x.......x.......', snare: '....x.......x...' }, repeat: 2 },
      { bar: { hihat: 'x...x...x...x...' }, repeat: 2 },
      { bar: { kick: 'x.......x.......', snare: '....x.......x...' }, repeat: 1 },
      { bar: { tom: 'x...x...x...x...' }, repeat: 1 },
      { bar: { kick: 'x.......x.......', snare: '....x.......x...' }, repeat: 1 },
      { bar: { crash: 'x.......x.......' }, repeat: 1 },
      { bar: { kick: 'x...............', crash: 'x...............' }, repeat: 1 },
    ],
  },
  {
    id: 'eight-beat-rock',
    title: '8비트 록',
    bpm: 96,
    level: 2,
    description: '록의 기본 리듬. 하이햇 8분음표 위에 킥과 스네어, 4마디마다 탐 필인.',
    sections: [
      { bar: { hihat: 'x.x.x.x.x.x.x.x.' }, repeat: 1 },
      { bar: ROCK, repeat: 3 },
      { bar: FILL_SNARE_TOM, repeat: 1 },
      { bar: ROCK_CRASH, repeat: 1 },
      { bar: ROCK, repeat: 2 },
      { bar: { snare: 'x.x.x.x.x.x.x.x.' }, repeat: 1 },
      { bar: ROCK, repeat: 3 },
      { bar: { tom: 'x.x.x.x.', snare: '........x.x.x.x.' }, repeat: 1 },
      { bar: { kick: 'x...............', crash: 'x...............' }, repeat: 1 },
    ],
  },
  {
    id: 'funky-sixteen',
    title: '펑키 16비트',
    bpm: 100,
    level: 3,
    description: '엇박 킥과 고스트 스네어가 섞인 펑크 리듬. 16분음표 필인이 나옵니다.',
    sections: [
      { bar: { hihat: 'x.x.x.x.x.x.x.x.', kick: 'x..x..x...x..x..', snare: '....x.......x...' }, repeat: 3 },
      { bar: { snare: 'x.xxx.x.', tom: '........x.xxx.x.' }, repeat: 1 },
      { bar: { hihat: 'x.x.x.x.x.x.x.x.', kick: 'x..x..x...x..x..', snare: '....x..x....x...' }, repeat: 3 },
      { bar: { tom: 'xxxx....xxxx....', snare: '....xxxx....x...' }, repeat: 1 },
      { bar: { hihat: 'x.x.x.x.x.x.x.x.', kick: 'x..x..x...x..x..', snare: '....x..x....x..x' }, repeat: 3 },
      { bar: { snare: 'x.x.x.x.xxxx....', tom: '............x...' }, repeat: 1 },
      { bar: { kick: 'x...............', crash: 'x...............' }, repeat: 1 },
    ],
  },
];

/** 악보 문자열 → 시각(ms)이 붙은 노트 목록 */
export function buildChart(song: Song): Chart {
  const beatMs = 60000 / song.bpm;
  const stepMs = beatMs / 4;
  const notes: Chart['notes'] = [];
  let bar = 0;

  for (const { bar: pattern, repeat = 1 } of song.sections) {
    for (let r = 0; r < repeat; r++, bar++) {
      for (const [drum, steps] of Object.entries(pattern) as [DrumName, string][]) {
        for (let s = 0; s < Math.min(steps.length, STEPS_PER_BAR); s++) {
          if (steps[s] === 'x') notes.push({ lane: LANE_OF[drum], time: (bar * STEPS_PER_BAR + s) * stepMs });
        }
      }
    }
  }

  const beatCount = bar * 4;
  const beats = Array.from({ length: beatCount }, (_, i) => i * beatMs);
  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  return { notes, beats, beatMs, durationMs: beatCount * beatMs };
}
