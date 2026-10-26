// BLE 연결 · 패킷 파싱 (Nordic UART Service)

// [한눈에 보기] 이 파일이 하는 일
//   1) 브라우저의 Web Bluetooth API로 보드(AirBand-R)를 찾아 연결한다.
//   2) 보드의 TX 특성(characteristic)에 notify를 구독한다 → 보드가 보낼 때마다 이벤트가 온다.
//   3) 받은 바이트를 8바이트씩 잘라 HitEvent(타격) / MotionEvent(스틱 방향)로 바꿔 콜백으로 넘긴다.
//   4) send()로 보드에 한 글자 명령을 보낸다 (RX 특성). c 정면 맞추기 · m 모션 켜기 · x 끄기
//   소리·화면은 이 파일이 모른다. main.ts가 onHit을 받아 처리한다.
//
// [설명] UUID는 BLE 서비스/특성의 고유 이름표다. 아래 세 개는 Nordic UART Service 표준값이라
//   펌웨어의 BLEUart와 자동으로 맞는다. TX/RX는 "보드 입장"에서 붙인 이름이다.
import { PhoneStick } from './phone';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 보드 → 브라우저 (notify)
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 브라우저 → 보드 (write, 한 글자 명령)
export const DEVICE_NAME = 'AirBand-R';

export const PACKET_SIZE = 8;
/** 0번 바이트가 이 값이면 모션 패킷 (타격 패킷의 0번 바이트 hand는 0/1) — 펌웨어 PKT_MOTION과 같음 */
export const PKT_MOTION = 0x80;
/** 축 맞추기 결과 패킷 — 펌웨어 PKT_AXIS. [1] 1=성공 [2..7] 축 x,y,z ×10000 (int16) */
export const PKT_AXIS = 0x81;

/** 보드에 보내는 한 글자 명령 (펌웨어 handleCommand와 같음) */
export const CMD = { recenter: 'c', axis: 'a', motionOn: 'm', motionOff: 'x', conduct: 'k', drum: 'd' } as const;

/** 축 맞추기 결과 */
export interface AxisResult {
  ok: boolean;
  axis: [number, number, number];
}

/** 타격 이벤트 (패킷 8바이트 + 수신 시각) */
export interface HitEvent {
  hand: number; // 0 = 오른손, 1 = 왼손
  mode: number; // 0 = 드럼
  cls: number; // 0 스네어 · 1 킥 · 2 하이햇 · 3 탐 · 4 크래시
  velocity: number; // 0~127
  boardMs: number; // 보드 millis (uint32)
  receivedAt: number; // 브라우저 수신 시각 (performance.now)
}

/** 스틱 방향 (모션 스트림, 25Hz). 각도는 "정면 맞추기" 한 방향 기준 */
export interface MotionEvent {
  zone: number; // 지금 치면 나올 드럼 클래스
  headingDeg: number; // + = 왼쪽, - = 오른쪽
  elevationDeg: number; // + = 위
  accelG: number; // 가속도 크기 (가만히 있으면 약 1g)
  receivedAt: number;
}

export type ConnState = 'disconnected' | 'connecting' | 'connected';

/** 배터리: 숫자(%) 또는 'none'(배터리 서비스 없음 — USB 전원) */
export type BatteryInfo = number | 'none';

/**
 * notify 값을 이벤트 배열로 변환. 한 번에 여러 패킷이 붙어서 올 수도 있으므로 8바이트 단위로 자른다.
 * 8의 배수가 아닌 나머지 바이트는 버린다.
 */
// [설명] DataView = 바이트 배열에서 "몇 번째 바이트부터 몇 바이트를 어떤 형식으로" 읽게 해 주는 도구.
//   getUint8(n)          : n번째 1바이트를 0~255 정수로
//   getUint32(n, true)   : n번째부터 4바이트를 little-endian 정수로 (펌웨어 buildPacket()과 같은 순서)
export function parsePackets(dv: DataView, receivedAt: number): HitEvent[] {
  const out: HitEvent[] = [];
  for (let off = 0; off + PACKET_SIZE <= dv.byteLength; off += PACKET_SIZE) {
    if (dv.getUint8(off) >= PKT_MOTION) continue; // 0x80 이상은 타격이 아님 (모션 · 축 결과)
    out.push({
      hand: dv.getUint8(off + 0),
      mode: dv.getUint8(off + 1),
      cls: dv.getUint8(off + 2),
      velocity: Math.min(127, dv.getUint8(off + 3)),
      boardMs: dv.getUint32(off + 4, true), // little-endian
      receivedAt,
    });
  }
  return out;
}

/** notify 값에서 모션 패킷만 골라낸다. [1] zone, [2..3] heading×10, [4..5] elevation×10 (int16), [6..7] mg (uint16) */
export function parseMotions(dv: DataView, receivedAt: number): MotionEvent[] {
  const out: MotionEvent[] = [];
  for (let off = 0; off + PACKET_SIZE <= dv.byteLength; off += PACKET_SIZE) {
    if (dv.getUint8(off) !== PKT_MOTION) continue;
    out.push({
      zone: dv.getUint8(off + 1),
      headingDeg: dv.getInt16(off + 2, true) / 10,
      elevationDeg: dv.getInt16(off + 4, true) / 10,
      accelG: dv.getUint16(off + 6, true) / 1000,
      receivedAt,
    });
  }
  return out;
}

/** Web Bluetooth 사용 가능 여부 */
// [설명] Web Bluetooth는 보안상 HTTPS 또는 localhost 페이지에서만 쓸 수 있다(isSecureContext).
//   또 Chrome/Edge 계열만 지원하고 iOS·Firefox는 navigator.bluetooth 자체가 없다.
export function webBluetoothSupport(): { ok: boolean; reason?: string } {
  if (!window.isSecureContext) {
    return { ok: false, reason: 'Web Bluetooth는 HTTPS 또는 localhost에서만 동작합니다. 주소를 확인하세요.' };
  }
  const ua = navigator.userAgent;
  if (!('bluetooth' in navigator)) {
    const ios = /iPad|iPhone|iPod/.test(ua);
    return {
      ok: false,
      reason: ios
        ? 'iOS Safari/Chrome은 Web Bluetooth를 지원하지 않아 보드는 연결할 수 없습니다. 📱 폰으로 치기는 됩니다. (보드는 Android Chrome · PC Chrome/Edge 또는 Bluefy 앱 브라우저)'
        : '이 브라우저는 Web Bluetooth를 지원하지 않습니다. Chrome 또는 Edge를 사용하세요. (폰이면 📱 폰으로 치기는 됩니다)',
    };
  }
  return { ok: true };
}

export class AirBandConnection {
  onHit: (e: HitEvent) => void = () => {};
  onMotion: (m: MotionEvent) => void = () => {};
  onAxis: (r: AxisResult) => void = () => {};
  onState: (s: ConnState, detail?: string) => void = () => {};
  onBattery: (b: BatteryInfo) => void = () => {};

  private device: BluetoothDevice | null = null;
  /** 사용자가 끊은 게 아니면 true → 연결이 끊기면 자동으로 다시 붙는다 */
  private wantConnected = false;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  /** 폰 단독 모드일 때만 있음 (보드 대신 폰 센서) */
  private phone: PhoneStick | null = null;
  /** GATT 쓰기는 한 번에 하나만 가능해서 줄 세워 보낸다 */
  private writeChain: Promise<void> = Promise.resolve();

  // [설명] 연결 절차 (await = 그 단계가 끝날 때까지 기다림)
  //   requestDevice()      : 브라우저가 기기 선택 창을 띄운다. 반드시 사용자 클릭 안에서 불러야 한다(보안 규칙).
  //                          filters에 맞는 기기(이름 AirBand-R 또는 NUS 서비스)만 목록에 나온다.
  //   gatt.connect()       : 실제 무선 연결
  //   getPrimaryService()  : 보드 안의 NUS 서비스 찾기
  //   getCharacteristic()  : 그 안의 TX 특성 찾기
  //   startNotifications() : "값 생기면 알려줘" 구독 → 보드의 bleuart.notifyEnabled()가 true가 된다
  async connect(): Promise<void> {
    this.onState('connecting');
    try {
      const device = await navigator.bluetooth.requestDevice({
        // 이름은 스캔 응답에 들어 있음. 이름 또는 NUS 서비스 UUID 중 하나로 찾는다.
        filters: [{ name: DEVICE_NAME }, { services: [NUS_SERVICE] }],
        optionalServices: [NUS_SERVICE, 'battery_service'],
      });
      this.device = device;
      this.wantConnected = true;
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      // 첫 연결이 "GATT 실패"로 가끔 튕긴다(특히 Windows) → 몇 번 다시 시도
      await this.withRetry(() => this.attach(device), 3);
    } catch (err) {
      this.wantConnected = false;
      this.cleanup();
      this.onState('disconnected', friendlyError(err));
      throw err;
    }
  }

  /** 이미 고른 기기에 GATT 연결 → NUS 특성 찾기 → notify 구독 */
  private async attach(device: BluetoothDevice): Promise<void> {
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.tx = await service.getCharacteristic(NUS_TX);
    this.rx = await service.getCharacteristic(NUS_RX);
    this.tx.addEventListener('characteristicvaluechanged', this.handleNotify);
    await this.tx.startNotifications();
    this.onState('connected', device.name ?? DEVICE_NAME);
    void this.readBattery(server);
  }

  private async withRetry(fn: () => Promise<void>, tries: number): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= tries || !this.wantConnected) throw err;
        this.device?.gatt?.disconnect();
        this.onState('connecting', `다시 시도 ${i}/${tries - 1}`);
        await new Promise((res) => setTimeout(res, 400 * i));
      }
    }
  }

  /** 폰 단독 모드인지 */
  get isPhone(): boolean {
    return this.phone !== null;
  }

  /**
   * 폰 단독 모드: 보드 대신 이 폰의 센서로 타격 · 방향을 만든다. 이벤트는 보드와 똑같이 onHit · onMotion으로 온다.
   * iOS 권한 요청 때문에 반드시 버튼 클릭 핸들러 안에서, 다른 await보다 먼저 부를 것.
   */
  async connectPhone(): Promise<void> {
    if (this.phone) return;
    if (this.device) this.disconnect();
    const p = new PhoneStick();
    p.onHit = (e) => this.onHit(e);
    p.onMotion = (m) => this.onMotion(m);
    p.onAxis = (r) => this.onAxis(r);
    p.onFail = (reason) => {
      if (this.phone !== p) return;
      this.stopPhone();
      this.onState('disconnected', reason);
    };
    this.phone = p;
    this.onState('connecting');
    try {
      await p.start();
    } catch (err) {
      this.stopPhone();
      this.onState('disconnected', err instanceof Error ? err.message : String(err));
      throw err;
    }
    if (this.phone === p) this.onState('connected', '📱 폰 센서');
  }

  private stopPhone(): void {
    this.phone?.stop();
    this.phone = null;
  }

  disconnect(): void {
    if (this.phone) {
      this.stopPhone();
      this.onState('disconnected');
      return;
    }
    this.wantConnected = false;
    this.device?.gatt?.disconnect();
  }

  /** 보드에 한 글자 명령 보내기 (CMD 참고). 연결 전이면 아무것도 하지 않는다 */
  send(cmd: string): Promise<void> {
    if (this.phone) {
      this.phone.command(cmd);
      return Promise.resolve();
    }
    const rx = this.rx;
    if (!rx) return Promise.resolve();
    const data = new TextEncoder().encode(cmd);
    this.writeChain = this.writeChain
      .then(() => rx.writeValueWithoutResponse(data))
      .catch((err) => console.warn('명령 전송 실패', cmd, err));
    return this.writeChain;
  }

  private async readBattery(server: BluetoothRemoteGATTServer): Promise<void> {
    try {
      const svc = await server.getPrimaryService('battery_service');
      const ch = await svc.getCharacteristic('battery_level');
      const v = await ch.readValue();
      this.onBattery(v.getUint8(0));
    } catch {
      // 1단계 펌웨어는 배터리 서비스가 없음 (USB 전원)
      this.onBattery('none');
    }
  }

  // 수신 경로: 시각 기록 → 파싱 → 콜백. 여기서 await 등 지연 요소를 넣지 않는다.
  // [설명] 보드가 notify를 보낼 때마다 브라우저가 이 함수를 부른다.
  //   performance.now()는 페이지가 열린 뒤 경과 시간(ms, 소수점까지)으로, 지연 측정용이다.
  //   화살표 함수(= () =>)로 만든 이유: addEventListener/removeEventListener에 같은 함수를 넘기면서
  //   this가 이 객체를 가리키게 하려고.
  private handleNotify = (ev: Event): void => {
    const receivedAt = performance.now();
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    if (!ch.value) return;
    for (const hit of parsePackets(ch.value, receivedAt)) this.onHit(hit);
    for (const m of parseMotions(ch.value, receivedAt)) this.onMotion(m);
    const dv = ch.value;
    for (let off = 0; off + PACKET_SIZE <= dv.byteLength; off += PACKET_SIZE) {
      if (dv.getUint8(off) !== PKT_AXIS) continue;
      const v = (k: number) => dv.getInt16(off + 2 + k * 2, true) / 10000;
      this.onAxis({ ok: dv.getUint8(off + 1) === 1, axis: [v(0), v(1), v(2)] });
    }
  };

  // 끊김: 사용자가 끊은 게 아니면 같은 기기에 다시 붙는다 (선택 창 없이). 0.5초 · 1초 · 2초 · 3초 · 5초 간격으로 5번
  private handleDisconnect = async (): Promise<void> => {
    const device = this.device;
    this.tx?.removeEventListener('characteristicvaluechanged', this.handleNotify);
    this.tx = null;
    this.rx = null;
    if (!this.wantConnected || !device) {
      this.cleanup();
      this.onState('disconnected', this.wantConnected ? '연결이 끊어졌습니다' : undefined);
      return;
    }
    const waits = [500, 1000, 2000, 3000, 5000];
    for (let i = 0; i < waits.length && this.wantConnected; i++) {
      this.onState('connecting', `연결이 끊겨 다시 붙는 중 ${i + 1}/${waits.length}`);
      await new Promise((res) => setTimeout(res, waits[i]));
      if (!this.wantConnected) break;
      try {
        await this.attach(device);
        return;
      } catch {
        // 다음 시도
      }
    }
    this.wantConnected = false;
    this.cleanup();
    this.onState('disconnected', '연결이 끊어졌습니다 — 보드 전원 · 거리를 확인하고 다시 연결하세요');
  };

  private cleanup(): void {
    this.tx?.removeEventListener('characteristicvaluechanged', this.handleNotify);
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.tx = null;
    this.rx = null;
    this.device = null;
  }
}

/** 브라우저 오류 문구를 이해하기 쉽게 */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/cancel/i.test(msg)) return '기기 선택을 취소했습니다';
  if (/GATT|connect/i.test(msg)) return `연결 실패 — 보드를 껐다 켜고 다시 눌러 보세요 (${msg})`;
  return msg;
}
