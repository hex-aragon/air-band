import './tennis.css';
import { AirBandConnection, webBluetoothSupport } from './ble';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connect = element<HTMLButtonElement>('connect');
const connectionStatus = element('connection-status');
const support = element('support');
const ball = document.getElementById('ball')!;
const events = element<HTMLOListElement>('events');
const power = element<HTMLMeterElement>('power-meter');
const conn = new AirBandConnection();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let sensorCount = 0;
let demoCount = 0;
let connected = false;
let frame = 0;

function resetBall(): void {
  cancelAnimationFrame(frame);
  ball.setAttribute('transform', 'translate(450 400)');
}

// A visual response only: the packet has no racket position or ball trajectory.
function animateBall(velocity: number): void {
  resetBall();
  if (reducedMotion.matches) return;
  const started = performance.now();
  const duration = 1100 - (velocity / 127) * 350;
  function draw(now: number): void {
    const t = Math.min(1, (now - started) / duration);
    const x = 450 + 90 * Math.sin(t * Math.PI / 2);
    const y = 400 - 205 * t - 105 * Math.sin(t * Math.PI);
    ball.setAttribute('transform', `translate(${x} ${y}) scale(${1 - t * .5})`);
    if (t < 1) frame = requestAnimationFrame(draw);
    else resetBall();
  }
  frame = requestAnimationFrame(draw);
}

function hit(value: number, source: 'sensor' | 'demo'): void {
  const velocity = Math.max(1, Math.min(127, Math.round(value)));
  const label = source === 'sensor' ? '보드 입력' : '데모 스윙';
  if (source === 'sensor') sensorCount++;
  else demoCount++;
  element('sensor-count').textContent = String(sensorCount).padStart(2, '0');
  element('demo-count').textContent = String(demoCount).padStart(2, '0');
  element('power-value').textContent = String(velocity);
  power.value = velocity;
  power.textContent = String(velocity);
  element('input-source').textContent = source === 'sensor' ? '보드에서 수신' : '데모 입력 · 센서 기록 아님';
  element('shot-message').textContent = `${label} · 세기 ${velocity}/127`;
  events.querySelector('.empty')?.remove();
  const row = document.createElement('li');
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString('ko-KR', { hour12: false });
  const name = document.createElement('span');
  name.textContent = label;
  const strength = document.createElement('span');
  strength.className = 'event-power';
  strength.textContent = `${velocity} / 127`;
  row.append(time, name, strength);
  events.prepend(row);
  while (events.children.length > 5) events.lastElementChild!.remove();
  animateBall(velocity);
}

conn.onHit = (event) => {
  // Board buttons and IMU hits share this protocol; don't claim to distinguish them.
  if (event.velocity > 0) hit(event.velocity, 'sensor');
};
const availability = webBluetoothSupport();
conn.onState = (state, detail) => {
  connected = state === 'connected';
  connect.disabled = state === 'connecting' || !availability.ok;
  connect.textContent = connected ? '연결 끊기' : state === 'connecting' ? '연결 중…' : '센서 연결 ↗';
  connectionStatus.textContent = connected ? `연결됨 · ${detail ?? 'AirBand-R'}` : state === 'connecting' ? '기기를 연결하고 있어요' : detail ?? '센서 연결 전';
};
connect.addEventListener('click', () => {
  if (connected) conn.disconnect();
  else void conn.connect().catch(() => { /* onState displays the error. */ });
});
element('demo').addEventListener('click', () => hit(85, 'demo'));
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  // Preserve native keyboard activation for focused controls.
  if (event.target instanceof HTMLElement && event.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  hit(85, 'demo');
});
element('reset').addEventListener('click', () => {
  sensorCount = demoCount = 0;
  element('sensor-count').textContent = element('demo-count').textContent = '00';
  element('power-value').textContent = '—';
  power.value = 0;
  power.textContent = '0';
  element('input-source').textContent = '입력 대기';
  element('shot-message').textContent = '준비되면, 가볍게 한 번.';
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = '첫 스윙을 기다리고 있어요.';
  events.replaceChildren(empty);
  resetBall();
});
reducedMotion.addEventListener('change', resetBall);
window.addEventListener('pagehide', () => { resetBall(); conn.disconnect(); });
if (!availability.ok) {
  support.hidden = false;
  support.textContent = `${availability.reason} 데모 스윙은 사용할 수 있습니다.`;
  connect.disabled = true;
}
