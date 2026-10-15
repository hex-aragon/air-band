// 연주 영상 만들기 창: 미리보기 · 비율 · 길이 고르기 · 영상(MP4/WebM) 저장 · 그림(PNG) 저장
//
// [설명] 영상 저장 = 캔버스를 실시간으로 녹화한다 (canvas.captureStream + MediaRecorder).
//   그래서 저장에 영상 길이만큼 시간이 걸린다(30초 영상 = 30초). 그동안 화면에서 같이 재생된다.
//   소리는 내가 친 드럼 소리를 같은 시각에 다시 내서 함께 녹음한다. 유튜브 음악은 다른 사이트의 소리라 브라우저가 녹음을 막는다.
//   형식: 브라우저가 MP4 녹화를 지원하면 MP4(최신 크롬 · 사파리), 아니면 WebM.
import './studio.css';
import type { DrumAudio } from '../audio';
import { TrailRenderer, highlight, type TrailTake } from './trail';

type Ratio = '9:16' | '16:9' | '1:1';
const SIZES: Record<Ratio, [number, number]> = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
const HIGHLIGHT_MS = 30000;

let root: HTMLDivElement | null = null;

export function openStudio(take: TrailTake, audio: DrumAudio): void {
  closeStudio();
  let ratio: Ratio = '9:16';
  let short = take.durationMs > HIGHLIGHT_MS + 5000;
  let renderer: TrailRenderer | null = null;
  let raf = 0;
  let t0 = 0;
  let recording: { rec: MediaRecorder; stop: () => void } | null = null;
  let previewSounds: AudioBufferSourceNode[] = [];

  root = document.createElement('div');
  root.className = 'trail-studio';
  root.innerHTML = `
    <div class="ts-panel" role="dialog" aria-label="내 연주 영상">
      <div class="ts-head"><b>🎬 내 연주 영상</b><button class="ts-x" title="닫기">✕</button></div>
      <div class="ts-body">
        <div class="ts-stage"><canvas class="ts-canvas"></canvas><div class="ts-rec" hidden>● 녹화 중 <span></span></div></div>
        <div class="ts-side">
          <p class="ts-lead">스틱이 지나간 길이 빛으로 그려집니다. 끝나면 한 장의 그림으로 남아요.</p>
          <span class="ts-label">화면 비율</span>
          <div class="ts-seg" data-k="ratio">
            <button data-v="9:16">세로 9:16<small>쇼츠 · 릴스</small></button>
            <button data-v="16:9">가로 16:9<small>유튜브</small></button>
            <button data-v="1:1">정사각<small>피드</small></button>
          </div>
          <span class="ts-label">길이</span>
          <div class="ts-seg" data-k="len">
            <button data-v="short">하이라이트 30초</button>
            <button data-v="full">전체</button>
          </div>
          <button class="ts-save primary">⬇ 영상 저장</button>
          <button class="ts-png">🖼 완성 그림 저장 (PNG)</button>
          <div class="ts-bar" hidden><span></span></div>
          <p class="ts-note">영상에는 내가 친 드럼 소리가 들어갑니다. 유튜브 노래 소리는 넣을 수 없어요 (다른 사이트 소리는 브라우저가 녹음을 막고, 저작권도 있어요).</p>
        </div>
      </div>
    </div>`;
  document.body.append(root);
  const q = <T extends Element>(sel: string) => root!.querySelector(sel) as T;
  const view = q<HTMLCanvasElement>('.ts-canvas');
  const vctx = view.getContext('2d')!;

  const takeNow = () => (short ? highlight(take, HIGHLIGHT_MS) : take);

  function stopPreviewSounds(): void {
    for (const s of previewSounds) {
      try {
        s.stop();
      } catch {
        // 이미 끝남
      }
    }
    previewSounds = [];
  }

  /** 드럼 소리 예약 (미리보기 · 녹화 공통). 시작 시각 = 오디오 시각 at */
  function scheduleSounds(tk: TrailTake, at: number): AudioBufferSourceNode[] {
    return tk.hits.map((x) => audio.playAt(x.cls, Math.max(30, x.vel), at + x.t / 1000));
  }

  function rebuild(): void {
    const [w, h] = SIZES[ratio];
    renderer = new TrailRenderer(takeNow(), w, h);
    view.width = Math.round(w / 2);
    view.height = Math.round(h / 2);
    view.style.aspectRatio = `${w} / ${h}`;
    restartPreview();
    for (const seg of root!.querySelectorAll<HTMLElement>('.ts-seg')) {
      const cur = seg.dataset.k === 'ratio' ? ratio : short ? 'short' : 'full';
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.v === cur));
    }
    const lenSeg = root!.querySelector<HTMLElement>('.ts-seg[data-k="len"]')!;
    lenSeg.hidden = take.durationMs <= HIGHLIGHT_MS + 5000;
  }

  function restartPreview(): void {
    stopPreviewSounds();
    renderer?.reset();
    t0 = performance.now() + 300;
    void audio.resume();
    if (renderer && !recording) previewSounds = scheduleSounds(renderer.take, audio.ctx.currentTime + 0.3);
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    if (!renderer) return;
    const t = now - t0;
    const total = renderer.take.durationMs + TrailRenderer.OUTRO_MS;
    if (t > total + 800 && !recording) restartPreview();
    renderer.render(Math.max(0, Math.min(t, total)));
    vctx.drawImage(renderer.canvas, 0, 0, view.width, view.height);
    if (recording) {
      const p = Math.min(1, Math.max(0, t / total));
      q<HTMLElement>('.ts-bar span').style.width = `${(p * 100).toFixed(1)}%`;
      q<HTMLElement>('.ts-rec span').textContent = `${Math.round(p * 100)}%`;
      if (t >= total + 200) recording.stop();
    }
  }
  raf = requestAnimationFrame(frame);

  for (const seg of root.querySelectorAll<HTMLElement>('.ts-seg')) {
    seg.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      if (!b || recording) return;
      if (seg.dataset.k === 'ratio') ratio = b.dataset.v as Ratio;
      else short = b.dataset.v === 'short';
      rebuild();
    });
  }

  q('.ts-x').addEventListener('click', closeStudio);
  root.addEventListener('pointerdown', (ev) => {
    if (ev.target === root && !recording) closeStudio();
  });

  q('.ts-png').addEventListener('click', () => {
    const [w, h] = SIZES[ratio];
    const r = new TrailRenderer(takeNow(), w, h);
    r.finalFrame();
    r.canvas.toBlob((blob) => blob && download(blob, `${fileBase(take)}.png`), 'image/png');
  });

  q('.ts-save').addEventListener('click', () => {
    if (recording || !renderer) return;
    const mime = pickMime();
    if (!mime || typeof MediaRecorder === 'undefined' || !('captureStream' in renderer.canvas)) {
      alert('이 브라우저는 영상 녹화를 지원하지 않습니다. PC 크롬 · 엣지에서 해 보세요. (완성 그림 저장은 됩니다)');
      return;
    }
    stopPreviewSounds();
    void audio.resume();
    const video = renderer.canvas.captureStream(30);
    const dest = audio.ctx.createMediaStreamDestination();
    audio.connectTap(dest);
    const stream = new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const save = q<HTMLButtonElement>('.ts-save');
    rec.onstop = () => {
      audio.disconnectTap(dest);
      for (const tr of stream.getTracks()) tr.stop();
      recording = null;
      root?.classList.remove('busy');
      q<HTMLElement>('.ts-rec').hidden = true;
      q<HTMLElement>('.ts-bar').hidden = true;
      save.textContent = '⬇ 영상 저장';
      if (chunks.length) download(new Blob(chunks, { type: mime.split(';')[0] }), `${fileBase(take)}.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
      restartPreview();
    };
    renderer.reset();
    t0 = performance.now() + 300;
    const sounds = scheduleSounds(renderer.take, audio.ctx.currentTime + 0.3);
    recording = {
      rec,
      stop: () => {
        if (rec.state !== 'inactive') rec.stop();
        for (const s of sounds) {
          try {
            s.stop();
          } catch {
            // 이미 끝남
          }
        }
      },
    };
    rec.start(1000);
    root?.classList.add('busy');
    q<HTMLElement>('.ts-rec').hidden = false;
    q<HTMLElement>('.ts-bar').hidden = false;
    save.textContent = '녹화 중… (끝나면 자동 저장)';
  });

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && !recording) closeStudio();
    ev.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);

  (root as HTMLDivElement & { cleanup?: () => void }).cleanup = () => {
    cancelAnimationFrame(raf);
    stopPreviewSounds();
    recording?.stop();
    window.removeEventListener('keydown', onKey, true);
  };
  rebuild();
}

export function closeStudio(): void {
  if (!root) return;
  (root as HTMLDivElement & { cleanup?: () => void }).cleanup?.();
  root.remove();
  root = null;
}

function pickMime(): string | null {
  const list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return null;
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

function fileBase(take: TrailTake): string {
  const safe = take.title.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 40);
  return `airband_${safe}_${take.date.replace(/\./g, '')}`;
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
