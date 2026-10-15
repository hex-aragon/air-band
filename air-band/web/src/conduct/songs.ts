// 지휘 재생목록 — 모두 퍼블릭 도메인 곡. 유명한 주제 대목만 짧게 발췌해 Air Band가 직접 편곡했다
//
// [선율 출처] 기억에 의존하지 않고 기계 판독 자료에서 음을 옮겼다 (곡 자체는 퍼블릭 도메인, 음 높이 · 길이만 사용)
//   - MTD (Musical Theme Dataset, AudioLabs Erlangen): 각 주제의 MIDI · 악보 → 번호는 아래 곡마다 표기
//   - 홀스트 「Thaxted」: Mutopia Project #527 (Methodist Hymnbook 1933, Public Domain) — 선율 · 코드 기호 그대로
// [편곡] 화음(코드)은 Air Band가 붙였다(Thaxted 제외). 주제가 중간에 끝나는 곡은 "마무리"를 2~3마디 덧붙였다 — 표시함.
//   선율 [MIDI, 4분음표 길이], 코드 "기호:4분음표 길이"
import { arrange, type Mel, type SongSpec } from './arrange';
import { ODE_TO_JOY, type Score } from './score';

// 슈베르트 교향곡 8번 「미완성」 1악장 — 첼로가 부르는 둘째 주제 (MTD 7754). 7~8마디는 마무리 편곡
const SCHUBERT_THEME: Mel = [
  [55, 1], [50, 1.5], [55, 0.5],
  [54, 0.75], [55, 0.25], [57, 1.5], [55, 0.5],
  [54, 0.75], [55, 0.25], [57, 0.5], [50, 0.5], [52, 0.5], [54, 0.5],
  [55, 1], [50, 2],
  [55, 1], [50, 1.5], [55, 0.5],
  [56, 0.75], [57, 0.25], [59, 2],
  [60, 1], [59, 1], [57, 1], // 마무리
  [55, 3],
];
const SCHUBERT_CHORDS = 'G:3 D7:3 D7:3 G:3 G:3 E7:3 Am:2 D7:1 G:3';

const SCHUBERT: SongSpec = {
  id: 'schubert8',
  title: '미완성 교향곡',
  composer: '슈베르트 · 교향곡 8번 1악장 (첼로 주제)',
  about: '선율: MTD 7754 · 편곡(화음 · 7~8마디 마무리) Air Band',
  beatsPerBar: 3,
  beatUnit: 1,
  anacrusisQ: 0,
  keySig: 2,
  practiceBpm: 84,
  bpm: 108,
  sections: [
    { label: '첼로 · 여리게', melody: SCHUBERT_THEME, chords: SCHUBERT_CHORDS, lead: 'cello', accomp: 'syncop', dyn: 0.5, clef: 'bass' },
    { label: '바이올린 · 세게 (한 옥타브 위)', melody: SCHUBERT_THEME, chords: SCHUBERT_CHORDS, lead: 'violin', transpose: 12, doubles: [{ part: 'cello', transpose: 0 }], accomp: 'syncop', dyn: 0.85, horns: true, timp: true },
  ],
  ending: { chord: 'G', quarters: 3, melody: 67 },
};

// 라흐마니노프 피아노 협주곡 2번 1악장 — 현악이 부르는 첫 주제 (MTD 6774). 2/2박: 2분음표 = 1박
const RACH_THEME: Mel = [
  [60, 3], [62, 1],
  [60, 3], [62, 1],
  [60, 3], [58, 1],
  [56, 1], [58, 1], [55, 2],
  [60, 1], [62, 1], [63, 1], [62, 1],
  [63, 3], [62, 1],
  [60, 2], [58, 2],
  [58, 1], [56, 1], [55, 1], [53, 1],
];
const RACH_CHORDS = 'Cm:4 Fm:4 Ab:4 Fm:2 G:2 Cm:4 Eb:2 Bb:2 Ab:2 Eb:2 Bb7:2 G7:2';

const RACHMANINOFF: SongSpec = {
  id: 'rach2',
  title: '피아노 협주곡 2번',
  composer: '라흐마니노프 · 1악장 첫 주제',
  about: '선율: MTD 6774 · 편곡(화음 · 피아노 분산화음) Air Band',
  beatsPerBar: 2,
  beatUnit: 2,
  anacrusisQ: 0,
  keySig: -3,
  practiceBpm: 46,
  bpm: 60,
  sections: [
    { label: '현악 + 피아노 · 여리게', melody: RACH_THEME, chords: RACH_CHORDS, lead: 'violin', transpose: 12, doubles: [{ part: 'cello', transpose: 0 }], accomp: 'arpeggio', dyn: 0.55 },
    { label: '전체 · 세게', melody: RACH_THEME, chords: RACH_CHORDS, lead: 'violin', transpose: 12, doubles: [{ part: 'cello', transpose: 0 }, { part: 'hornLead', transpose: 0 }], accomp: 'arpeggio', dyn: 0.9, horns: true, timp: true },
  ],
  ending: { chord: 'Cm', quarters: 4, melody: 72 },
};

// 브람스 교향곡 1번 4악장 — 알프호른 주제 (MTD 1730) → 큰 주제 (MTD 1732, 5~6마디는 마무리 편곡)
const BRAHMS_ALPHORN: Mel = [
  [64, 3], [62, 0.25], [60, 0.75],
  [55, 4],
  [62, 3], [64, 1],
  [60, 4],
  [67, 3], [66, 1],
  [62, 4],
  [55, 4],
  [62, 3], [64, 1],
  [60, 3],
];
const BRAHMS_ALPHORN_CHORDS = 'C:4 C:4 G:3 C:1 C:4 G:3 D7:1 G:4 G7:4 G:3 C:1 C:3';
const brahmsTune = (lastQ: number): Mel => [
  [55, 1],
  [60, 2], [59, 1], [60, 1],
  [57, 2], [55, 1], [60, 1],
  [62, 1], [64, 0.5], [62, 0.5], [64, 1], [60, 1],
  [62, 2], [62, 1], [55, 1], // 여기부터 마무리
  [64, 2], [62, 1], [59, 1],
  [60, lastQ],
];
const brahmsTuneChords = (lastQ: number) => `G:1 C:2 G:1 C:1 F:2 C:2 G:2 C:2 G:3 G7:1 C:2 G:2 C:${lastQ}`;

const BRAHMS: SongSpec = {
  id: 'brahms1',
  title: '교향곡 1번',
  composer: '브람스 · 4악장 (알프호른 → 큰 주제)',
  about: '선율: MTD 1730 · 1732 · 편곡(화음 · 큰 주제 5~6마디 마무리) Air Band',
  beatsPerBar: 4,
  beatUnit: 1,
  anacrusisQ: 0,
  keySig: 0,
  practiceBpm: 72,
  bpm: 92,
  sections: [
    { label: '알프호른 (호른)', melody: BRAHMS_ALPHORN, chords: BRAHMS_ALPHORN_CHORDS, lead: 'hornLead', accomp: 'pad', dyn: 0.55 },
    { label: '큰 주제 · 현악', melody: brahmsTune(3), chords: brahmsTuneChords(3), lead: 'violin', transpose: 12, doubles: [{ part: 'cello', transpose: 0 }], accomp: 'pad', dyn: 0.6 },
    { label: '큰 주제 · 전체', melody: brahmsTune(4), chords: brahmsTuneChords(4), lead: 'violin', transpose: 12, doubles: [{ part: 'cello', transpose: 0 }, { part: 'hornLead', transpose: 0 }], accomp: 'pad', dyn: 0.92, horns: true, timp: true },
  ],
  ending: { chord: 'C', quarters: 4, melody: 72 },
};

// 차이콥스키 「백조의 호수」 — 정경(오보에 주제) (MTD 9180)
const SWAN_THEME: Mel = [
  [78, 2], [71, 0.5], [73, 0.5], [74, 0.5], [76, 0.5],
  [78, 1.5], [74, 0.5], [78, 1.5], [74, 0.5],
  [78, 1.5], [71, 0.5], [74, 0.5], [71, 0.5], [67, 0.5], [74, 0.5],
  [71, 4],
];
const SWAN_CHORDS = 'Bm:4 Bm:4 Bm:2 G:2 Bm:4';

const SWAN: SongSpec = {
  id: 'swanlake',
  title: '백조의 호수',
  composer: '차이콥스키 · 정경 (오보에 주제)',
  about: '선율: MTD 9180 · 편곡(화음) Air Band',
  beatsPerBar: 4,
  beatUnit: 1,
  anacrusisQ: 0,
  keySig: 2,
  practiceBpm: 66,
  bpm: 76,
  sections: [
    { label: '오보에 · 여리게', melody: SWAN_THEME, chords: SWAN_CHORDS, lead: 'oboe', accomp: 'pad', dyn: 0.5 },
    { label: '현악 + 호른 · 세게', melody: SWAN_THEME, chords: SWAN_CHORDS, lead: 'violin', doubles: [{ part: 'hornLead', transpose: -12 }], accomp: 'pad', dyn: 0.92, horns: true, timp: true },
  ],
  ending: { chord: 'Bm', quarters: 4, melody: 71 },
};

// 차이콥스키 「호두까기 인형」 꽃의 왈츠 — 호른 주제 (MTD 9167)
const WALTZ_THEME: Mel = [
  [57, 1], [62, 1], [66, 1],
  [67, 2.75], [66, 0.25],
  [66, 6],
  [57, 1], [62, 1], [66, 1],
  [67, 1], [66, 1.75], [64, 0.25],
  [69, 2], [62, 1],
];
const WALTZ_CHORDS = 'D:3 A7:3 D:6 D:3 A7:3 D:3';

const WALTZ: SongSpec = {
  id: 'flowers',
  title: '꽃의 왈츠',
  composer: '차이콥스키 · 「호두까기 인형」',
  about: '선율: MTD 9167 · 편곡(화음 · 왈츠 반주) Air Band',
  beatsPerBar: 3,
  beatUnit: 1,
  anacrusisQ: 0,
  keySig: 2,
  practiceBpm: 96,
  bpm: 126,
  sections: [
    { label: '호른 · 여리게', melody: WALTZ_THEME, chords: WALTZ_CHORDS, lead: 'hornLead', accomp: 'waltz', dyn: 0.55 },
    { label: '현악 + 호른 · 세게', melody: WALTZ_THEME, chords: WALTZ_CHORDS, lead: 'violin', transpose: 12, doubles: [{ part: 'hornLead', transpose: 0 }], accomp: 'waltz', dyn: 0.9, timp: true },
  ],
  ending: { chord: 'D', quarters: 3, melody: 78 },
};

// 홀스트 「행성」 목성 — 가운데 찬가 선율 (찬송가 「Thaxted」, Mutopia #527, 선율 · 코드 그대로). 3/4, 1박 못갖춘마디
const T_A: Mel = [[69, 1.5], [72, 0.5], [71, 0.75], [67, 0.25], [72, 0.5], [74, 0.5]];
const T_P1: Mel = [...T_A, [72, 1], [71, 1], [69, 0.5], [71, 0.5], [69, 1], [67, 1], [64, 2]];
const T_P2: Mel = [...T_A, [76, 1], [76, 1], [76, 0.5], [74, 0.5], [72, 1], [74, 1], [72, 2]];
const T_P3: Mel = [[62, 1.5], [62, 0.5], [60, 0.5], [64, 0.5], [62, 1], [67, 1], [67, 0.5], [64, 0.5], [62, 1.5], [62, 0.5], [64, 0.5], [67, 0.5], [69, 2]];
const T_P4: Mel = [[72, 0.75], [72, 0.25], [71, 1], [69, 1], [67, 1], [72, 1], [64, 1], [62, 0.5], [60, 0.5], [62, 1], [64, 1], [67, 2]];
const UP: Mel = [[64, 0.5], [67, 0.5]];

const JUPITER: SongSpec = {
  id: 'jupiter',
  title: '목성',
  composer: '홀스트 · 「행성」 중 목성 (찬가 선율)',
  about: '선율 · 코드: 찬송가 Thaxted (Mutopia #527, Public Domain) · 편곡 Air Band',
  beatsPerBar: 3,
  beatUnit: 1,
  anacrusisQ: 1,
  keySig: 0,
  practiceBpm: 72,
  bpm: 84,
  sections: [
    {
      label: '현악 · 여리게',
      melody: [...UP, ...T_P1, ...UP, ...T_P2, [67, 0.5], [64, 0.5]],
      chords: 'C:1 F:1 F:1 Dm:1 C:3 F:1 F:1 G:1 Am:2 G:1 F:2 Dm:1 C:3 F:3 C:2 C/E:1',
      lead: 'violin',
      accomp: 'pad',
      dyn: 0.5,
    },
    {
      label: '호른 더해서 · 점점 세게',
      melody: [...T_P3, [69, 0.5], [71, 0.5], ...T_P4, ...UP],
      chords: 'G:2 Am:1 G/B:2 C/E:1 G:2 C:1 F:1 F/E:1 Dm:1 Am:1 C/G:1 F:1 C/E:1 Dm7:1 C:1 F:1 Dm:1 Am/C:1 G/B:1 Am7:1 G:1',
      lead: 'violin',
      doubles: [{ part: 'cello', transpose: -12 }],
      accomp: 'pad',
      dyn: 0.7,
      horns: true,
    },
    {
      label: '전체 · 세게',
      melody: [...T_P1, ...UP, ...T_P2],
      chords: 'F:2 G7/B:1 C/E:1 C:1 Em:1 F:2 G:1 Am:2 G:1 F:2 G7/D:1 C/E:1 C:2 F:2 Dm/F:1 C:2',
      lead: 'violin',
      doubles: [{ part: 'hornLead', transpose: -12 }, { part: 'cello', transpose: -12 }],
      accomp: 'pad',
      dyn: 0.95,
      horns: true,
      timp: true,
    },
  ],
  ending: { chord: 'C', quarters: 4, melody: 72 },
};

export const SONGS: Score[] = [ODE_TO_JOY, ...[SCHUBERT, RACHMANINOFF, BRAHMS, SWAN, WALTZ, JUPITER].map(arrange)];
