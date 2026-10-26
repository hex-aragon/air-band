// 유튜브 영상 재생 (IFrame Player API)
//
// [설명] 유튜브 소리 파일을 내려받아 쓰는 것은 저작권 · 유튜브 약관 위반이라, 영상을 페이지에 그대로 넣어(임베드) 재생한다.
//   게임은 영상의 "지금 재생 위치"(getCurrentTime)를 시계로 써서 노트를 맞춘다.
//   영상 주인이 "다른 사이트에서 재생"을 막아 둔 영상은 오류 101/150이 난다 → 다른 영상(공식 오디오 · 가사 영상 등)을 쓰면 된다.

// 필요한 부분만 적은 타입 (@types/youtube 없이)
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { title?: string };
  loadVideoById(id: string): void;
  cueVideoById(id: string): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement | string, opts: unknown) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** 플레이어 상태 번호 (YT.PlayerState) */
export const YT_STATE = { ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 } as const;

let apiPromise: Promise<YTNamespace> | null = null;
function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT!);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('유튜브 플레이어를 불러오지 못했습니다 (인터넷 연결 확인)'));
    };
    document.head.append(s);
  });
  return apiPromise;
}

/** 링크 → 영상 id (watch?v= · youtu.be/ · shorts/ · embed/ · id 그대로) */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 11);
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const ERRORS: Record<number, string> = {
  2: '영상 주소가 잘못됐습니다',
  5: '이 브라우저에서 영상을 재생할 수 없습니다',
  100: '영상을 찾을 수 없습니다 (삭제 · 비공개)',
  101: '영상 주인이 다른 사이트에서의 재생을 막아 두었습니다 — 같은 곡의 다른 영상(공식 오디오 · 가사 영상)을 써 보세요',
  150: '영상 주인이 다른 사이트에서의 재생을 막아 두었습니다 — 같은 곡의 다른 영상(공식 오디오 · 가사 영상)을 써 보세요',
};

export class YouTubeTrack {
  onState: (state: number) => void = () => {};
  onError: (message: string) => void = () => {};
  videoId = '';
  private player: YTPlayer | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly el: HTMLElement) {}

  /** 영상 불러오기 (재생은 안 함). 처음이면 플레이어를 만든다 */
  async load(videoId: string): Promise<void> {
    this.videoId = videoId;
    if (this.ready) {
      await this.ready;
      if (this.player) this.player.cueVideoById(videoId);
      return;
    }
    // [주의] new YT.Player()가 돌려준 객체는 onReady 전에는 메서드가 없다 → 준비된 뒤에만 this.player에 넣는다
    this.ready = loadApi().then(
      (YT) =>
        new Promise<void>((resolve) => {
          const p = new YT.Player(this.el, {
            videoId,
            width: '100%',
            height: '100%',
            // controls 0 · disablekb 1: 게임 중 영상을 멋대로 넘기거나 스페이스가 영상으로 가지 않게
            playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
            events: {
              onReady: () => {
                this.player = p;
                if (this.videoId !== videoId) p.cueVideoById(this.videoId);
                resolve();
              },
              onStateChange: (e: { data: number }) => this.onState(e.data),
              onError: (e: { data: number }) => this.onError(ERRORS[e.data] ?? `영상 오류 ${e.data}`),
            },
          });
        }),
    );
    this.ready.catch(() => (this.ready = null));
    await this.ready;
  }

  get loaded(): boolean {
    return this.player !== null;
  }
  get state(): number {
    return this.player?.getPlayerState() ?? -1;
  }
  get playing(): boolean {
    return this.state === YT_STATE.playing;
  }
  /** 지금 재생 위치 (ms) */
  get timeMs(): number {
    return (this.player?.getCurrentTime() ?? 0) * 1000;
  }
  get durationMs(): number {
    return (this.player?.getDuration() ?? 0) * 1000;
  }
  get title(): string {
    return this.player?.getVideoData().title ?? '';
  }
  play(fromMs?: number): void {
    if (fromMs !== undefined) this.player?.seekTo(fromMs / 1000, true);
    this.player?.playVideo();
  }
  pause(): void {
    this.player?.pauseVideo();
  }
}
