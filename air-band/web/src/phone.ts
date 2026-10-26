// 폰 단독 모드: 폰을 스틱처럼 쥐고 휘두르면 폰 자체의 센서로 타격 · 방향을 만든다 (보드 · BLE 없음)
//
// [한눈에 보기]
//   deviceorientation (방향: alpha · beta · gamma) ─▶ 스틱 끝 방향 → 좌우 · 위아래 각도 → 구역(드럼)
//   devicemotion (가속도, 약 60Hz)                   ─▶ |가속도| 피크 = 타격 (펌웨어 detectHit과 같은 규칙)
//   결과는 보드와 똑같은 HitEvent · MotionEvent로 내보낸다 → 자유 연주 · 드럼 키트 · 리듬 게임이 그대로 쓴다.
//
// [설명] 스틱 축: 기본은 폰 윗변(+Y)이 스틱 끝. "축 맞추기"(a)를 하면 그 순간 위를 향한 축으로 바꾼다.
//   폰을 세로로 쥐고 윗변이 앞을 향하게 들면 된다.
//
// [한계] 브라우저가 주는 센서는 약 60Hz라 보드(100Hz)보다 거칠다. 폰이 무거워 빠른 연타가 어렵다.
//   iOS는 버튼을 눌러 권한을 허락해야 하고, PC에는 센서가 없다.
import { ZONE_DEG } from './motion';
import type { AxisResult, HitEvent, MotionEvent } from './ble';
import { IctusDetector } from './conduct/ictus';

/** 펌웨어 · kit/scene.ts zoneOfAim과 같은 구역 경계 (도) */
const ZONE = ZONE_DEG; // 드럼 간격 설정(motion.ts)을 그대로 따른다
/** 폰은 보드보다 가볍게 휘두르므로 임계값을 조금 낮춘다 (보드 2.5g). 오작동하면 ↑ */
const HIT_G = 2.2;
const VEL_MAX_G = 6;
/** 폰은 휘두르기 시작할 때도 가속이 크게 튀므로 보드(60ms)보다 길게 */
const REFRACTORY_MS = 150;
const MOTION_HZ = 25;
/** 이 시간 안에 센서 값이 하나도 안 오면 센서가 없는 기기로 본다 */
const NO_SENSOR_MS = 1500;
const STORE_AXIS = 'airband.phone.axis';
const G = 9.80665;

const RAD = Math.PI / 180;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

type Vec3 = [number, number, number];

/** iOS 13+ 전용: 사용자 클릭 안에서 권한 요청 */
type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> };

export function phoneSensorSupported(): boolean {
  return 'DeviceMotionEvent' in window && 'DeviceOrientationEvent' in window && window.isSecureContext;
}

export class PhoneStick {
  onHit: (e: HitEvent) => void = () => {};
  onMotion: (m: MotionEvent) => void = () => {};
  onAxis: (r: AxisResult) => void = () => {};
  /** 센서가 없거나 권한이 거부됐을 때 */
  onFail: (reason: string) => void = () => {};

  private axis: Vec3 = loadAxis();
  private R: number[] | null = null; // 기기 → 세계 회전 (3×3, 행 우선)
  private headingAbs = 0;
  private elevAbs = 0;
  private headingRef = 0;
  private elevRef = 0;
  private centered = false;
  /** 'k'(지휘)면 타격 대신 박을 보낸다 — 펌웨어 g_mode와 같음 */
  private conducting = false;
  private ictus = new IctusDetector();

  // 피크 감지 (펌웨어와 같은 3점 비교: 직전 값이 임계값 이상이고 앞뒤보다 크면 피크)
  private m1 = 0;
  private m2 = 0;
  private m1At = 0;
  private m1Zone = 0;
  private lastHitAt = -Infinity;

  private blockMaxG = 0;
  private lastMotionAt = 0;
  private gotData = false;
  private failTimer = 0;
  private wakeLock: { release(): Promise<void> } | null = null;

  /** 반드시 버튼 클릭 핸들러 안에서 (await 전에) 부를 것 — iOS 권한 요청 규칙 */
  async start(): Promise<void> {
    const dm = DeviceMotionEvent as unknown as PermissionApi;
    const dor = DeviceOrientationEvent as unknown as PermissionApi;
    // 거부돼도 바로 실패로 끝내지 않는다: 브라우저마다 응답이 달라서(데스크톱 Chrome은 센서가 없으면 denied),
    // 실제로 값이 오는지(아래 NO_SENSOR_MS)로 판단한다
    let denied = false;
    if (dm.requestPermission) {
      try {
        const [a, b] = await Promise.all([dm.requestPermission(), dor.requestPermission?.() ?? 'granted']);
        denied = a !== 'granted' || b !== 'granted';
      } catch {
        denied = true;
      }
    }
    window.addEventListener('deviceorientation', this.handleOrientation);
    window.addEventListener('devicemotion', this.handleMotion);
    this.failTimer = window.setTimeout(() => {
      if (this.gotData) return;
      this.onFail(
        denied
          ? '동작 센서 권한이 없습니다. iPhone은 설정 → Safari → 동작 및 방향 접근을 켜고 다시 누르세요'
          : '이 기기에서는 동작 센서 값이 오지 않습니다. 폰에서 열어 주세요',
      );
    }, NO_SENSOR_MS);
    // 휘두르는 동안 화면이 꺼지지 않게 (지원하는 브라우저만)
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      this.wakeLock = (await wl?.request('screen')) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }

  stop(): void {
    window.removeEventListener('deviceorientation', this.handleOrientation);
    window.removeEventListener('devicemotion', this.handleMotion);
    clearTimeout(this.failTimer);
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  /** 보드와 같은 한 글자 명령: c 정면 맞추기 · a 축 맞추기 · k 지휘 모드 · d 드럼 모드 (m/x는 폰에선 항상 켜짐) */
  command(cmd: string): void {
    if (cmd === 'c') this.recenter();
    else if (cmd === 'a') this.calibrateAxis();
    else if (cmd === 'k') {
      this.conducting = true;
      this.ictus.reset();
    } else if (cmd === 'd') this.conducting = false;
  }

  private recenter(): void {
    this.headingRef = this.headingAbs;
    this.elevRef = this.elevAbs;
    this.centered = true;
  }

  // 지금 위를 향한 기기 축 = 세계 위쪽(0,0,1)을 기기 좌표로 돌린 것 = R의 3번째 행
  private calibrateAxis(): void {
    const R = this.R;
    if (!R) {
      this.onAxis({ ok: false, axis: this.axis });
      return;
    }
    const up: Vec3 = [R[6], R[7], R[8]];
    const n = Math.hypot(...up);
    const ok = n > 0.9;
    if (ok) {
      this.axis = up.map((v) => v / n) as Vec3;
      try {
        localStorage.setItem(STORE_AXIS, JSON.stringify(this.axis));
      } catch {
        // 저장 불가 — 이번 방문 동안만
      }
    }
    this.onAxis({ ok, axis: this.axis });
  }

  // [설명] W3C 규격: 기기 → 세계 회전 R = Rz(alpha) · Rx(beta) · Ry(gamma). 세계는 x 동, y 북, z 위.
  //   alpha가 늘면 위에서 볼 때 반시계(왼쪽으로 돎) → 좌우 각도 + = 왼쪽 (보드와 같은 부호)
  private handleOrientation = (ev: DeviceOrientationEvent): void => {
    if (ev.beta === null || ev.gamma === null) return;
    this.gotData = true;
    const a = (ev.alpha ?? 0) * RAD;
    const b = ev.beta * RAD;
    const g = ev.gamma * RAD;
    const [ca, sa, cb, sb, cg, sg] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(g), Math.sin(g)];
    const R = [
      ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg,
      sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg,
      -cb * sg, sb, cb * cg,
    ];
    this.R = R;
    const [x, y, z] = this.axis;
    const dx = R[0] * x + R[1] * y + R[2] * z;
    const dy = R[3] * x + R[4] * y + R[5] * z;
    const dz = Math.max(-1, Math.min(1, R[6] * x + R[7] * y + R[8] * z));
    this.elevAbs = Math.asin(dz) / RAD;
    // 거의 수직이면 좌우가 정의되지 않으므로 이전 값 유지 (펌웨어와 같음)
    if (Math.abs(dz) < 0.97) this.headingAbs = Math.atan2(dy, dx) / RAD;
    // 처음 값이 들어오면 지금 방향을 정면으로 (버튼을 누를 때 대개 앞을 겨누고 있으므로)
    if (!this.centered) this.recenter();
  };

  private heading(): number {
    return wrap180(this.headingAbs - this.headingRef);
  }
  private elevation(): number {
    return this.elevAbs - this.elevRef;
  }
  private zone(): number {
    const h = this.heading();
    const e = this.elevation();
    if (e >= ZONE.up) return 4;
    if (h >= ZONE.left) return 2;
    if (h <= -ZONE.right) return 3;
    return 0;
  }

  private handleMotion = (ev: DeviceMotionEvent): void => {
    const acc = ev.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;
    this.gotData = true;
    const now = ev.timeStamp;
    const m0 = Math.hypot(acc.x, acc.y, acc.z) / G;

    if (this.conducting) {
      // 움직임 가속도(중력 뺀 값): 브라우저가 주면 그대로, 없으면 |가속도| - 1g로 대신
      const la = ev.acceleration;
      const lin = la && la.x !== null && la.y !== null && la.z !== null ? Math.hypot(la.x, la.y, la.z) / G : Math.abs(m0 - 1);
      const b = this.ictus.update(now, this.elevation(), this.heading(), lin);
      if (b) {
        this.onHit({
          hand: 0,
          mode: 1, // 지휘: class 0 = 박, velocity = 박 크기(도 × 2), 시각 = 박 순간
          cls: 0,
          velocity: Math.max(1, Math.min(127, Math.round(b.size * 2))),
          boardMs: b.ms,
          receivedAt: performance.now(),
        });
      }
    }

    const isPeak = this.m1 >= HIT_G && this.m1 > this.m2 && this.m1 >= m0;
    if (isPeak && !this.conducting && this.m1At - this.lastHitAt >= REFRACTORY_MS) {
      this.lastHitAt = this.m1At;
      const t = Math.min(1, (this.m1 - HIT_G) / (VEL_MAX_G - HIT_G));
      this.onHit({
        hand: 0,
        mode: 0,
        cls: this.m1Zone,
        velocity: 1 + Math.round(t * 126),
        boardMs: this.m1At, // 폰은 센서 시각이 곧 페이지 시각 (performance.now 기준)
        receivedAt: performance.now(),
      });
    }
    this.m2 = this.m1;
    this.m1 = m0;
    this.m1At = now;
    this.m1Zone = this.zone();

    if (m0 > this.blockMaxG) this.blockMaxG = m0;
    if (now - this.lastMotionAt >= 1000 / MOTION_HZ) {
      this.lastMotionAt = now;
      this.onMotion({
        zone: this.m1Zone,
        headingDeg: this.heading(),
        elevationDeg: this.elevation(),
        accelG: this.blockMaxG,
        receivedAt: performance.now(),
      });
      this.blockMaxG = 0;
    }
  };
}

function loadAxis(): Vec3 {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_AXIS) ?? 'null') as Vec3 | null;
    if (Array.isArray(v) && v.length === 3 && Math.abs(Math.hypot(...v) - 1) < 0.05) return v;
  } catch {
    // 저장 불가 · 손상 — 기본값
  }
  return [0, 1, 0];
}
