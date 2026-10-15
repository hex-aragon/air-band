// 모든 페이지 공통 위 메뉴 + 스틱 연결 · 맞추기 안내
//
// [한눈에 보기]
//   ┌ 🥁 Air Band │ 🥁 드럼  🎼 클래식  🧠 머신러닝 │                [🟢 스틱 연결됨 ▾] ┐
//   └ (드럼일 때만) 리듬 게임 · 드럼 키트 · 패드 · 녹음                                    ┘
//
//   스틱 버튼 하나로 연결 · 맞추기 · 드럼 간격 · 끊기를 다 한다. 처음 연결하면 3단계 안내(위저드)가 뜬다:
//     ① 축 맞추기(처음 한 번, 스틱 세우기) → ② 정면 맞추기(화면 쪽 겨누기) → ③ 쳐 보기(방향마다 드럼 확인)
//
// [설명] 페이지 코드와 붙이는 법
//   1) 페이지 맨 처음에 mountHeader('kit') — 위 메뉴를 그리고, 예전 페이지 코드가 찾는 버튼(#connect · #phone · #status)을
//      숨겨서 만들어 둔다. 페이지의 연결 코드는 그대로 두고, 보이는 메뉴가 그 숨은 버튼을 눌러 준다.
//   2) 페이지가 conn.onState 등을 다 정한 뒤 attachStick(conn, {...}) — 그 콜백들을 감싸서 메뉴 · 안내도 같이 갱신한다.

import './header.css';
import { CMD, webBluetoothSupport, type AirBandConnection, type ConnState } from '../ble';
import { ZONE_PRESETS, getZoneWidth, setZoneWidth, type ZoneWidth } from '../motion';
import { DRUM_INFO } from '../drums';

export type PageId = 'home' | 'rhythm' | 'kit' | 'pads' | 'conduct' | 'tinyml';

const CATS: { id: string; icon: string; label: string; pages: { id: PageId; href: string; label: string }[] }[] = [
  {
    id: 'drum',
    icon: '🥁',
    label: '드럼',
    pages: [
      { id: 'rhythm', href: 'rhythm.html', label: '🎮 리듬 게임' },
      { id: 'kit', href: 'kit.html', label: '🥁 드럼 키트' },
      { id: 'pads', href: 'pads.html', label: '🎛 패드 · 녹음' },
    ],
  },
  { id: 'classic', icon: '🎼', label: '클래식', pages: [{ id: 'conduct', href: 'conduct.html', label: '🎼 지휘하기' }] },
  { id: 'ml', icon: '🧠', label: '머신러닝', pages: [{ id: 'tinyml', href: 'tinyml.html', label: '🧠 TinyML 내 스윙 학습' }] },
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

let stickBtn: HTMLButtonElement;
let pop: HTMLDivElement;

/** 위 메뉴를 페이지 맨 위에 넣는다. 페이지 스크립트의 첫 줄에서 부를 것 (예전 #connect 등을 찾기 전에) */
export function mountHeader(page: PageId): void {
  // 글꼴: Pretendard (한글이 또렷한 무료 글꼴). 못 받아도 시스템 글꼴로
  if (!document.getElementById('ab-font')) {
    const l = document.createElement('link');
    l.id = 'ab-font';
    l.rel = 'stylesheet';
    l.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
    document.head.append(l);
  }
  document.body.classList.add('ab-app');
  const cat = CATS.find((c) => c.pages.some((p) => p.id === page));

  const top = el('header', 'ab-top');
  const brand = el('a', 'ab-brand', '<span class="ab-logo">🥁</span><b>Air Band</b>');
  brand.href = './';
  const tabs = el('nav', 'ab-tabs');
  for (const c of CATS) {
    const a = el('a', c === cat ? 'on' : '', `<span>${c.icon}</span>${c.label}`);
    a.href = c.pages[0].href;
    tabs.append(a);
  }
  const stick = el('div', 'ab-stick');
  stickBtn = el('button', 'ab-stick-btn') as HTMLButtonElement;
  stickBtn.type = 'button';
  pop = el('div', 'ab-pop') as HTMLDivElement;
  pop.hidden = true;
  stick.append(stickBtn, pop);
  top.append(brand, tabs, stick);

  // 예전 페이지 코드가 찾는 요소들 (보이지 않게)
  const compat = el('div', 'ab-compat');
  compat.hidden = true;
  compat.innerHTML = `<button id="connect"></button><button id="phone"></button><b id="status" data-state="disconnected"></b>`;
  top.append(compat);

  document.body.prepend(top);
  if (cat && cat.pages.length > 1) {
    const sub = el('nav', 'ab-sub');
    for (const p of cat.pages) {
      const a = el('a', p.id === page ? 'on' : '', p.label);
      a.href = p.href;
      sub.append(a);
    }
    top.after(sub);
  }
  // 예전 페이지 머리말(header)은 숨긴다 (페이지별 버튼 중 필요한 것만 페이지가 다시 보여 줌)
  for (const h of document.querySelectorAll('body > header:not(.ab-top):not(.page-bar)')) (h as HTMLElement).hidden = true;

  renderStickBtn('disconnected');
  stickBtn.addEventListener('click', () => togglePop());
  document.addEventListener('pointerdown', (ev) => {
    if (!pop.hidden && !stick.contains(ev.target as Node)) pop.hidden = true;
  });
}

// ---------------------------------------------------------------------------
// 스틱 버튼 · 팝업
// ---------------------------------------------------------------------------
interface StickOpts {
  /** 'stick' 드럼 스틱, 'baton' 지휘봉 */
  kind?: 'stick' | 'baton';
  /** 드럼 간격 설정을 보여 주고 연결 때 보드에 보낼지 */
  zones?: boolean;
  /** 처음 연결하면 맞추기 안내를 자동으로 열지 */
  autoWizard?: boolean;
}
let conn: AirBandConnection | null = null;
let opts: Required<StickOpts> = { kind: 'stick', zones: true, autoWizard: true };
let state: ConnState = 'disconnected';
let detail = '';
const noun = () => (opts.kind === 'baton' ? '지휘봉' : '스틱');

function renderStickBtn(s: ConnState): void {
  stickBtn.dataset.state = s;
  stickBtn.innerHTML =
    s === 'connected'
      ? `<i class="dot"></i>${noun()} 연결됨 <span class="car">▾</span>`
      : s === 'connecting'
        ? `<i class="dot"></i>연결 중…`
        : `<i class="dot"></i>${noun()} 연결`;
}

function togglePop(force?: boolean): void {
  const open = force ?? pop.hidden;
  if (!open) {
    pop.hidden = true;
    return;
  }
  pop.innerHTML = '';
  if (state === 'connected') {
    pop.append(el('div', 'ab-pop-title', `✅ ${detail || noun() + ' 연결됨'}`));
    const cal = el('button', 'ab-item', `<b>🎯 ${noun()} 맞추기</b><small>방향이 안 맞을 때 · 축 · 정면 다시</small>`);
    cal.addEventListener('click', () => {
      pop.hidden = true;
      openWizard(1);
    });
    pop.append(cal);
    if (opts.zones) pop.append(zoneControl());
    const off = el('button', 'ab-item danger', `<b>연결 끊기</b>`);
    off.addEventListener('click', () => {
      pop.hidden = true;
      clickCompat('connect');
    });
    pop.append(off);
  } else {
    const bt = webBluetoothSupport();
    pop.append(el('div', 'ab-pop-title', `무엇으로 칠까요?`));
    const board = el('button', 'ab-item', `<b>🥢 누코드 ${noun()}</b><small>블루투스로 AirBand-R 연결 (PC · 안드로이드 크롬)</small>`) as HTMLButtonElement;
    board.disabled = !bt.ok;
    board.addEventListener('click', () => {
      pop.hidden = true;
      clickCompat('connect');
    });
    const phone = el('button', 'ab-item', `<b>📱 이 폰을 ${noun()}으로</b><small>보드 없이 폰을 쥐고 휘두르기 (폰에서)</small>`);
    phone.addEventListener('click', () => {
      pop.hidden = true;
      clickCompat('phone');
    });
    pop.append(board, phone);
    if (!bt.ok) pop.append(el('p', 'ab-note', bt.reason!));
    pop.append(el('p', 'ab-note', '센서가 없어도 키보드 · 마우스 · 터치로 할 수 있어요'));
  }
  pop.hidden = false;
}

function zoneControl(): HTMLElement {
  const box = el('div', 'ab-zone', `<b>↔ 드럼 간격</b><small>스틱을 크게 휘두르면 넓게</small>`);
  const seg = el('div', 'ab-seg');
  for (const w of [1, 2, 3] as ZoneWidth[]) {
    const b = el('button', getZoneWidth() === w ? 'on' : '', `${ZONE_PRESETS[w].label}<small>${ZONE_PRESETS[w].side}°</small>`);
    b.addEventListener('click', () => {
      setZoneWidth(w);
      void conn?.send(String(w));
      for (const x of seg.children) x.classList.toggle('on', x === b);
    });
    seg.append(b);
  }
  box.append(seg);
  return box;
}

/** 페이지의 숨은 버튼 누르기 (페이지의 연결 코드가 오디오 켜기 · 연결 · 끊기를 한다) */
function clickCompat(id: 'connect' | 'phone'): void {
  (document.getElementById(id) as HTMLButtonElement | null)?.click();
}

// ---------------------------------------------------------------------------
// 페이지 연결
// ---------------------------------------------------------------------------
export function attachStick(c: AirBandConnection, o: StickOpts = {}): void {
  conn = c;
  opts = { kind: 'stick', zones: true, autoWizard: true, ...o };
  const pageState = c.onState;
  c.onState = (s, d) => {
    pageState(s, d);
    state = s;
    detail = s === 'connected' ? `연결됨 · ${d ?? ''}` : '';
    renderStickBtn(s);
    if (s === 'connected') {
      if (opts.zones) void c.send(String(getZoneWidth()));
      let shown = false;
      try {
        shown = sessionStorage.getItem('airband.wizardShown') === '1';
        sessionStorage.setItem('airband.wizardShown', '1');
      } catch {
        // 저장 불가 — 매번 보여 줌
      }
      if (opts.autoWizard && !shown) openWizard(1);
    } else if (s === 'disconnected') {
      closeWizard();
      if (d) toast(d);
    }
  };
  const pageAxis = c.onAxis;
  c.onAxis = (r) => {
    pageAxis(r);
    wizardAxis(r.ok);
  };
  const pageMotion = c.onMotion;
  c.onMotion = (m) => {
    pageMotion(m);
    wizardAim(m.zone);
  };
  const pageHit = c.onHit;
  c.onHit = (e) => {
    pageHit(e);
    wizardHit(e.cls);
  };
}

/** 키보드 A / C 같은 단축키용: 안내 창을 그 단계로 연다 */
export function calibrate(step: 'axis' | 'center'): void {
  if (state !== 'connected') {
    toast(`먼저 ${noun()}을 연결하세요`);
    return;
  }
  openWizard(step === 'axis' ? 1 : 2);
}

export const stickConnected = () => state === 'connected';

// ---------------------------------------------------------------------------
// 맞추기 안내 (3단계)
// ---------------------------------------------------------------------------
let dlg: HTMLDivElement | null = null;
let step = 1;
let timer: ReturnType<typeof setInterval> | null = null;
let waitingAxis = false;
let aimCls = -1;
const triedCls = new Set<number>();

function closeWizard(): void {
  if (timer) clearInterval(timer);
  timer = null;
  waitingAxis = false;
  dlg?.remove();
  dlg = null;
}

function openWizard(s: number): void {
  closeWizard();
  step = s;
  triedCls.clear();
  dlg = el('div', 'ab-wiz-back') as HTMLDivElement;
  dlg.addEventListener('pointerdown', (ev) => {
    if (ev.target === dlg) closeWizard();
  });
  document.body.append(dlg);
  renderWizard();
}

function renderWizard(extra?: { count?: number; result?: 'ok' | 'fail' }): void {
  if (!dlg) return;
  const n = noun();
  const steps = opts.kind === 'baton' ? 2 : 3;
  const dots = Array.from({ length: steps }, (_, i) => `<i class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}"></i>`).join('');
  let body = '';
  let actions = '';
  if (step === 1) {
    body = `
      <div class="ab-ill ab-ill-up"><div class="stick"></div><div class="arrow">⬆</div></div>
      <h3>① ${n} 축 맞추기 <small>처음 한 번만</small></h3>
      <p>${n} 끝이 <b>천장</b>을 향하게 똑바로 세우고 <b>가만히</b> 드세요.<br />센서를 어떻게 붙였든 이걸로 ${n} 방향을 알아냅니다.</p>`;
    actions = `<button class="ghost" data-act="skip">이미 했어요 → 다음</button><button class="primary" data-act="axis">시작 (3초)</button>`;
  } else if (step === 2) {
    body = `
      <div class="ab-ill ab-ill-front"><div class="screen">💻</div><div class="stick"></div></div>
      <h3>② 정면 맞추기</h3>
      <p>${n}을 <b>화면(노트북) 쪽</b>으로 겨누고 가만히 드세요.<br />${opts.kind === 'baton' ? '그 방향이 오케스트라 가운데가 됩니다.' : '그 방향이 <b>스네어</b>(정면 북)가 됩니다.'}</p>`;
    actions = `<button class="ghost" data-act="back">이전</button><button class="primary" data-act="center">시작 (2초)</button>`;
  } else {
    const order = [2, 0, 3, 4];
    const chips = order
      .map((cls) => {
        const i = DRUM_INFO[cls];
        return `<div class="ab-chip ${aimCls === cls ? 'aim' : ''} ${triedCls.has(cls) ? 'ok' : ''}" style="--h:${(200 + cls * 70) % 360}"><b>${i.name}</b><small>${i.where}</small></div>`;
      })
      .join('');
    body = `
      <h3>③ 쳐 보기</h3>
      <p>방향마다 한 번씩 쳐 보세요. 지금 겨눈 곳이 밝게, 친 드럼에 ✓가 생깁니다.</p>
      <div class="ab-chips">${chips}</div>
      <p class="ab-small">킥(큰북)은 보드 버튼 2 또는 스페이스 · 옆 드럼이 너무 쉽게/어렵게 바뀌면 간격을 바꾸세요</p>`;
    actions = `<button class="primary" data-act="done">완료</button>`;
  }
  if (extra?.count) body += `<div class="ab-count">${extra.count}</div>`;
  if (extra?.result === 'ok') body += `<div class="ab-result ok">✓ 완료</div>`;
  if (extra?.result === 'fail') body += `<div class="ab-result fail">✗ 흔들렸어요 — 가만히 들고 다시</div>`;
  dlg.innerHTML = `<div class="ab-wiz" role="dialog" aria-modal="true">
    <button class="ab-x" data-act="close" aria-label="닫기">✕</button>
    <div class="ab-dots">${dots}</div>${body}<div class="ab-act">${actions}</div></div>`;
  if (step === 3 && opts.zones) dlg.querySelector('.ab-act')!.before(zoneControl());
  for (const b of dlg.querySelectorAll<HTMLButtonElement>('[data-act]')) b.addEventListener('click', () => act(b.dataset.act!));
  if (extra?.count) for (const b of dlg.querySelectorAll<HTMLButtonElement>('.ab-act button')) b.disabled = true;
}

function act(a: string): void {
  if (a === 'close' || a === 'done') return closeWizard();
  if (a === 'skip') return go(2);
  if (a === 'back') return go(1);
  if (a === 'axis') {
    countdown(3, () => {
      waitingAxis = true;
      void conn?.send(CMD.axis);
      // 보드가 답을 안 주면(예전 펌웨어) 2초 뒤 그냥 다음으로
      setTimeout(() => {
        if (waitingAxis) wizardAxis(true);
      }, 2000);
    });
  }
  if (a === 'center') {
    countdown(2, () => {
      void conn?.send(CMD.recenter);
      renderWizard({ result: 'ok' });
      setTimeout(() => go(opts.kind === 'baton' ? 0 : 3), 700);
    });
  }
}

function go(s: number): void {
  if (s === 0) return closeWizard();
  step = s;
  renderWizard();
}

function countdown(sec: number, done: () => void): void {
  if (timer) clearInterval(timer);
  let left = sec;
  renderWizard({ count: left });
  timer = setInterval(() => {
    left--;
    if (left > 0) return renderWizard({ count: left });
    clearInterval(timer!);
    timer = null;
    done();
  }, 1000);
}

function wizardAxis(ok: boolean): void {
  if (!dlg || !waitingAxis) return;
  waitingAxis = false;
  renderWizard({ result: ok ? 'ok' : 'fail' });
  if (ok) setTimeout(() => go(2), 700);
}

function wizardAim(cls: number): void {
  if (!dlg || step !== 3 || cls === aimCls) return;
  aimCls = cls;
  renderWizard();
}

function wizardHit(cls: number): void {
  if (!dlg || step !== 3) return;
  triedCls.add(cls);
  renderWizard();
}

// ---------------------------------------------------------------------------
// 짧은 알림
// ---------------------------------------------------------------------------
export function toast(msg: string): void {
  const t = el('div', 'ab-toast', msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}
