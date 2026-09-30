// BLE 연결 · 패킷 파싱 (Nordic UART Service)

// [한눈에 보기] 이 파일이 하는 일
//   1) 브라우저의 Web Bluetooth API로 보드(AirBand-R)를 찾아 연결한다.
//   2) 보드의 TX 특성(characteristic)에 notify를 구독한다 → 보드가 보낼 때마다 이벤트가 온다.
//   3) 받은 바이트를 8바이트씩 잘라 HitEvent 객체로 바꿔 onHit 콜백으로 넘긴다.
//   소리·화면은 이 파일이 모른다. main.ts가 onHit을 받아 처리한다.
//
// [설명] UUID는 BLE 서비스/특성의 고유 이름표다. 아래 세 개는 Nordic UART Service 표준값이라
//   펌웨어의 BLEUart와 자동으로 맞는다. TX/RX는 "보드 입장"에서 붙인 이름이다.
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 보드 → 브라우저 (notify)
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 브라우저 → 보드 (write, 현재 미사용)
export const DEVICE_NAME = 'AirBand-R';

export const PACKET_SIZE = 8;

/** 타격 이벤트 (패킷 8바이트 + 수신 시각) */
export interface HitEvent {
  hand: number; // 0 = 오른손, 1 = 왼손
  mode: number; // 0 = 드럼
  cls: number; // 0 = 스네어
  velocity: number; // 0~127
  boardMs: number; // 보드 millis (uint32)
  receivedAt: number; // 브라우저 수신 시각 (performance.now)
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
        ? 'iOS Safari/Chrome은 Web Bluetooth를 지원하지 않습니다. Android Chrome 또는 PC의 Chrome/Edge를 사용하세요. (iOS는 Bluefy 같은 앱 브라우저로 시도 가능)'
        : '이 브라우저는 Web Bluetooth를 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.',
    };
  }
  return { ok: true };
}

export class AirBandConnection {
  onHit: (e: HitEvent) => void = () => {};
  onState: (s: ConnState, detail?: string) => void = () => {};
  onBattery: (b: BatteryInfo) => void = () => {};

  private device: BluetoothDevice | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;

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
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);

      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      this.tx = await service.getCharacteristic(NUS_TX);
      this.tx.addEventListener('characteristicvaluechanged', this.handleNotify);
      await this.tx.startNotifications();

      this.onState('connected', device.name ?? DEVICE_NAME);
      void this.readBattery(server);
    } catch (err) {
      this.cleanup();
      this.onState('disconnected', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
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
  };

  private handleDisconnect = (): void => {
    this.cleanup();
    this.onState('disconnected', '연결이 끊어졌습니다');
  };

  private cleanup(): void {
    this.tx?.removeEventListener('characteristicvaluechanged', this.handleNotify);
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.tx = null;
    this.device = null;
  }
}
