// 축 맞추기 · 정면 맞추기 카운트다운
//
// [설명] 버튼을 누르는 손과 스틱을 든 손이 같으면, 누르는 순간 스틱이 흔들리거나 자세가 틀어진다.
//   그래서 바로 보내지 않고 몇 초 세는 동안 자세를 잡게 한 뒤 보드에 명령을 보낸다.
//   축 맞추기('a')는 보드가 직전 0.2초 동안 가만히 있었는지 보므로 특히 필요하다.

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * seconds초 센 뒤 run(). 세는 동안 show(남은 초)로 안내. 이미 세는 중이면 취소하고 새로 센다.
 * @returns 취소 함수
 */
export function countdown(seconds: number, show: (left: number) => void, run: () => void): () => void {
  cancelCountdown();
  let left = seconds;
  show(left);
  timer = setInterval(() => {
    left--;
    if (left > 0) {
      show(left);
      return;
    }
    cancelCountdown();
    run();
  }, 1000);
  return cancelCountdown;
}

export function cancelCountdown(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 축 맞추기 안내 · 시간 */
export const AXIS_SECONDS = 3;
export const AXIS_PROMPT = (left: number) => `스틱 끝을 천장으로 세우고 가만히… ${left}`;
/** 정면 맞추기 안내 · 시간 */
export const CENTER_SECONDS = 2;
export const CENTER_PROMPT = (left: number) => `스틱을 스네어 칠 자리에 겨누고 가만히… ${left}`;
/** 축 맞추기 성공 뒤 안내. 자이로 오차는 보드를 1초쯤 내려 두면 저절로 다시 잰다 (펌웨어 GyroBias) */
export const AXIS_OK = (x: string, y: string, z: string) =>
  `축 저장됨 (${x}, ${y}, ${z}) → 스틱을 스네어 쪽으로 겨누고 ② 정면 맞추기. 방향이 자꾸 흘러가면 보드를 1~2초 내려놓았다가 다시 정면 맞추기`;
