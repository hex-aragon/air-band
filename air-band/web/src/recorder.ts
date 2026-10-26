// 연주 녹음 · 공유 링크 · MIDI 내보내기 (화면과 소리는 모르는 순수 계산 코드)

// [한눈에 보기]
//   연주 = "언제(ms), 어떤 드럼, 얼마나 세게"의 목록이다. 3분 연주도 수백 개, 몇 KB밖에 안 된다.
//   - Recorder        : 녹음 시작 시각을 기준으로 타격을 쌓는다
//   - encodeTake()    : 연주를 URL에 넣을 수 있는 짧은 글자로 (공유 링크)
//   - takeToMidi()    : 표준 MIDI 파일(.mid)로 — GarageBand, 큐베이스, MuseScore 등에서 바로 열린다
//   - loadTakes()/saveTakes() : 이 브라우저에만 저장 (localStorage)

export interface TakeEvent {
  t: number; // 녹음 시작 기준 ms (정수)
  cls: number; // 드럼 클래스 (audio.ts DRUM_CLASSES)
  vel: number; // 1~127
}

export interface Take {
  id: string;
  name: string;
  createdAt: number; // Date.now()
  durationMs: number;
  events: TakeEvent[];
}

/** 보드 시각으로 다시 계산한 값이 받은 시각과 이보다 차이 나면 믿지 않는다 (BLE 지연은 보통 수십 ms) */
const MAX_BOARD_FIX_MS = 300;

/** 녹음 중인 연주 */
// [설명] 보드 타격은 보드 시각(boardMs)도 함께 기억해 둔다. 녹음을 끝낼 때 그동안 찾은 가장 좋은
//   "보드 시각 → 브라우저 시각" 차이(boardOffset)로 다시 계산하면, 녹음 초반 기준이 덜 잡혔을 때
//   들어온 타격의 BLE 흔들림까지 없앨 수 있다.
export class Recorder {
  private startAt = 0;
  private events: (TakeEvent & { boardMs?: number })[] = [];
  recording = false;

  /** @param now 기준 시각 (performance.now 단위) */
  start(now: number): void {
    this.startAt = now;
    this.events = [];
    this.recording = true;
  }

  /**
   * @param at 타격 시각 (performance.now 단위)
   * @param boardMs 보드 타격이면 보드 시각 (stop()에서 다시 계산할 때 씀)
   */
  add(at: number, cls: number, vel: number, boardMs?: number): void {
    if (!this.recording) return;
    this.events.push({ t: Math.max(0, Math.round(at - this.startAt)), cls, vel: clampVel(vel), boardMs });
  }

  get count(): number {
    return this.events.length;
  }

  elapsed(now: number): number {
    return this.recording ? now - this.startAt : 0;
  }

  /**
   * 녹음을 끝내고 연주를 돌려준다. 친 게 없으면 null
   * @param boardOffset 최종 (브라우저 시각 - 보드 시각) 최솟값. 주면 보드 타격 시각을 이 값으로 다시 계산
   */
  stop(now: number, name: string, boardOffset?: number): Take | null {
    this.recording = false;
    if (this.events.length === 0) return null;
    const fix = boardOffset !== undefined && Number.isFinite(boardOffset);
    const events: TakeEvent[] = this.events.map(({ t, cls, vel, boardMs }) => {
      if (!fix || boardMs === undefined) return { t, cls, vel };
      const fixed = Math.max(0, Math.round(boardMs + boardOffset! - this.startAt));
      // 녹음 중 보드가 재부팅되면 보드 시계가 0부터 다시 시작한다 → 크게 어긋나면 받은 시각을 그대로 쓴다
      return { t: Math.abs(fixed - t) <= MAX_BOARD_FIX_MS ? fixed : t, cls, vel };
    });
    // BLE 보정으로 순서가 살짝 바뀔 수 있어 시각순으로 정렬
    events.sort((a, b) => a.t - b.t);
    const last = events[events.length - 1].t;
    return {
      id: newId(),
      name,
      createdAt: Date.now(),
      durationMs: Math.max(Math.round(now - this.startAt), last + 1),
      events,
    };
  }
}

function clampVel(v: number): number {
  return Math.max(1, Math.min(127, Math.round(v)));
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------------------
// 공유 링크 인코딩
// ---------------------------------------------------------------------------
// [설명] 형식 (바이트 배열 → base64url 글자)
//   [0] 버전(1)
//   varint 길이(ms) · varint 타격 수
//   타격마다: varint (앞 타격과의 간격 ms) · 1바이트 드럼 · 1바이트 세기
//   varint = 7비트씩 끊어 쓰고, 뒤에 더 있으면 맨 윗비트를 1로 둔다 (작은 수는 1바이트)
//   간격은 보통 100~500ms라 2바이트 → 타격 하나에 4바이트, 300타 연주가 링크 약 1.6KB
const FORMAT_VERSION = 1;
const MAX_EVENTS = 20000;

function writeVarint(out: number[], n: number): void {
  let v = Math.max(0, Math.floor(n));
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function readVarint(b: Uint8Array, pos: { i: number }): number {
  let v = 0;
  let mul = 1;
  for (let k = 0; k < 5; k++) {
    if (pos.i >= b.length) throw new Error('잘린 데이터');
    const byte = b[pos.i++];
    v += (byte & 0x7f) * mul;
    if (!(byte & 0x80)) return v;
    mul *= 128;
  }
  throw new Error('잘못된 숫자');
}

export function encodeTake(take: Take): string {
  const out: number[] = [FORMAT_VERSION];
  writeVarint(out, take.durationMs);
  writeVarint(out, take.events.length);
  let prev = 0;
  for (const e of take.events) {
    writeVarint(out, e.t - prev);
    out.push(e.cls & 0xff, clampVel(e.vel));
    prev = e.t;
  }
  return toBase64Url(new Uint8Array(out));
}

/** 공유 링크 글자 → 연주. 형식이 틀리면 예외 */
export function decodeTake(code: string, name = '공유받은 연주'): Take {
  const b = fromBase64Url(code);
  if (b[0] !== FORMAT_VERSION) throw new Error(`모르는 형식 버전 ${b[0]}`);
  const pos = { i: 1 };
  const durationMs = readVarint(b, pos);
  const n = readVarint(b, pos);
  if (n > MAX_EVENTS) throw new Error('타격이 너무 많음');
  const events: TakeEvent[] = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    t += readVarint(b, pos);
    if (pos.i + 2 > b.length) throw new Error('잘린 데이터');
    events.push({ t, cls: b[pos.i], vel: clampVel(b[pos.i + 1]) });
    pos.i += 2;
  }
  return { id: newId(), name, createdAt: Date.now(), durationMs: Math.max(durationMs, t + 1), events };
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): Uint8Array {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// MIDI 내보내기
// ---------------------------------------------------------------------------
// [설명] 표준 MIDI 파일 = 헤더(MThd) + 트랙(MTrk). 트랙 안은 "앞 이벤트와의 간격(틱) + 메시지"의 반복.
//   드럼은 General MIDI 규칙상 10번 채널(코드에서는 9)이고, 노트 번호가 곧 악기다.
//   템포 120 BPM, 4분음표 = 480틱 → 1틱 = 1.0417ms
/** 드럼 클래스 → General MIDI 드럼 노트 번호 */
export const GM_DRUM_NOTE: Record<number, number> = {
  0: 38, // Acoustic Snare
  1: 36, // Bass Drum 1
  2: 42, // Closed Hi-Hat
  3: 45, // Low Tom
  4: 49, // Crash Cymbal 1
};
const PPQ = 480;
const TEMPO_US = 500_000; // 4분음표 하나 = 0.5초 (120 BPM)
const NOTE_LEN_MS = 60;

export function takeToMidi(take: Take): Uint8Array<ArrayBuffer> {
  const msToTick = (ms: number) => Math.round((ms * 1000 * PPQ) / TEMPO_US);
  // 노트 온/오프를 시각순으로 펼친다. 같은 틱이면 오프를 먼저 (같은 음 연타가 끊기지 않게)
  const msgs: { tick: number; order: number; bytes: number[] }[] = [];
  for (const e of take.events) {
    const note = GM_DRUM_NOTE[e.cls] ?? 38;
    msgs.push({ tick: msToTick(e.t), order: 1, bytes: [0x99, note, clampVel(e.vel)] });
    msgs.push({ tick: msToTick(e.t + NOTE_LEN_MS), order: 0, bytes: [0x89, note, 0] });
  }
  msgs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const trk: number[] = [];
  // 시작: 트랙 이름 + 템포
  const name = new TextEncoder().encode(take.name.slice(0, 60));
  trk.push(0x00, 0xff, 0x03);
  writeVlq(trk, name.length);
  trk.push(...name);
  trk.push(0x00, 0xff, 0x51, 0x03, (TEMPO_US >> 16) & 0xff, (TEMPO_US >> 8) & 0xff, TEMPO_US & 0xff);
  let prevTick = 0;
  for (const m of msgs) {
    writeVlq(trk, m.tick - prevTick);
    trk.push(...m.bytes);
    prevTick = m.tick;
  }
  const endTick = Math.max(prevTick, msToTick(take.durationMs));
  writeVlq(trk, endTick - prevTick);
  trk.push(0xff, 0x2f, 0x00); // 트랙 끝

  const out: number[] = [];
  out.push(...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ));
  out.push(...ascii('MTrk'), ...u32(trk.length), ...trk);
  return new Uint8Array(out);
}

// MIDI 가변 길이 수(VLQ): 7비트씩, 앞쪽 바이트의 맨 윗비트가 1 (varint와 바이트 순서가 반대)
function writeVlq(out: number[], n: number): void {
  let v = Math.max(0, Math.floor(n));
  const stack = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    stack.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

// ---------------------------------------------------------------------------
// 이 브라우저에 저장 (localStorage) — 시크릿 창 등에서는 저장이 안 될 수 있다
// ---------------------------------------------------------------------------
const STORE_KEY = 'airband.takes.v1';
export const MAX_SAVED_TAKES = 30;

export function loadTakes(): Take[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Take[];
    return Array.isArray(arr) ? arr.filter((t) => t && Array.isArray(t.events)) : [];
  } catch {
    return [];
  }
}

/** 저장 성공 여부를 돌려준다 */
export function saveTakes(takes: Take[]): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(takes.slice(0, MAX_SAVED_TAKES)));
    return true;
  } catch {
    return false;
  }
}

/** 표시용: 1:05.3 */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
