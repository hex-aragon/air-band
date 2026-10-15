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
  level: 1 | 2 | 3 | 4; // 1 아주 쉬움 · 2 쉬움 · 3 보통 · 4 어려움 (music.ts LEVEL_NAMES)
  emoji?: string;
  description: string;
  sections: Section[];
}

export interface Chart {
  notes: { lane: number; time: number }[]; // time: 곡 시작 기준 ms
  beats: number[]; // 박마다 시각 (ms). 메트로놈·박자선 그리기용
  beatMs: number; // 1박 길이 (ms)
  durationMs: number;
  startMs: number; // 첫 박 시각 (내장 곡은 0, 내 노래는 드럼이 시작하는 곳). 카운트다운 기준
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
    // We Will Rock You의 "쿵 쿵 짝" 리듬 (음원 없이 리듬만). 킥은 자동으로 나오게 두면 정면(스네어)만 치면 된다
    id: 'stomp-clap',
    title: '쿵쿵짝 연습',
    emoji: '👏',
    bpm: 80,
    level: 1,
    description: 'We Will Rock You의 쿵쿵짝 리듬만 메트로놈으로. 2박 · 4박에 정면으로 "짝". 원곡과 치려면 ⭐ 인기곡에서.',
    sections: [
      { bar: { kick: 'x.x.....x.x.....' }, repeat: 1 },
      { bar: { kick: 'x.x.....x.x.....', snare: '....x.......x...' }, repeat: 7 },
      { bar: { kick: 'x.x.....x.x.....', snare: '....x.......x...', crash: 'x...............' }, repeat: 1 },
      { bar: { kick: 'x.x.....x.x.....', snare: '....x.......x...' }, repeat: 6 },
      { bar: { crash: 'x...............', kick: 'x...............' }, repeat: 1 },
    ],
  },
  {
    id: 'first-steps',
    title: '첫걸음',
    emoji: '👣',
    bpm: 80,
    level: 2,
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
    emoji: '🎸',
    bpm: 96,
    level: 3,
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
    emoji: '🕺',
    bpm: 100,
    level: 4,
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
  return { notes, beats, beatMs, durationMs: beatCount * beatMs, startMs: 0 };
}

/**
 * 인기곡: 공식 뮤직비디오(유튜브 임베드)를 틀고 친다. 음원 파일은 들어 있지 않다(저작권).
 *   유튜브 소리는 읽을 수 없으므로, 노래가 나오면 "짝"(스네어 · 손뼉)마다 몇 번 탭 → 박자 격자 → 악보.
 *   bpm은 대략값(탭을 박 번호에 맞출 때만 쓴다. 실제 박자는 탭에서 구함). tapEvery = 탭 하나가 몇 박인지.
 * videoId는 2026-10-14 YouTube oEmbed로 공식 영상 · 임베드 허용 확인.
 */
export interface PopSong {
  id: string;
  title: string;
  artist: string;
  level: 1 | 2 | 3 | 4;
  emoji: string;
  why: string;
  videoId: string;
  bpm: number;
  tapEvery: 1 | 2;
  tapHint: string;
}
const BACKBEAT = '드럼 "짝"(스네어) 소리마다';
export const POP_SONGS: PopSong[] = [
  { id: 'wwry', title: 'We Will Rock You', artist: 'Queen', level: 1, emoji: '👏', why: '쿵쿵짝 반복 — 입문에 딱', videoId: '-tJYN-eG1zk', bpm: 81, tapEvery: 2, tapHint: '"쿵 쿵 짝"의 짝(손뼉)마다' },
  { id: 'sna', title: 'Seven Nation Army', artist: 'The White Stripes', level: 2, emoji: '🥁', why: '아주 단순하고 일정한 드럼', videoId: '0J2QdDbelmY', bpm: 124, tapEvery: 1, tapHint: '드럼 "쿵" 소리(박)마다' },
  { id: 'billie', title: 'Billie Jean', artist: 'Michael Jackson', level: 2, emoji: '🕴', why: '처음부터 끝까지 같은 리듬', videoId: 'Zi_XLOBDo_Y', bpm: 117, tapEvery: 2, tapHint: BACKBEAT },
  { id: 'abtd', title: 'Another One Bites the Dust', artist: 'Queen', level: 2, emoji: '🎯', why: '느긋한 반복 리듬', videoId: 'rY0WxgSXdEE', bpm: 110, tapEvery: 2, tapHint: BACKBEAT },
  { id: 'bib', title: 'Back in Black', artist: 'AC/DC', level: 3, emoji: '🖤', why: '기본 록 리듬의 교과서', videoId: 'pAgnJDJN4VA', bpm: 94, tapEvery: 2, tapHint: BACKBEAT },
  { id: 'scar', title: 'Scar Tissue', artist: 'Red Hot Chili Peppers', level: 3, emoji: '🌶', why: '느리고 차분한 기본 리듬', videoId: 'mzJj5-lubeM', bpm: 89, tapEvery: 2, tapHint: BACKBEAT },
  { id: 'otherside', title: 'Otherside', artist: 'Red Hot Chili Peppers', level: 3, emoji: '🌶', why: '일정한 8비트', videoId: 'rn_YodiJO6k', bpm: 123, tapEvery: 2, tapHint: BACKBEAT },
  { id: 'dani', title: 'Dani California', artist: 'Red Hot Chili Peppers', level: 4, emoji: '🌶', why: '빠르고 필인이 많음', videoId: 'Sb5aq5HcS1A', bpm: 96, tapEvery: 2, tapHint: BACKBEAT },
];
