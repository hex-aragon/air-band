// 드럼 이름표: 처음 보는 사람도 알 수 있게 이름 + 무엇인지 + 어느 쪽으로 치는지 (드럼 class 번호 순서는 audio.ts · 펌웨어와 같음)
export const DRUM_INFO: Record<number, { name: string; what: string; where: string }> = {
  0: { name: '스네어', what: '작은북 · "딱"', where: '정면' },
  1: { name: '킥', what: '큰북 · "쿵"', where: '버튼 2 · 스페이스' },
  2: { name: '하이햇', what: '작은 심벌 · "치"', where: '← 왼쪽' },
  3: { name: '탐', what: '둥근 북 · "둥"', where: '오른쪽 →' },
  4: { name: '크래시', what: '큰 심벌 · "쨍"', where: '↑ 위로' },
};
