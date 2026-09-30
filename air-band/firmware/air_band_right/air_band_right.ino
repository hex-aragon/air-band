/*
 * 에어 밴드 1단계 데모 — 오른손 드럼 센서 펌웨어
 *
 * 보드 : NUCODE NU40 DK (nRF52840)
 * 코어 : NUBoards nRF52 by NUCODE (FQBN nucode:nrf52:nu40dk)
 *
 * 흐름: IMU 100Hz 샘플링 → 링버퍼(0.2초) → 피크 감지 → 분류 훅 → BLE notify(NUS)
 *       보드 버튼 1~4 → 드럼 클래스 0~3 → BLE notify (IMU 없이도 동작하는 PoC 모드)
 *
 * 설정 요약 (자세한 건 air-band/README.md 참고)
 *   - DEBUG_RAW  1 : Edge Impulse Data Forwarder용 CSV(ax,ay,az) 출력
 *   - DEBUG_HITS 1 : 타격 로그를 시리얼에 출력
 *   - 튜닝 상수   : HIT_THRESHOLD_G, REFRACTORY_MS, VEL_MIN_G, VEL_MAX_G
 */

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * [한눈에 보기] 이 파일이 하는 일
 * ─────────────────────────────────────────────────────────────────────────────
 * 아두이노 프로그램은 두 함수로 돌아간다.
 *   setup() : 전원이 켜지면 딱 한 번 실행 (I2C·IMU·버튼·BLE 준비)
 *   loop()  : setup()이 끝나면 영원히 반복 실행 (버튼 읽기, 센서 읽기, 타격 판정)
 *
 * 이 보드(nRF52840)의 코어는 FreeRTOS라는 작은 운영체제 위에서 돈다.
 * 그래서 loop() 말고도 "태스크"라는 반복 함수를 하나 더 동시에 돌릴 수 있다.
 * 이 파일에서는 BLE 전송을 별도 태스크(bleSendLoop)로 떼어 놓았다.
 *
 *   [loop 태스크]                              [BLE 전송 태스크]
 *   버튼 읽기(pollButtons) ─┐
 *                           ├→ emitHit() → 큐(우체통) → bleSendLoop() → 무선으로 브라우저에 전송
 *   IMU 읽기 → detectHit() ─┘
 *
 * 브라우저로 보내는 것은 "소리"가 아니라 8바이트짜리 "타격 정보"다.
 * (어떤 드럼 / 얼마나 세게 / 언제). 소리는 브라우저(web/src/audio.ts)가 낸다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// [설명] 라이브러리
//   bluefruit.h : Adafruit의 nRF52용 BLE 라이브러리. 광고·연결·UART 서비스를 쉽게 쓰게 해 준다.
//   Wire.h      : 아두이노 표준 I2C 라이브러리. IMU 센서와 통신할 때 쓴다.
//   두 라이브러리 모두 보드 패키지(BSP)에 들어 있어서 따로 설치할 필요가 없다.
#include <bluefruit.h>
#include <Wire.h>

// ============================================================================
// 디버그 플래그
// ============================================================================
#define DEBUG_RAW   0   // 1이면 CSV(ax,ay,az)만 출력 (2단계 데이터 수집용)
#define DEBUG_HITS  1   // 1이면 타격 로그 출력 (DEBUG_RAW=1이면 CSV가 섞이지 않도록 자동으로 꺼짐)

// [설명] #define / #if 는 "컴파일 전에" 처리된다.
//   값이 0이면 해당 코드가 아예 빌드에서 빠지므로, 실행 중 if 문 비용이 없다.
//   예) DEBUG_RAW를 1로 바꾸고 다시 업로드하면 센서 원본 데이터만 출력하는 펌웨어가 된다.
#if DEBUG_RAW
  #define HIT_LOG_ENABLED 0
#else
  #define HIT_LOG_ENABLED DEBUG_HITS
#endif

// ============================================================================
// 핀 / I2C 설정
// ============================================================================
// NU40DK BSP(variant.h)의 기본 Wire 핀: SDA = P0.26, SCL = P0.27
// (이 BSP는 아두이노 핀 번호 = nRF GPIO 번호. P0.xx → xx, P1.xx → 32+xx)
// TODO: 확인 필요 — 보드 헤더/실크에서 P0.26, P0.27 위치를 확인할 것.
//                   다른 핀에 연결했다면 아래 두 값만 바꾸면 된다.
// [설명] I2C는 선 2개(SDA=데이터, SCL=클럭)로 여러 장치와 통신하는 방식이다.
//   각 장치는 7비트 "주소"(예: 0x68)를 가지고, 보드가 주소를 불러서 대화한다.
//   장치 안에는 "레지스터"(번호가 붙은 1바이트 칸)가 있고, 설정은 레지스터에 쓰고
//   측정값은 레지스터에서 읽는다. 400kHz는 I2C의 "Fast mode" 속도다.
static const uint8_t  PIN_IMU_SDA  = PIN_WIRE_SDA;
static const uint8_t  PIN_IMU_SCL  = PIN_WIRE_SCL;
static const uint32_t I2C_CLOCK_HZ = 400000;

// 상태 표시 LED (BSP 정의: LED1 = P0.13)
static const uint8_t  PIN_STATUS_LED = LED_BUILTIN;

// ============================================================================
// IMU 설정
// ============================================================================
// 사용할 IMU 모델이 정해지지 않았으므로, 흔한 6축 IMU 두 계열을 WHO_AM_I로 자동 감지한다.
//   - MPU-6050 / MPU-6500 계열 (I2C 0x68 / 0x69)
//   - ST LSM6DS3 / LSM6DSL / LSM6DSO 계열 (I2C 0x6A / 0x6B)
// TODO: 확인 필요 — 실제 사용할 IMU 모델과 I2C 주소(AD0/SA0 핀 상태).
//                   위 두 계열이 아니면 imuBegin()/imuReadAccel()에 드라이버를 추가할 것.
//                   부팅 시 시리얼에 I2C 스캔 결과가 출력되니 그 주소를 참고.

// ============================================================================
// 버튼 패드 (IMU 없이 드럼 PoC)
// ============================================================================
// NU40DK 보드의 버튼 4개. 누르면 LOW (내부 풀업 사용).
// 버튼 N → 드럼 클래스 N-1 (0 스네어, 1 킥, 2 하이햇, 3 탐). 웹 audio.ts의 DRUM_CLASSES와 맞출 것.
// 버튼은 세기를 알 수 없으므로 velocity는 고정값을 보낸다.
// [설명] 풀업(pull-up)과 active-low
//   버튼 한쪽은 GPIO 핀, 다른 쪽은 GND(0V)에 연결되어 있다.
//   INPUT_PULLUP으로 설정하면 칩 내부 저항이 핀을 3.3V 쪽으로 약하게 당겨 둔다.
//     안 누름 → 핀 = HIGH(1)
//     누름    → 핀이 GND와 직접 연결되어 LOW(0)
//   즉 "누르면 0"이다 (active-low). 2026-09-30에 진단 펌웨어로 네 버튼 모두 이렇게 동작함을 확인했다.
//
// [설명] 디바운스(debounce)
//   기계식 버튼은 누르는 순간 접점이 몇 ms 동안 붙었다 떨어졌다를 반복한다(채터링).
//   그대로 읽으면 한 번 눌렀는데 여러 번 눌린 것처럼 보이므로,
//   상태가 바뀐 뒤 25ms 동안은 다음 변화를 무시한다.
#define ENABLE_BUTTONS 1
static const uint8_t  BUTTON_PINS[]      = { PIN_BUTTON1, PIN_BUTTON2, PIN_BUTTON3, PIN_BUTTON4 };
static const uint8_t  BUTTON_COUNT       = sizeof(BUTTON_PINS) / sizeof(BUTTON_PINS[0]);
static const uint8_t  BUTTON_VELOCITY    = 100;
static const uint32_t BUTTON_DEBOUNCE_MS = 25;
// 부팅 시 IMU 감지를 이 횟수만큼 시도하고, 못 찾으면 버튼 전용 모드로 계속 진행한다
static const uint8_t  IMU_BOOT_TRIES     = 3;

// ============================================================================
// 샘플링 / 링버퍼
// ============================================================================
// [설명] 샘플링 = 센서 값을 일정 간격으로 읽는 것.
//   100Hz = 1초에 100번 = 10ms마다 한 번. SAMPLE_PERIOD_US는 그 간격을 마이크로초(µs)로 쓴 것(10000).
//   링버퍼는 최근 20개(0.2초) 샘플만 기억하는 버퍼다. 2단계에서 AI 모델이 이 0.2초를 보고
//   "어떤 동작이었는지"를 판별한다.
static const uint32_t SAMPLE_RATE_HZ   = 100;
static const uint32_t SAMPLE_PERIOD_US = 1000000UL / SAMPLE_RATE_HZ;
static const uint16_t RING_SIZE        = SAMPLE_RATE_HZ / 5;   // 0.2초 = 20샘플

// ============================================================================
// 타격 감지 / 세기 튜닝 상수 (단위: g, 중력 1g 포함한 3축 벡터 크기)
// ============================================================================
// [설명] g = 중력가속도 단위. 가만히 있으면 센서는 약 1g(중력)를 읽는다.
//   세 축(x, y, z)의 가속도를 합친 크기 = √(x² + y² + z²). 방향과 상관없이 "얼마나 세게 흔들렸나"를 뜻한다.
//   스틱을 휘두르다 멈추면 순간적으로 수 g ~ 10g 이상이 나온다. 이 "튀는 점"(피크)을 타격으로 본다.
static const float    HIT_THRESHOLD_G = 2.5f;  // 이 값 이상인 피크만 타격. 오작동 많으면 ↑, 안 잡히면 ↓
static const uint32_t REFRACTORY_MS   = 60;    // 타격 후 이 시간 동안은 무시. 한 번에 두 번 잡히면 ↑
static const float    VEL_MIN_G       = HIT_THRESHOLD_G;  // 이 크기 → velocity 1
static const float    VEL_MAX_G       = 12.0f; // 이 크기 이상 → velocity 127. 세게 쳐도 작으면 ↓

// ============================================================================
// BLE / 패킷
// ============================================================================
// [설명] BLE(Bluetooth Low Energy) 용어
//   주변기기(Peripheral) : 이 보드. "나 여기 있어요"라고 광고(advertising)를 뿌린다.
//   중앙기기(Central)    : 브라우저가 돌아가는 PC/폰. 광고를 보고 연결을 건다.
//   서비스/특성(characteristic) : 연결 후 주고받는 데이터 칸. UUID(긴 고유 번호)로 구분한다.
//   notify : 주변기기가 값이 생길 때마다 중앙기기에게 "밀어서" 보내는 방식. 폴링보다 빠르다.
//   여기서는 Nordic UART Service(NUS)라는, 시리얼 통신처럼 바이트를 주고받는 흔한 서비스를 쓴다.
//
// [설명] 큐(queue) = 태스크끼리 데이터를 넘기는 우체통. 8칸짜리라 전송이 밀려도 8개까지는 쌓인다.
static const char*   BLE_DEVICE_NAME = "AirBand-R";
static const uint8_t HAND_RIGHT      = 0;
static const uint8_t MODE_DRUM       = 0;
static const uint8_t HIT_QUEUE_LEN   = 8;     // 전송 대기 큐 길이 (가득 차면 가장 새 이벤트를 버림)

// ============================================================================
// 자료형
// ============================================================================

// 가속도 한 샘플 (단위 g)
struct AccelSample {
  float x, y, z;
};

// 직전 0.2초 원형 버퍼. 2단계 분류 모델 입력으로 쓴다.
// [설명] 원형(링) 버퍼
//   배열 끝까지 쓰면 다시 처음으로 돌아가 가장 오래된 값을 덮어쓴다.
//   head는 "다음에 쓸 칸", count는 "지금까지 채운 개수"(최대 20).
//   예) 21번째 샘플은 0번 칸(1번째 샘플 자리)에 들어간다. 메모리를 새로 잡지 않아서 빠르고 안전하다.
struct SampleBuffer {
  AccelSample data[RING_SIZE];
  uint32_t    t_ms[RING_SIZE];
  uint16_t    head  = 0;   // 다음에 쓸 위치
  uint16_t    count = 0;   // 채워진 샘플 수 (최대 RING_SIZE)

  void push(const AccelSample& s, uint32_t ms) {
    data[head] = s;
    t_ms[head] = ms;
    head = (head + 1) % RING_SIZE;
    if (count < RING_SIZE) count++;
  }

  // i = 0 이 가장 오래된 샘플, i = count-1 이 가장 최근 샘플
  const AccelSample& at(uint16_t i) const {
    uint16_t start = (head + RING_SIZE - count) % RING_SIZE;
    return data[(start + i) % RING_SIZE];
  }
};

// BLE로 보내는 8바이트 타격 이벤트
// [설명] 패킷 구조 (브라우저의 web/src/ble.ts parsePackets()와 반드시 같아야 한다)
//   [0] hand     : 0 = 오른손
//   [1] mode     : 0 = 드럼
//   [2] class    : 0 스네어, 1 킥, 2 하이햇, 3 탐
//   [3] velocity : 1~127 (세기)
//   [4..7] 보드 시각 millis() — 4바이트 정수를 1바이트씩 쪼개서 넣는다(little-endian: 작은 자리부터)
struct HitPacket {
  uint8_t bytes[8];
};

// ============================================================================
// 전역 상태
// ============================================================================
enum ImuType { IMU_NONE, IMU_MPU6050, IMU_LSM6DS };

static ImuType      g_imuType  = IMU_NONE;
static uint8_t      g_imuAddr  = 0;
static float        g_lsbPerG  = 1.0f;

static SampleBuffer g_ring;
static uint32_t     g_nextSampleUs = 0;

// 피크 감지용: 현재(m0), 직전(m1), 그 전(m2) 샘플의 크기
static float        g_m1 = 0.0f, g_m2 = 0.0f;
static uint32_t     g_m1Ms = 0;
static uint32_t     g_lastHitMs = 0;
static bool         g_hasHit = false;

static uint32_t     g_ledOffMs = 0;

// 버튼 디바운스 상태
static bool         g_btnPressed[BUTTON_COUNT] = {};
static uint32_t     g_btnChangedMs[BUTTON_COUNT] = {};

static BLEUart       bleuart;
static QueueHandle_t g_hitQueue = nullptr;

// ============================================================================
// I2C 헬퍼
// ============================================================================
// [설명] I2C 레지스터 읽기/쓰기 순서
//   쓰기: [주소 호출] → [레지스터 번호] → [값] → 끝
//   읽기: [주소 호출] → [레지스터 번호] → (끊지 않고 재시작) → [n바이트 요청] → 받기
//   endTransmission()이 0이 아니면 장치가 응답하지 않은 것(배선·주소 문제).
static bool i2cWriteReg(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool i2cReadRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static bool i2cProbe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// 연결된 I2C 장치 주소 목록 출력 (IMU 주소 확인용)
static void i2cScan() {
  if (DEBUG_RAW) return;
  Serial.print(F("[I2C] scan:"));
  uint8_t found = 0;
  for (uint8_t a = 0x08; a < 0x78; a++) {
    if (i2cProbe(a)) {
      Serial.print(F(" 0x"));
      Serial.print(a, HEX);
      found++;
    }
  }
  if (!found) Serial.print(F(" (없음 — 배선/전원/풀업 확인)"));
  Serial.println();
}

// 감지 실패 시 후보 주소의 WHO_AM_I 레지스터 값을 출력 (모델 판별용)
static void printWhoAmI() {
  if (DEBUG_RAW) return;
  const uint8_t addrs[] = { 0x68, 0x69, 0x6A, 0x6B };
  for (uint8_t a : addrs) {
    if (!i2cProbe(a)) continue;
    uint8_t w0f = 0, w75 = 0, w00 = 0;
    bool ok0f = i2cReadRegs(a, 0x0F, &w0f, 1);   // ST 계열
    bool ok75 = i2cReadRegs(a, 0x75, &w75, 1);   // InvenSense 계열
    bool ok00 = i2cReadRegs(a, 0x00, &w00, 1);   // Bosch 계열
    Serial.print(F("[IMU] 0x")); Serial.print(a, HEX);
    Serial.print(F(" reg0x0F="));  if (ok0f) Serial.print(w0f, HEX); else Serial.print('-');
    Serial.print(F(" reg0x75="));  if (ok75) Serial.print(w75, HEX); else Serial.print('-');
    Serial.print(F(" reg0x00="));  if (ok00) Serial.println(w00, HEX); else Serial.println('-');
  }
}

// ============================================================================
// IMU 어댑터 — 모델별 코드는 여기에만 둔다
// ============================================================================

// MPU-6050/6500: WHO_AM_I(0x75) = 0x68(6050) / 0x70(6500) / 0x71(9250) 등
// [설명] WHO_AM_I 레지스터
//   대부분의 센서 칩은 "나는 누구다"라는 고정값을 가진 레지스터가 있다.
//   이 값을 읽어 보고 예상한 값이면 그 칩이라고 판단한다. 그래서 IMU 모델을 자동 감지할 수 있다.
//
// [설명] LSB/g
//   센서는 가속도를 정수(-32768~32767)로 준다. ±16g 범위면 1g = 2048이다.
//   그래서 "읽은 정수 ÷ 2048 = g 단위 값"이 된다.
static bool beginMpu6050(uint8_t addr) {
  uint8_t who;
  if (!i2cReadRegs(addr, 0x75, &who, 1)) return false;
  if (who != 0x68 && who != 0x70 && who != 0x71 && who != 0x73) return false;
  // PWR_MGMT_1: 슬립 해제, 클럭 = PLL(X gyro)
  if (!i2cWriteReg(addr, 0x6B, 0x01)) return false;
  delay(10);  // setup()에서 한 번만 사용 — 샘플링 루프와 무관
  // CONFIG(DLPF): 0x01 → 가속도 대역폭 약 184Hz (타격 피크를 뭉개지 않도록 넓게)
  i2cWriteReg(addr, 0x1A, 0x01);
  // ACCEL_CONFIG: ±16g (2048 LSB/g) — 스윙 타격은 수 g ~ 10g 이상 나온다
  i2cWriteReg(addr, 0x1C, 0x18);
  g_lsbPerG = 2048.0f;
  return true;
}

// LSM6DS3(0x69) / LSM6DS3TR-C, LSM6DSL(0x6A) / LSM6DSO, LSM6DSOX(0x6C)
static bool beginLsm6ds(uint8_t addr) {
  uint8_t who;
  if (!i2cReadRegs(addr, 0x0F, &who, 1)) return false;
  if (who != 0x69 && who != 0x6A && who != 0x6C) return false;
  // CTRL3_C: BDU=1(읽는 도중 값 갱신 방지), IF_INC=1(주소 자동 증가)
  i2cWriteReg(addr, 0x12, 0x44);
  // CTRL1_XL: ODR 416Hz, FS ±16g (0.488 mg/LSB)
  i2cWriteReg(addr, 0x10, 0x64);
  g_lsbPerG = 1000.0f / 0.488f;
  return true;
}

// IMU 자동 감지 후 초기화. 성공하면 true.
static bool imuBegin() {
  const uint8_t mpuAddrs[] = { 0x68, 0x69 };
  for (uint8_t a : mpuAddrs) {
    if (beginMpu6050(a)) { g_imuType = IMU_MPU6050; g_imuAddr = a; return true; }
  }
  const uint8_t lsmAddrs[] = { 0x6A, 0x6B };
  for (uint8_t a : lsmAddrs) {
    if (beginLsm6ds(a)) { g_imuType = IMU_LSM6DS; g_imuAddr = a; return true; }
  }
  // TODO: 확인 필요 — 다른 IMU(BMI160, ICM-42688 등)를 쓰면 여기에 begin 함수를 추가
  return false;
}

// 가속도 3축을 g 단위로 읽는다.
static bool imuReadAccel(AccelSample& out) {
  uint8_t b[6];
  int16_t x, y, z;
  switch (g_imuType) {
    case IMU_MPU6050:
      // ACCEL_XOUT_H(0x3B)부터 6바이트, big-endian
      if (!i2cReadRegs(g_imuAddr, 0x3B, b, 6)) return false;
      x = (int16_t)((b[0] << 8) | b[1]);
      y = (int16_t)((b[2] << 8) | b[3]);
      z = (int16_t)((b[4] << 8) | b[5]);
      break;
    case IMU_LSM6DS:
      // OUTX_L_XL(0x28)부터 6바이트, little-endian
      if (!i2cReadRegs(g_imuAddr, 0x28, b, 6)) return false;
      x = (int16_t)((b[1] << 8) | b[0]);
      y = (int16_t)((b[3] << 8) | b[2]);
      z = (int16_t)((b[5] << 8) | b[4]);
      break;
    default:
      return false;
  }
  out.x = x / g_lsbPerG;
  out.y = y / g_lsbPerG;
  out.z = z / g_lsbPerG;
  return true;
}

static const char* imuName() {
  switch (g_imuType) {
    case IMU_MPU6050: return "MPU-6050 계열";
    case IMU_LSM6DS:  return "LSM6DS 계열";
    default:          return "없음";
  }
}

// ============================================================================
// 분류 훅 (2단계에서 Edge Impulse 추론으로 교체)
// ============================================================================
// buf : 타격 직전 0.2초 가속도 (buf.at(0) = 가장 오래된 샘플)
// 반환: 드럼 클래스 (0 = 스네어). 2단계에서 하이햇/심벌/탐 등으로 확장.
uint8_t classifyHit(const SampleBuffer& buf) {
  (void)buf;
  return 0;
}

// ============================================================================
// 세기 계산
// ============================================================================
// [설명] 피크 크기(g) → 세기(1~127) 변환
//   t = (피크 - 2.5) / (12 - 2.5)  → 0~1 사이로 자름 → 1 + t×126
//   예) 2.5g → 1,  7.25g → 64,  12g 이상 → 127
static uint8_t magnitudeToVelocity(float peakG) {
  float t = (peakG - VEL_MIN_G) / (VEL_MAX_G - VEL_MIN_G);
  if (t < 0.0f) t = 0.0f;
  if (t > 1.0f) t = 1.0f;
  // 타격으로 판정된 이상 최소 1 (MIDI에서 velocity 0은 note-off 의미)
  return (uint8_t)(1 + lroundf(t * 126.0f));
}

// ============================================================================
// BLE
// ============================================================================
// [설명] (uint8_t)(ts >> 8) 은 32비트 정수에서 두 번째 바이트만 떼어내는 비트 연산이다.
//   예) ts = 0x0001E240 (123456) → bytes[4..7] = 40 E2 01 00
static void buildPacket(HitPacket& p, uint8_t cls, uint8_t vel, uint32_t ts) {
  p.bytes[0] = HAND_RIGHT;
  p.bytes[1] = MODE_DRUM;
  p.bytes[2] = cls;
  p.bytes[3] = vel;
  p.bytes[4] = (uint8_t)(ts);          // little-endian
  p.bytes[5] = (uint8_t)(ts >> 8);
  p.bytes[6] = (uint8_t)(ts >> 16);
  p.bytes[7] = (uint8_t)(ts >> 24);
}

// 전송 전용 태스크: 큐에서 이벤트를 꺼내 notify.
// Bluefruit의 notify는 송신 버퍼가 찰 경우 최대 100ms 대기할 수 있으므로
// 샘플링/타격 판정 루프와 분리해 둔다.
// [설명] 왜 전송을 따로 떼어 놓았나?
//   bleuart.write()는 무선 송신 버퍼가 꽉 차면 자리가 날 때까지 기다린다.
//   loop()에서 직접 보내면 그동안 센서 읽기·버튼 읽기가 멈춰 타격을 놓친다.
//   그래서 loop()는 큐에 넣기만 하고(0ms), 이 태스크가 큐에서 꺼내 보낸다.
//   xQueueReceive(..., portMAX_DELAY) : 큐에 뭔가 들어올 때까지 이 태스크만 잠들어 기다린다(CPU 소모 없음).
//   Bluefruit.connected() && notifyEnabled() : 브라우저가 연결되어 notify를 구독한 상태일 때만 보낸다.
//     → 브라우저에서 "센서 연결"을 하기 전에는 버튼을 눌러도 아무것도 전송되지 않는다.
static void bleSendLoop() {
  HitPacket p;
  if (xQueueReceive(g_hitQueue, &p, portMAX_DELAY) == pdTRUE) {
    if (Bluefruit.connected() && bleuart.notifyEnabled()) {
      bleuart.write(p.bytes, sizeof(p.bytes));
    }
  }
}

static void onConnect(uint16_t connHandle) {
  BLEConnection* conn = Bluefruit.Connection(connHandle);
  // 저지연을 위해 짧은 연결 간격 요청 (7.5~15ms). 중앙 장치가 거부할 수 있음.
  conn->requestConnectionParameter(6);
  if (!DEBUG_RAW) Serial.println(F("[BLE] 연결됨"));
}

static void onDisconnect(uint16_t connHandle, uint8_t reason) {
  (void)connHandle;
  if (!DEBUG_RAW) {
    Serial.print(F("[BLE] 연결 끊김, reason=0x"));
    Serial.println(reason, HEX);
  }
}

// [설명] BLE 초기화 순서
//   1) Bluefruit.begin()        : 무선 스택 시작
//   2) setName("AirBand-R")     : 브라우저 목록에 보일 이름
//   3) setConnInterval(6, 12)   : 연결 후 데이터 교환 주기 7.5~15ms 희망 (짧을수록 지연↓, 전력↑)
//   4) bleuart.begin()          : UART 서비스(NUS) 등록
//   5) Advertising.start(0)     : 광고 시작. 0 = 멈추지 않고 계속 광고
//   광고 패킷은 31바이트밖에 없어서 서비스 UUID(16바이트)를 넣고, 이름은 "스캔 응답" 패킷에 넣는다.
//   restartOnDisconnect(true)   : 연결이 끊기면 자동으로 다시 광고 → 브라우저에서 재연결 가능
static void bleBegin() {
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName(BLE_DEVICE_NAME);
  Bluefruit.Periph.setConnInterval(6, 12);   // 단위 1.25ms → 7.5~15ms
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  bleuart.begin();   // NUS: 6e400001-... (TX notify 6e400003, RX write 6e400002)

  // 광고 패킷: 플래그 + TX 파워 + NUS UUID(128bit) → 이름은 공간이 부족해 스캔 응답에 넣는다
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);   // 단위 0.625ms
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);               // 0 = 계속 광고
}

// 타격 이벤트를 전송 큐에 넣고 LED1을 잠깐 켠다 (IMU 타격 / 버튼 공통)
static void emitHit(uint8_t cls, uint8_t vel, uint32_t ts) {
  HitPacket p;
  buildPacket(p, cls, vel, ts);
  xQueueSend(g_hitQueue, &p, 0);   // 대기 0: 큐가 가득 차도 막히지 않음

  digitalWrite(PIN_STATUS_LED, LED_STATE_ON);
  g_ledOffMs = millis() + 30;
}

// ============================================================================
// 버튼 패드
// ============================================================================
static void buttonsBegin() {
  for (uint8_t i = 0; i < BUTTON_COUNT; i++) pinMode(BUTTON_PINS[i], INPUT_PULLUP);
}

// 눌리는 순간(HIGH → LOW)에만 이벤트를 보낸다. 상태가 바뀐 뒤 BUTTON_DEBOUNCE_MS 동안은 무시.
// [설명] pollButtons() 동작 (버튼마다 따로)
//   1) 지금 핀을 읽는다 (LOW면 눌림)
//   2) 지난번 상태와 같으면 → 할 일 없음
//   3) 바뀐 지 25ms가 안 됐으면 → 채터링으로 보고 무시
//   4) 상태를 기록하고, "안 눌림 → 눌림"으로 바뀐 순간에만 emitHit()으로 타격을 보낸다
//      (손을 뗄 때는 보내지 않는다)
//   loop()가 1ms 정도마다 돌기 때문에 누른 뒤 거의 즉시 감지된다.
static void pollButtons() {
  uint32_t nowMs = millis();
  for (uint8_t i = 0; i < BUTTON_COUNT; i++) {
    bool pressed = digitalRead(BUTTON_PINS[i]) == LOW;
    if (pressed == g_btnPressed[i]) continue;
    if (nowMs - g_btnChangedMs[i] < BUTTON_DEBOUNCE_MS) continue;
    g_btnPressed[i]   = pressed;
    g_btnChangedMs[i] = nowMs;
    if (!pressed) continue;

    emitHit(i, BUTTON_VELOCITY, nowMs);
#if HIT_LOG_ENABLED
    Serial.print(F("BTN t="));
    Serial.print(nowMs);
    Serial.print(F(" button="));
    Serial.print(i + 1);
    Serial.print(F(" cls="));
    Serial.println(i);
#endif
  }
}

// ============================================================================
// 타격 감지
// ============================================================================
// 직전 샘플(m1)이 국소 최대값(m2 < m1 >= m0)이고 임계값 이상이며
// 불응기가 지났으면 타격으로 판정한다. 피크 샘플 바로 다음 샘플에서 판정하므로
// 추가 지연은 1샘플(10ms)이고, 대신 세기가 정확히 피크 값으로 계산된다.
// [설명] 피크 감지 그림 (m2 → m1 → m0 순서로 시간이 흐름)
//
//        g
//        │        m1 ← 여기가 꼭대기(피크)이고 2.5g 이상이면 타격!
//        │       ╱  ╲
//        │     m2     m0
//   2.5g ┼ ─ ─ ─ ─ ─ ─ ─ ─
//        └──────────────── 시간 (10ms 간격)
//
//   m0가 들어와야 m1이 꼭대기였는지 알 수 있으므로 판정이 10ms 늦다. 대신 세기를 정확히 잰다.
//   불응기(60ms): 스틱이 튕겨 생기는 두 번째 피크를 또 하나의 타격으로 세지 않게 막는다.
static void detectHit(float m0) {
  bool isPeak = (g_m1 >= HIT_THRESHOLD_G) && (g_m1 > g_m2) && (g_m1 >= m0);
  bool refractoryOver = !g_hasHit || (g_m1Ms - g_lastHitMs >= REFRACTORY_MS);

  if (isPeak && refractoryOver) {
    g_hasHit    = true;
    g_lastHitMs = g_m1Ms;

    uint8_t cls = classifyHit(g_ring);
    uint8_t vel = magnitudeToVelocity(g_m1);

    emitHit(cls, vel, g_m1Ms);

#if HIT_LOG_ENABLED
    // USB CDC는 터미널이 열려 있지 않으면 쓰기를 버리므로 막히지 않는다
    Serial.print(F("HIT t="));
    Serial.print(g_m1Ms);
    Serial.print(F(" peak="));
    Serial.print(g_m1, 2);
    Serial.print(F("g vel="));
    Serial.print(vel);
    Serial.print(F(" cls="));
    Serial.println(cls);
#endif
  }
}

// ============================================================================
// setup / loop
// ============================================================================
// [설명] setup() 순서
//   LED 끄기 → USB 시리얼 시작(최대 1.5초 대기) → I2C 시작 → I2C 스캔(연결된 장치 주소 출력)
//   → IMU 찾기(최대 3번, 없으면 버튼 전용 모드) → 버튼 핀 설정
//   → 전송 큐 만들기 → BLE 시작 + 광고 → BLE 전송 태스크 시작
//   시리얼 모니터(115200 baud)를 열면 이 과정이 로그로 보인다.
void setup() {
  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, !LED_STATE_ON);

  Serial.begin(115200);
  // 시리얼 터미널 없이도 동작해야 하므로 연결을 무한정 기다리지 않는다 (최대 1.5초)
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) delay(10);

  Wire.setPins(PIN_IMU_SDA, PIN_IMU_SCL);
  Wire.begin();
  Wire.setClock(I2C_CLOCK_HZ);

  if (!DEBUG_RAW) Serial.println(F("\n=== AirBand-R 1단계 데모 ==="));
  i2cScan();

  // IMU 감지. 버튼 모드가 켜져 있으면 몇 번만 시도하고, 못 찾으면 버튼 전용으로 진행한다.
  // 버튼 모드가 꺼져 있으면 찾을 때까지 LED를 빠르게 깜빡이며 2초마다 재시도한다 (배선 확인용).
  uint8_t tries = 0;
  while (!imuBegin()) {
    if (!DEBUG_RAW) Serial.println(F("[IMU] 감지 실패 — 배선/주소/모델 확인 후 재시도"));
    printWhoAmI();
    if (ENABLE_BUTTONS && ++tries >= IMU_BOOT_TRIES) break;
    for (int i = 0; i < 10; i++) {
      digitalWrite(PIN_STATUS_LED, (i & 1) ? LED_STATE_ON : !LED_STATE_ON);
      delay(200);
    }
    i2cScan();
  }
  digitalWrite(PIN_STATUS_LED, !LED_STATE_ON);

  if (!DEBUG_RAW) {
    Serial.print(F("[IMU] "));
    Serial.print(imuName());
    if (g_imuType != IMU_NONE) {
      Serial.print(F(" @ 0x"));
      Serial.println(g_imuAddr, HEX);
    } else {
      Serial.println(F(" — 버튼 전용 모드로 동작"));
    }
  }

#if ENABLE_BUTTONS
  buttonsBegin();
  if (!DEBUG_RAW) Serial.println(F("[BTN] 버튼 1~4 → 드럼 0~3 (스네어/킥/하이햇/탐)"));
#endif

  g_hitQueue = xQueueCreate(HIT_QUEUE_LEN, sizeof(HitPacket));
  bleBegin();
  Scheduler.startLoop(bleSendLoop);

  if (!DEBUG_RAW) {
    Serial.print(F("[BLE] 광고 시작: "));
    Serial.println(BLE_DEVICE_NAME);
  }

  g_nextSampleUs = micros();
}

// [설명] loop() 한 바퀴
//   1) 버튼 읽기 — 매번 (약 1ms마다)
//   2) 아직 다음 샘플 시각(10ms 간격)이 안 됐으면 → LED 끌 시간인지 확인하고 1ms 쉬고 끝
//   3) 샘플 시각이 됐으면 → IMU 읽기 → 링버퍼에 저장 → 크기 계산 → 피크 감지
//   IMU가 없으면(버튼 전용 모드) 3)의 imuReadAccel()이 false라서 바로 끝난다.
//   delay(10) 대신 micros() 비교를 쓰는 이유: 처리 시간과 상관없이 정확히 10ms 간격을 지키려고.
void loop() {
#if ENABLE_BUTTONS
  pollButtons();
#endif
  uint32_t nowUs = micros();

  // 주기 유지: 다음 샘플 시각이 안 됐으면 잠깐 양보.
  // (타이밍 기준은 micros() 비교이고, delay(1)은 CPU를 쉬게 하고 BLE 태스크에 양보하는 용도)
  if ((int32_t)(nowUs - g_nextSampleUs) < 0) {
    if (g_ledOffMs && (int32_t)(millis() - g_ledOffMs) >= 0) {
      digitalWrite(PIN_STATUS_LED, !LED_STATE_ON);
      g_ledOffMs = 0;
    }
    if (g_nextSampleUs - nowUs > 1500) delay(1);
    return;
  }

  g_nextSampleUs += SAMPLE_PERIOD_US;
  // 처리가 한 주기 이상 밀렸으면 누적 지연을 버리고 다시 맞춘다
  if ((int32_t)(nowUs - g_nextSampleUs) > (int32_t)SAMPLE_PERIOD_US) {
    g_nextSampleUs = nowUs + SAMPLE_PERIOD_US;
  }

  AccelSample s;
  if (!imuReadAccel(s)) return;   // IMU 없음(버튼 전용 모드)이면 여기서 끝
  uint32_t nowMs = millis();

  g_ring.push(s, nowMs);

#if DEBUG_RAW
  // Edge Impulse Data Forwarder 형식: 한 줄에 "ax,ay,az"
  Serial.print(s.x, 4); Serial.print(',');
  Serial.print(s.y, 4); Serial.print(',');
  Serial.println(s.z, 4);
#endif

  float m0 = sqrtf(s.x * s.x + s.y * s.y + s.z * s.z);
  detectHit(m0);

  g_m2 = g_m1;
  g_m1 = m0;
  g_m1Ms = nowMs;
}
