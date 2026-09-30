// 드럼 샘플 로딩 · 재생
//
// 원칙: 앱 시작 시 모든 소리를 AudioBuffer로 준비해 두고, 이벤트가 오면
// AudioBufferSourceNode를 만들어 즉시 start()만 한다. (이벤트마다 fetch/디코딩 금지)

// [한눈에 보기] 이 파일이 하는 일
//   Web Audio API로 드럼 소리를 낸다.
//   - AudioContext   : 브라우저 안의 "오디오 엔진". 스피커로 나가는 출구(destination)를 가진다.
//   - AudioBuffer    : 메모리에 올려 둔 소리 데이터(숫자 배열, -1~1). 드럼 하나당 하나.
//   - BufferSource   : 버퍼를 한 번 재생하는 일회용 재생기. 칠 때마다 새로 만든다(가볍다).
//   - GainNode       : 볼륨 조절기. 세기(velocity)를 볼륨으로 바꾼다.
//   연결 모양:  BufferSource → Gain(세기) → master Gain(전체 볼륨) → 스피커
//
//   빠르게 소리 내는 비결: 시작할 때 소리를 전부 만들어 두고, 칠 때는 start()만 한다.
/**
 * class 번호 → 샘플 이름. 펌웨어의 버튼 1~4가 class 0~3을 보낸다.
 * 2단계에서 분류 클래스가 늘어나면 여기에 추가
 */
export const DRUM_CLASSES: Record<number, string> = {
  0: 'snare',
  1: 'kick',
  2: 'hihat',
  3: 'tom',
};

export interface PlayResult {
  /** start() 호출 시각 (performance.now) */
  startedAt: number;
  /** 오디오 출력 버퍼 지연 추정치 (ms) — baseLatency + outputLatency */
  outputLatencyMs: number;
}

export class DrumAudio {
  readonly ctx: AudioContext;
  private buffers = new Map<number, AudioBuffer>();
  private master: GainNode;
  /** 샘플 출처 표시용: 'file' 또는 'synth' */
  readonly sources = new Map<number, 'file' | 'synth'>();

  // [설명] latencyHint: 'interactive' → 브라우저에게 "지연이 가장 중요"하다고 알려서 작은 버퍼를 쓰게 한다.
  constructor() {
    // 'interactive' = 가장 작은 버퍼로 지연 최소화
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
  }

  /** 모든 샘플을 미리 디코딩. 파일이 없으면 합성 소리로 대체 */
  async init(): Promise<void> {
    await Promise.all(
      Object.entries(DRUM_CLASSES).map(async ([cls, name]) => {
        const id = Number(cls);
        const fromFile = await this.tryLoadFile(`samples/${name}.wav`);
        if (fromFile) {
          this.buffers.set(id, fromFile);
          this.sources.set(id, 'file');
        } else {
          this.buffers.set(id, synthesize(this.ctx, name));
          this.sources.set(id, 'synth');
        }
      }),
    );
  }

  /** 브라우저 자동재생 정책 때문에 사용자 클릭 시 호출해야 한다 */
  // [설명] 브라우저는 사용자가 클릭·키 입력을 하기 전까지 소리를 막아 둔다(자동재생 정책).
  //   그래서 버튼 클릭 등 사용자 동작 안에서 resume()을 불러 오디오 엔진을 깨운다.
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** 즉시 재생. velocity(0~127)는 볼륨에 반영 */
  play(cls: number, velocity: number): PlayResult {
    const buf = this.buffers.get(cls) ?? this.buffers.get(0)!;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const gain = this.ctx.createGain();
    gain.gain.value = velocityToGain(velocity);

    src.connect(gain).connect(this.master);
    src.start();
    const startedAt = performance.now();

    const outputLatencyMs = ((this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0)) * 1000;
    return { startedAt, outputLatencyMs };
  }

  private async tryLoadFile(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      return await this.ctx.decodeAudioData(data);
    } catch {
      // 파일 없음 / 디코딩 실패(개발 서버가 HTML을 돌려주는 경우 포함)
      return null;
    }
  }
}

/**
 * velocity(0~127) → 게인(0~1).
 * 사람 귀는 로그 스케일이라 선형으로 두면 약한 타격이 너무 크게 들린다. 1.6 제곱 곡선 사용.
 */
// [설명] 예) 세기 127 → 1.0,  100 → 0.68,  64 → 0.33,  32 → 0.11
export function velocityToGain(velocity: number): number {
  const v = Math.max(0, Math.min(127, velocity)) / 127;
  return Math.pow(v, 1.6);
}

// ---------------------------------------------------------------------------
// 합성 드럼 (외부 에셋 없이 바로 동작하도록)
// ---------------------------------------------------------------------------

// [설명] 소리 합성 기초
//   디지털 소리 = 1초에 sampleRate(보통 48000)개의 숫자. 각 숫자는 그 순간 스피커 떨림 위치(-1~1).
//   사인파 sin(위상)  : "둥-" 하는 음정 있는 소리. 주파수(Hz)가 낮을수록 낮은 음.
//   노이즈 random()   : "치-" 하는 음정 없는 소리 (스네어 와이어, 하이햇)
//   exp(-t × k)       : 시간이 지날수록 작아지는 감쇠. k가 클수록 빨리 사라진다.
//   드럼 = (음정 있는 부분 + 노이즈) × 감쇠 를 조합해 만든다.
function synthesize(ctx: AudioContext, name: string): AudioBuffer {
  switch (name) {
    case 'kick':
      return synthKick(ctx);
    case 'hihat':
      return synthHihat(ctx);
    case 'tom':
      return synthTom(ctx);
    case 'snare':
    default:
      return synthSnare(ctx);
  }
}

/** 버퍼를 만들고 샘플별 함수 f(t, i)로 채운 뒤 피크 0.95로 정규화 */
function render(ctx: AudioContext, dur: number, f: (t: number) => number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = f(t) * Math.min(1, t / 0.001); // 어택 클릭 방지용 1ms 페이드인
  }
  normalize(out);
  return buf;
}

function normalize(out: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.95 / peak;
}

/** 킥: 150Hz → 45Hz로 빠르게 떨어지는 사인 + 짧은 클릭 */
function synthKick(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  let phase = 0;
  return render(ctx, 0.5, (t) => {
    const freq = 45 + 105 * Math.exp(-t * 30);
    phase += (2 * Math.PI * freq) / sr;
    const body = Math.sin(phase) * Math.exp(-t * 7);
    const click = (Math.random() * 2 - 1) * Math.exp(-t * 400) * 0.3;
    return body + click;
  });
}

/** 하이햇(닫힘): 고역 통과 노이즈, 아주 짧은 감쇠 */
function synthHihat(ctx: AudioContext): AudioBuffer {
  let prev = 0;
  let hp = 0;
  return render(ctx, 0.12, (t) => {
    const white = Math.random() * 2 - 1;
    // 1차 하이패스를 계수 높게 → 대략 5kHz 이상만 남김
    hp = 0.55 * (hp + white - prev);
    prev = white;
    return hp * Math.exp(-t * 45);
  });
}

/** 탐: 킥보다 높은 음(180Hz → 110Hz) + 약한 노이즈 */
function synthTom(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  let phase = 0;
  return render(ctx, 0.45, (t) => {
    const freq = 110 + 70 * Math.exp(-t * 12);
    phase += (2 * Math.PI * freq) / sr;
    const body = Math.sin(phase) * Math.exp(-t * 9);
    const noise = (Math.random() * 2 - 1) * Math.exp(-t * 40) * 0.15;
    return body + noise;
  });
}

/** 스네어: 짧은 톤(몸통) + 대역 제한 노이즈(스내어 와이어) */
function synthSnare(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const dur = 0.35;
  const n = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);

  let phase = 0;
  let lp = 0; // 노이즈 저역 제거용 1차 필터 상태
  let prevNoise = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;

    // 몸통: 220Hz → 160Hz로 살짝 내려가는 사인, 빠른 감쇠
    const freq = 160 + 60 * Math.exp(-t * 40);
    phase += (2 * Math.PI * freq) / sr;
    const body = Math.sin(phase) * Math.exp(-t * 28) * 0.7;

    // 와이어: 화이트 노이즈를 1차 하이패스(대략 1kHz 이상)로 거른 뒤 감쇠
    const white = Math.random() * 2 - 1;
    lp = 0.87 * (lp + white - prevNoise);
    prevNoise = white;
    const noise = lp * Math.exp(-t * 18) * 0.9;

    // 어택 클릭 방지용 1ms 페이드인
    const attack = Math.min(1, t / 0.001);
    out[i] = (body + noise) * attack;
  }

  // 정규화 (피크 0.95)
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.95 / peak;
  return buf;
}
