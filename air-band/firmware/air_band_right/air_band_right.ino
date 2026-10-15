/*
 * 에어 밴드 2단계 — 오른손 드럼 센서 펌웨어 (IMU 방향으로 드럼 고르기)
 *
 * 보드 : NUCODE NU40 DK (nRF52840)
 * 코어 : NUBoards nRF52 by NUCODE (FQBN nucode:nrf52:nu40dk)
 *
 * 흐름: IMU 6축 100Hz 샘플링 → 스틱 방향 추정(orientation.h) → 링버퍼(0.2초)
 *       → 피크 감지 → 분류 훅(타격 순간 방향 → 하이햇/스네어/탐/크래시) → BLE notify(NUS)
 *       보드 버튼 1~4 → 드럼 클래스 0~3 → BLE notify (IMU 없이도 동작하는 PoC 모드)
 *
 * 설정 요약 (자세한 건 air-band/README.md 참고)
 *   - DEBUG_RAW  1 : Edge Impulse Data Forwarder용 CSV(ax,ay,az,gx,gy,gz) 출력
 *   - DEBUG_HITS 1 : 타격 로그를 시리얼에 출력
 *   - DEBUG_ZONE 1 : 스틱이 가리키는 구역이 바뀔 때마다 시리얼에 출력
 *   - 튜닝 상수   : HIT_THRESHOLD_G, REFRACTORY_MS, VEL_MIN_G, VEL_MAX_G
 *   - 구역 상수   : STICK_AXIS, ZONE_LEFT_DEG, ZONE_RIGHT_DEG, ZONE_UP_DEG
 *   - 명령(시리얼 또는 BLE RX로 한 글자): c 정면 맞추기 · m 모션 스트림 켜기 · x 끄기 · ? 상태
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
 *   IMU 읽기 → 방향 추정 → detectHit() ─┘
 *            └→ (웹이 요청하면) 모션 패킷 25Hz → 별도 우체통 → bleSendLoop()
 *
 * 브라우저로 보내는 것은 "소리"가 아니라 8바이트짜리 "타격 정보"다.
 * (어떤 드럼 / 얼마나 세게 / 언제). 소리는 브라우저(web/src/audio.ts)가 낸다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// [설명] 라이브러리
//   bluefruit.h : Adafruit의 nRF52용 BLE 라이브러리. 광고·연결·UART 서비스를 쉽게 쓰게 해 준다.
//   Wire.h      : 아두이노 표준 I2C 라이브러리. IMU 센서와 통신할 때 쓴다.
//   두 라이브러리 모두 보드 패키지(BSP)에 들어 있어서 따로 설치할 필요가 없다.
//   orientation.h : 이 폴더에 있는 스틱 방향 추정 · 구역 판정 코드 (아두이노 API 없이 계산만)
#include <bluefruit.h>
#include <Wire.h>
#include "orientation.h"
#include "ictus.h"
#include <InternalFileSystem.h>

using airband::Vec3;

// ============================================================================
// 디버그 플래그
// ============================================================================
#define DEBUG_RAW   0   // 1이면 CSV(ax,ay,az,gx,gy,gz)만 출력 (데이터 수집용)
#define DEBUG_HITS  1   // 1이면 타격 로그 출력 (DEBUG_RAW=1이면 CSV가 섞이지 않도록 자동으로 꺼짐)
#define DEBUG_ZONE  1   // 1이면 스틱 구역이 바뀔 때 "[ZONE] 하이햇" 출력 (DEBUG_RAW=1이면 꺼짐)
#define HIT_LED     0   // 1이면 타격마다 LED1을 30ms 켠다 (웹 없이 타격 감지 확인용 디버그. 제품 기능 아님)

// [설명] #define / #if 는 "컴파일 전에" 처리된다.
//   값이 0이면 해당 코드가 아예 빌드에서 빠지므로, 실행 중 if 문 비용이 없다.
//   예) DEBUG_RAW를 1로 바꾸고 다시 업로드하면 센서 원본 데이터만 출력하는 펌웨어가 된다.
#if DEBUG_RAW
  #define HIT_LOG_ENABLED  0
  #define ZONE_LOG_ENABLED 0
#else
  #define HIT_LOG_ENABLED  DEBUG_HITS
  #define ZONE_LOG_ENABLED DEBUG_ZONE
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
// 2026-10-07 확인: 누코드로 연결한 가상 IMU가 0x6A에서 WHO_AM_I=0x6A(LSM6DS3TR-C/LSM6DSL 호환)로 응답하고,
//                  가속도·자이로 모두 정상 값(정지 시 |a|≈0.98g, 자이로 ±4°/s 이내)이 나온다.
// 위 두 계열이 아니면 imuBegin()/imuRead()에 드라이버를 추가할 것.
// 부팅 시 시리얼에 I2C 스캔 결과가 출력되니 그 주소를 참고.
//
// [설명] 6축 = 가속도 3축 + 자이로 3축
//   가속도(g)   : 얼마나 세게 밀리는지 + 중력 방향. 타격 세기와 위아래 기울기에 쓴다.
//   자이로(°/s) : 얼마나 빨리 도는지. 시간에 따라 더하면 좌우로 얼마나 돌렸는지 알 수 있다.

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
// [설명] 방향(각도) 적분은 센서 값마다(LSM6DS 416Hz, 그 밖은 400Hz 타이머) — integrateSample() 참고.
//   타격 감지 · 링버퍼 · 모션 패킷 등 나머지는 그대로 100Hz.
static const uint32_t FAST_PERIOD_US    = 2500;   // LSM6DS가 아닐 때 읽는 간격 (400Hz)
// 자이로 측정 한계(±2000°/s) 근처면 그 순간 회전을 다 못 잰 것 → 횟수를 세어 '?' 상태에 보인다
static const float    GYRO_SAT_DPS      = 1950.0f;

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
// 드럼 구역 (2단계) — 타격 순간 스틱 방향으로 드럼을 고른다
// ============================================================================
// [설명] 기준(정면) = 부팅 직후 자세, 또는 "정면 맞추기"(명령 c)를 한 순간의 자세.
//   기준에서 왼쪽으로 ZONE_LEFT_DEG 이상 → 하이햇, 오른쪽으로 ZONE_RIGHT_DEG 이상 → 탐,
//   위로 ZONE_UP_DEG 이상 들면 → 크래시, 나머지 → 스네어. 킥은 발이라 버튼 2로 친다.
//   오른손잡이 드럼 세트 배치(하이햇 왼쪽, 플로어 탐 오른쪽, 심벌 위)를 따랐다.
#define USE_ZONE_CLASSIFIER 1   // 0이면 1단계처럼 항상 스네어 (TinyML로 바꿀 때도 0에서 시작)

// TinyML (3단계): 웹 tinyml.html에서 내 스윙 데이터로 학습 → zone_model.h 내보내기 → 이 폴더에 넣고 업로드.
//   zone_model.h가 있으면 구역 규칙 대신 모델이 "타격 직전 0.24초 궤적"(방향 + 가속도 크기)을 보고 드럼을 고른다.
//   모델이 "노이즈"(걷기 · 스틱 들기 같은 치지 않는 동작)로 판정하면 그 타격은 보내지 않는다.
//   파일이 없으면 자동으로 규칙 기반으로 동작하므로 1로 둬도 안전하다.
#define USE_TINYML 1
#if USE_TINYML && defined(__has_include)
  #if __has_include("zone_model.h")
    #include "zone_model.h"
    #define TINYML_ACTIVE 1
    // 입력은 25Hz마다 [좌우°, 위아래°, 최대 가속도 g] 3개. 예전(방향만 2개) 모델이면 웹에서 다시 학습 · 내보내기
    static_assert(ZONE_MODEL_INPUTS == ZONE_MODEL_WINDOW * 3, "zone_model.h가 예전 형식입니다 - tinyml.html에서 다시 내보내세요");
  #endif
#endif
#ifndef TINYML_ACTIVE
  #define TINYML_ACTIVE 0
#endif
// classifyHit()이 이 값을 돌려주면 "치지 않는 동작"이라 보내지 않는다 (웹 tinyml model.ts NOISE와 같음)
#ifdef ZONE_MODEL_NOISE
static const uint8_t CLASS_NOISE = ZONE_MODEL_NOISE;
#else
static const uint8_t CLASS_NOISE = 9;
#endif

// 센서 좌표계에서 스틱 끝을 가리키는 축. 센서를 스틱에 붙인 방향에 맞춰 바꾼다.
// 예) 칩의 +X 화살표가 스틱 끝을 향하면 {1,0,0}, -Y가 향하면 {0,-1,0}
// 틀리게 두면 좌우 판정이 엉뚱하게 나온다 (README "구역 튜닝" 참고).
// 직접 고치지 않아도 된다: 스틱 끝을 천장으로 세우고 'a'(축 맞추기)를 보내면 중력 방향으로 축을 재서
// 플래시(AXIS_FILE)에 저장하고, 다음 부팅부터 그 값을 쓴다. 이 상수는 저장된 값이 없을 때의 기본값이다.
static const Vec3  STICK_AXIS     = { 1.0f, 0.0f, 0.0f };
// 2026-10-14: 사용자 실기 "드럼이 한곳에 모여 있어 방향이 잘 안 맞음 · 스틱을 넓게 씀" → 드럼 간격 3단계.
//   웹이 연결할 때 명령 '1' 좁게 · '2' 보통 · '3' 넓게 를 보낸다 (웹 motion.ts ZONE_PRESETS와 같은 값).
//   아래는 명령이 오기 전(부팅 직후) 기본값 = 보통.
static const float ZONE_LEFT_DEG  = 40.0f;  // 하이햇 경계. 스네어인데 하이햇이 나오면 ↑
static const float ZONE_RIGHT_DEG = 40.0f;  // 탐 경계. 스네어인데 탐이 나오면 ↑
static const float ZONE_UP_DEG    = 35.0f;  // 크래시 경계. 내려칠 때 크래시가 나오면 ↑
// 드럼 간격 단계: [좌우°, 위°]
static const float ZONE_PRESETS[3][2] = { { 25.0f, 25.0f }, { 40.0f, 35.0f }, { 55.0f, 45.0f } };

// 방향 추정 필터 (orientation.h)
static const float ORIENT_KP      = 1.0f;   // 중력으로 기울기를 바로잡는 세기
static const float ACCEL_TRUST_G  = 0.25f;  // |가속도|가 1g±이 값 밖이면(휘두르는 중) 중력 보정 쉼
// 부팅 시 자이로 오차 측정: 1초 동안 가만히 둔 평균. 흔들리면 최대 GYRO_CAL_TRIES번 다시 잰다.
static const uint16_t IMU_SETTLE_MS      = 300;   // 자이로를 켠 직후 값이 0이거나 튀므로 이만큼 버리고 시작
static const uint16_t GYRO_CAL_SAMPLES   = 100;
static const float    GYRO_CAL_MAX_SPREAD_DPS = 10.0f; // 어느 축이든 (최대-최소)가 이보다 크면 "움직임"으로 보고 다시 (정지 시 1~7, 손에 들면 수십)
static const uint8_t  GYRO_CAL_TRIES     = 3;

// 모션 스트림: 웹이 'm' 명령을 보내면 방향·구역을 이 주기로 보낸다 (화면 표시·튜닝용)
static const uint8_t  MOTION_STREAM_HZ   = 25;

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
static const uint8_t MODE_CONDUCT    = 1;     // 지휘: 패킷 class 0 = 박, velocity = 박 크기, 시각 = 바닥점
static const uint8_t HIT_QUEUE_LEN   = 8;     // 전송 대기 큐 길이 (가득 차면 가장 새 이벤트를 버림)
static const uint8_t PKT_MOTION      = 0x80;  // 모션 패킷 표시 (타격 패킷의 0번 바이트 hand는 0/1)
static const uint8_t PKT_AXIS        = 0x81;  // 축 맞추기 결과 [1] 1=성공 0=실패 [2..7] 축 x,y,z ×10000 (int16)

// ============================================================================
// 자료형
// ============================================================================

// IMU 한 샘플: 가속도(g) + 자이로(°/s, 오차 보정 전 원본)
struct ImuSample {
  Vec3 acc;
  Vec3 gyro;
};

// 직전 0.2초 원형 버퍼. 2단계 분류 모델 입력으로 쓴다.
// [설명] 원형(링) 버퍼
//   배열 끝까지 쓰면 다시 처음으로 돌아가 가장 오래된 값을 덮어쓴다.
//   head는 "다음에 쓸 칸", count는 "지금까지 채운 개수"(최대 20).
//   예) 21번째 샘플은 0번 칸(1번째 샘플 자리)에 들어간다. 메모리를 새로 잡지 않아서 빠르고 안전하다.
struct SampleBuffer {
  ImuSample   data[RING_SIZE];
  uint32_t    t_ms[RING_SIZE];
  uint16_t    head  = 0;   // 다음에 쓸 위치
  uint16_t    count = 0;   // 채워진 샘플 수 (최대 RING_SIZE)

  void push(const ImuSample& s, uint32_t ms) {
    data[head] = s;
    t_ms[head] = ms;
    head = (head + 1) % RING_SIZE;
    if (count < RING_SIZE) count++;
  }

  // i = 0 이 가장 오래된 샘플, i = count-1 이 가장 최근 샘플
  const ImuSample& at(uint16_t i) const {
    uint16_t start = (head + RING_SIZE - count) % RING_SIZE;
    return data[(start + i) % RING_SIZE];
  }
};

// BLE로 보내는 8바이트 타격 이벤트
// [설명] 패킷 구조 (브라우저의 web/src/ble.ts parsePackets()와 반드시 같아야 한다)
//   [0] hand     : 0 = 오른손
//   [1] mode     : 0 = 드럼
//   [2] class    : 0 스네어, 1 킥, 2 하이햇, 3 탐, 4 크래시
//   [3] velocity : 1~127 (세기)
//   [4..7] 보드 시각 millis() — 4바이트 정수를 1바이트씩 쪼개서 넣는다(little-endian: 작은 자리부터)
//
// 모션 패킷도 같은 8바이트 크기라서 웹은 8바이트씩 잘라 0번 바이트로 구분한다.
//   [0] 0x80 (PKT_MOTION)
//   [1] zone      : 지금 치면 나올 드럼 클래스
//   [2..3] heading   : 기준 대비 좌우 각도 × 10 (int16, + = 왼쪽)
//   [4..5] elevation : 기준 대비 위아래 각도 × 10 (int16, + = 위)
//   [6..7] |가속도|  : 직전 40ms 블록의 최대값, mg 단위 (uint16) — 타격 임계값 튜닝 · TinyML 입력용
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
static float        g_lsbPerDps = 1.0f;

static SampleBuffer g_ring;
static uint32_t     g_nextSampleUs = 0;
static float        g_gyroPeakDps = 0;      // '?' 이후 가장 빠른 회전 (°/s)
static uint32_t     g_gyroSatCount = 0;     // 자이로 한계 근처였던 샘플 수
// 센서 값마다 방향 적분 (integrateSample)
static const float LSM_ODR_HZ = 416.0f;
static float       g_odrPeriodS = 1.0f / LSM_ODR_HZ;   // 센서 값 간격 (재서 맞춘다)
static ImuSample   g_lastSample;
static bool        g_haveSample = false;
static uint32_t    g_nextFastUs = 0;
static uint32_t    g_lastReadUs = 0;
static uint32_t    g_odrSamples = 0, g_odrStartUs = 0;
static uint32_t    g_maxGapUs = 0;        // '?' 이후 센서 읽기 사이 가장 긴 간격 (BLE 등으로 밀렸나)
static uint32_t    g_missedSamples = 0;   // 못 읽고 지나간 센서 값 개수 (그 자리는 다음 값으로 메움)

// 스틱 방향 추정 (orientation.h)
static airband::StickOrientation g_orient;
static airband::GyroBias         g_gyroBias;
static airband::ZoneConfig ZONES = { ZONE_LEFT_DEG, ZONE_RIGHT_DEG, ZONE_UP_DEG };   // 명령 1/2/3으로 바뀜
static Vec3         g_stickAxis = STICK_AXIS; // 지금 쓰는 스틱 끝 축 (플래시에 저장된 값이 있으면 그것)
static const char*  AXIS_FILE = "/airband_axis.bin";
static bool         g_orientReady = false;   // 부팅 보정을 마치고 방향 추정을 시작했는지
static bool         g_calSteady = false;     // 부팅 보정이 가만히 있는 상태에서 끝났는지 ('?' 상태에 표시)
static float        g_calSpread = 0.0f;      // 마지막 보정 시도에서 가장 크게 흔들린 축의 (최대-최소) °/s

// 피크 감지용: 현재(m0), 직전(m1), 그 전(m2) 샘플의 크기. m1 순간의 구역도 함께 기억한다.
static float        g_m1 = 0.0f, g_m2 = 0.0f;
static uint32_t     g_m1Ms = 0;
static uint8_t      g_m1Zone = airband::DRUM_SNARE;
static uint32_t     g_lastHitMs = 0;
static bool         g_hasHit = false;

static uint32_t     g_ledOffMs = 0;

#if TINYML_ACTIVE
// 모델 입력용 기록: 25Hz 블록마다 [좌우°, 위아래°, 그 40ms 동안 최대 가속도 g]를 최근 ZONE_MODEL_WINDOW개만 둔다.
// 웹(tinyml.html)이 모션 패킷으로 모은 학습 데이터와 같은 값이다 (모션 패킷도 같은 블록에서 만든다).
static float   g_featH[ZONE_MODEL_WINDOW], g_featE[ZONE_MODEL_WINDOW], g_featG[ZONE_MODEL_WINDOW];
static uint8_t g_featHead = 0, g_featCount = 0;
#endif

// 버튼 디바운스 상태
static bool         g_btnPressed[BUTTON_COUNT] = {};
static uint32_t     g_btnChangedMs[BUTTON_COUNT] = {};

static BLEUart       bleuart;
static QueueHandle_t g_hitQueue = nullptr;
static QueueHandle_t g_motionQueue = nullptr;   // 1칸: 항상 가장 최근 모션만 (덮어쓰기)
static volatile uint8_t g_mode = MODE_DRUM;     // 웹이 'k'(지휘) · 'd'(드럼)로 바꾼다. 연결이 끊기면 드럼
static airband::IctusDetector g_ictus;
static volatile bool g_streamMotion = false;    // 웹이 'm'으로 켜고 'x'로 끈다. 연결이 끊기면 꺼짐
static uint8_t       g_blockDiv = 0;          // 100Hz 샘플 4개(40ms)마다 한 블록 → 모션 패킷 · 모델 입력 (25Hz)
static float         g_blockMaxG = 0.0f;      // 이번 블록의 최대 |가속도| (25Hz로 띄엄띄엄 보면 타격 피크를 놓치므로)

// 구역 변경 로그용 (경계에서 왔다 갔다 할 때 줄이 쏟아지지 않도록 0.15초 유지돼야 출력)
static uint8_t       g_loggedZone = 0xFF, g_pendingZone = 0xFF;
static uint8_t       g_pendingCount = 0;

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

// I2C 버스 풀기 (Wire.begin() 전에 호출)
// [설명] 센서가 데이터를 보내는 도중에 보드가 리셋되면, 센서는 남은 클럭을 기다리며 SDA를 LOW로
//   붙잡고 있을 수 있다. 그러면 Wire 라이브러리가 끝없이 기다려 부팅이 멈춘다
//   (2026-10-07 업로드를 연달아 하다가 실제로 "[I2C] scan:"에서 멈춤).
//   해결: SCL을 직접 최대 9번 깜빡여 센서가 바이트를 끝내게 한 뒤 STOP 신호를 보낸다.
//   핀은 LOW로 끌어내리거나(OUTPUT LOW) 놓아주기만(INPUT_PULLUP) 해서 I2C처럼 오픈 드레인으로 다룬다.
static bool i2cBusRecover() {
  auto release = [](uint8_t pin) { pinMode(pin, INPUT_PULLUP); };
  auto pullLow = [](uint8_t pin) { pinMode(pin, OUTPUT); digitalWrite(pin, LOW); };
  release(PIN_IMU_SDA);
  release(PIN_IMU_SCL);
  delayMicroseconds(10);
  if (digitalRead(PIN_IMU_SDA) == HIGH && digitalRead(PIN_IMU_SCL) == HIGH) return false;   // 정상

  for (uint8_t i = 0; i < 9 && digitalRead(PIN_IMU_SDA) == LOW; i++) {
    pullLow(PIN_IMU_SCL);  delayMicroseconds(5);
    release(PIN_IMU_SCL);  delayMicroseconds(5);
  }
  // STOP: SCL이 HIGH인 동안 SDA를 LOW → HIGH
  pullLow(PIN_IMU_SDA);    delayMicroseconds(5);
  release(PIN_IMU_SCL);    delayMicroseconds(5);
  release(PIN_IMU_SDA);    delayMicroseconds(5);
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
  // GYRO_CONFIG: ±2000°/s (16.4 LSB/(°/s)) — 손목 스냅은 1000°/s를 넘기도 한다
  i2cWriteReg(addr, 0x1B, 0x18);
  g_lsbPerG = 2048.0f;
  g_lsbPerDps = 16.4f;
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
  // CTRL2_G: ODR 416Hz, FS ±2000°/s (70 m°/s/LSB)
  i2cWriteReg(addr, 0x11, 0x6C);
  g_lsbPerG = 1000.0f / 0.488f;
  g_lsbPerDps = 1000.0f / 70.0f;
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
  // 다른 IMU(BMI160, ICM-42688 등)를 쓰면 여기에 begin 함수를 추가
  return false;
}

// 가속도(g)와 자이로(°/s) 6축을 한 번에 읽는다. 다른 코드는 단위만 알면 되고 칩 종류는 모른다.
static bool imuRead(ImuSample& out) {
  uint8_t b[14];
  int16_t a[3], g[3];
  switch (g_imuType) {
    case IMU_MPU6050:
      // ACCEL_XOUT_H(0x3B)부터 14바이트 = 가속도 6 + 온도 2 + 자이로 6, big-endian
      if (!i2cReadRegs(g_imuAddr, 0x3B, b, 14)) return false;
      for (uint8_t i = 0; i < 3; i++) {
        a[i] = (int16_t)((b[i * 2] << 8) | b[i * 2 + 1]);
        g[i] = (int16_t)((b[8 + i * 2] << 8) | b[8 + i * 2 + 1]);
      }
      break;
    case IMU_LSM6DS:
      // OUTX_L_G(0x22)부터 12바이트 = 자이로 6 + 가속도 6, little-endian
      if (!i2cReadRegs(g_imuAddr, 0x22, b, 12)) return false;
      for (uint8_t i = 0; i < 3; i++) {
        g[i] = (int16_t)((b[i * 2 + 1] << 8) | b[i * 2]);
        a[i] = (int16_t)((b[6 + i * 2 + 1] << 8) | b[6 + i * 2]);
      }
      break;
    default:
      return false;
  }
  out.acc  = { a[0] / g_lsbPerG, a[1] / g_lsbPerG, a[2] / g_lsbPerG };
  out.gyro = { g[0] / g_lsbPerDps, g[1] / g_lsbPerDps, g[2] / g_lsbPerDps };
  return true;
}

static const char* imuName() {
  switch (g_imuType) {
    case IMU_MPU6050: return "MPU-6050 계열";
    case IMU_LSM6DS:  return "LSM6DS 계열";
    default:          return "없음";
  }
}

// 시리얼 로그용 드럼 이름 (web audio.ts의 DRUM_CLASSES 순서)
static const char* drumName(uint8_t cls) {
  static const char* const NAMES[] = { "스네어", "킥", "하이햇", "탐", "크래시" };
  return cls < sizeof(NAMES) / sizeof(NAMES[0]) ? NAMES[cls] : "?";
}

// ============================================================================
// 분류 훅
// ============================================================================
// buf      : 타격 직전 0.2초 6축 샘플 (buf.at(0) = 가장 오래된 샘플)
// peakZone : 피크 순간 스틱이 가리키던 구역 (orientation.h)
// 반환     : 드럼 클래스, 또는 CLASS_NOISE(모델이 "치지 않는 동작"으로 판정 → 보내지 않음)
//
// 지금은 규칙 기반(방향 구역)이다. Edge Impulse 모델로 바꿀 때는 buf를 모델 입력으로 넣고,
// 결과를 그대로 돌려주거나 peakZone과 조합하면 된다 (예: 모델은 "치기/긁기" 동작, 구역은 드럼 종류).
uint8_t classifyHit(const SampleBuffer& buf, uint8_t peakZone) {
  (void)buf;
#if TINYML_ACTIVE
  // 학습한 모델: 직전 궤적이 다 모였으면 모델로, 아니면(부팅 직후 0.24초) 아래 규칙으로
  if (g_orientReady && g_featCount >= ZONE_MODEL_WINDOW) {
    float x[ZONE_MODEL_INPUTS];
    for (uint8_t k = 0; k < ZONE_MODEL_WINDOW; k++) {
      uint8_t i = (g_featHead + k) % ZONE_MODEL_WINDOW;   // 가장 오래된 것부터
      x[3 * k]     = g_featH[i];
      x[3 * k + 1] = g_featE[i];
      x[3 * k + 2] = g_featG[i];
    }
    return zoneModelPredict(x);
  }
#endif
#if USE_ZONE_CLASSIFIER
  return g_orientReady ? peakZone : airband::DRUM_SNARE;
#else
  (void)peakZone;
  return airband::DRUM_SNARE;
#endif
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
static void buildPacket(HitPacket& p, uint8_t cls, uint8_t vel, uint32_t ts, uint8_t mode = MODE_DRUM) {
  p.bytes[0] = HAND_RIGHT;
  p.bytes[1] = mode;
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
//   타격이 항상 먼저다: 타격 큐를 최대 5ms 기다리고(타격이 들어오면 즉시 깨어남),
//   그동안 타격이 없을 때만 모션 큐를 확인한다.
static void bleSendLoop() {
  HitPacket p;
  bool got = xQueueReceive(g_hitQueue, &p, ms2tick(5)) == pdTRUE;
  if (!got) got = xQueueReceive(g_motionQueue, &p, 0) == pdTRUE;
  if (got && Bluefruit.connected() && bleuart.notifyEnabled()) {
    bleuart.write(p.bytes, sizeof(p.bytes));
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
  g_streamMotion = false;   // 다음에 연결한 브라우저가 원할 때 다시 켠다
  g_mode = MODE_DRUM;
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

// 타격 이벤트를 전송 큐에 넣는다 (IMU 타격 / 버튼 공통). HIT_LED 1이면 LED1도 잠깐 켠다
static void emitHit(uint8_t cls, uint8_t vel, uint32_t ts) {
  HitPacket p;
  buildPacket(p, cls, vel, ts);
  xQueueSend(g_hitQueue, &p, 0);   // 대기 0: 큐가 가득 차도 막히지 않음

#if HIT_LED
  digitalWrite(PIN_STATUS_LED, LED_STATE_ON);
  g_ledOffMs = millis() + 30;
#endif
}

// ============================================================================
// 모션 스트림 · 명령 (2단계)
// ============================================================================
static int16_t toDeci(float deg) {
  if (deg > 3000.0f) deg = 3000.0f;
  if (deg < -3000.0f) deg = -3000.0f;
  return (int16_t)lroundf(deg * 10.0f);
}

// 현재 방향을 모션 패킷으로 만들어 1칸 큐에 덮어쓴다 (밀리면 오래된 것은 버리고 최신만 보냄)
static void queueMotion(uint8_t zone, float accMagG) {
  int16_t  h  = toDeci(g_orient.headingDeg());
  int16_t  e  = toDeci(g_orient.elevationDeg());
  uint32_t mg = (uint32_t)lroundf(accMagG * 1000.0f);
  if (mg > 0xFFFF) mg = 0xFFFF;
  HitPacket p;
  p.bytes[0] = PKT_MOTION;
  p.bytes[1] = zone;
  p.bytes[2] = (uint8_t)(h);   p.bytes[3] = (uint8_t)((uint16_t)h >> 8);
  p.bytes[4] = (uint8_t)(e);   p.bytes[5] = (uint8_t)((uint16_t)e >> 8);
  p.bytes[6] = (uint8_t)(mg);  p.bytes[7] = (uint8_t)(mg >> 8);
  xQueueOverwrite(g_motionQueue, &p);
}

// 저장된 스틱 축 읽기 (setup에서 IMU 보정 전에). 없거나 이상하면 STICK_AXIS 그대로.
static void loadStickAxis() {
  InternalFS.begin();
  Adafruit_LittleFS_Namespace::File f = InternalFS.open(AXIS_FILE, Adafruit_LittleFS_Namespace::FILE_O_READ);
  if (!f) return;
  Vec3 v;
  bool ok = f.read((uint8_t*)&v, sizeof(v)) == sizeof(v);
  f.close();
  float n = sqrtf(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!ok || fabsf(n - 1.0f) > 0.05f) return;
  g_stickAxis = v;
  if (!DEBUG_RAW) {
    Serial.print(F("[AXIS] 저장된 스틱 축 사용 ("));
    Serial.print(v.x, 2); Serial.print(','); Serial.print(v.y, 2); Serial.print(','); Serial.print(v.z, 2);
    Serial.println(')');
  }
}

static void saveStickAxis() {
  InternalFS.remove(AXIS_FILE);
  Adafruit_LittleFS_Namespace::File f = InternalFS.open(AXIS_FILE, Adafruit_LittleFS_Namespace::FILE_O_WRITE);
  if (!f) return;
  f.write((const uint8_t*)&g_stickAxis, sizeof(g_stickAxis));
  f.close();
}

// [설명] 축 맞추기: 스틱 끝을 천장으로 세우고 가만히 있으면 가속도계에는 중력의 반작용(+1g)이
//   "센서 기준 위쪽" = 스틱 끝 방향으로 읽힌다. 그래서 직전 0.2초 가속도 평균을 정규화하면 그게 스틱 축이다.
//   센서를 비스듬히 붙여도 맞는다. 0.2초 동안 흔들렸거나 1g가 아니면 실패로 보고 바꾸지 않는다.
static void calibrateAxis() {
  bool ok = false;
  Vec3 m = { 0, 0, 0 };
  uint16_t n = g_ring.count;
  if (n >= RING_SIZE) {
    for (uint16_t i = 0; i < n; i++) {
      const Vec3& a = g_ring.at(i).acc;
      m.x += a.x; m.y += a.y; m.z += a.z;
    }
    m = { m.x / n, m.y / n, m.z / n };
    float maxDev = 0.0f;
    for (uint16_t i = 0; i < n; i++) {
      const Vec3& a = g_ring.at(i).acc;
      float d = sqrtf((a.x - m.x) * (a.x - m.x) + (a.y - m.y) * (a.y - m.y) + (a.z - m.z) * (a.z - m.z));
      if (d > maxDev) maxDev = d;
    }
    float mn = sqrtf(m.x * m.x + m.y * m.y + m.z * m.z);
    ok = maxDev < 0.15f && fabsf(mn - 1.0f) < 0.15f;
    if (ok) {
      g_stickAxis = { m.x / mn, m.y / mn, m.z / mn };
      g_orient.setAxis(g_stickAxis);
      saveStickAxis();
    }
  }
  if (!DEBUG_RAW) {
    if (ok) {
      Serial.print(F("[AXIS] 스틱 축 저장 ("));
      Serial.print(g_stickAxis.x, 2); Serial.print(',');
      Serial.print(g_stickAxis.y, 2); Serial.print(',');
      Serial.print(g_stickAxis.z, 2);
      Serial.println(F(") — 이제 스틱을 스네어 쪽으로 겨누고 'c'"));
    } else {
      Serial.println(F("[AXIS] 실패 — 스틱 끝을 천장으로 세우고 가만히 든 채 다시 'a'"));
    }
  }
  HitPacket p;
  p.bytes[0] = PKT_AXIS;
  p.bytes[1] = ok ? 1 : 0;
  int16_t v[3] = { (int16_t)lroundf(g_stickAxis.x * 10000.0f), (int16_t)lroundf(g_stickAxis.y * 10000.0f),
                   (int16_t)lroundf(g_stickAxis.z * 10000.0f) };
  for (uint8_t k = 0; k < 3; k++) {
    p.bytes[2 + k * 2] = (uint8_t)v[k];
    p.bytes[3 + k * 2] = (uint8_t)((uint16_t)v[k] >> 8);
  }
  if (g_hitQueue) xQueueSend(g_hitQueue, &p, 0);
}

static void printStatus() {
  if (DEBUG_RAW) return;
  Serial.print(F("[STATUS] IMU="));     Serial.print(imuName());
  Serial.print(F(" BLE="));             Serial.print(Bluefruit.connected() ? F("연결") : F("대기"));
  Serial.print(F(" mode="));            Serial.print(g_mode == MODE_CONDUCT ? F("conduct") : F("drum"));
  Serial.print(F(" stream="));          Serial.print(g_streamMotion ? F("on") : F("off"));
  Serial.print(F(" heading="));         Serial.print(g_orient.headingDeg(), 1);
  Serial.print(F(" elev="));            Serial.print(g_orient.elevationDeg(), 1);
  Serial.print(F(" zone="));            Serial.print(drumName(g_orient.zone(ZONES)));
  Serial.print(F(" zoneDeg="));         Serial.print(ZONES.leftDeg, 0); Serial.print('/'); Serial.print(ZONES.upDeg, 0);
  Serial.print(F(" axis=("));
  Serial.print(g_stickAxis.x, 2); Serial.print(',');
  Serial.print(g_stickAxis.y, 2); Serial.print(',');
  Serial.print(g_stickAxis.z, 2); Serial.print(')');
  Serial.print(F(" classifier="));      Serial.print(TINYML_ACTIVE ? F("tinyml") : F("rule"));
  if (g_ring.count > 0) {
    const Vec3& a = g_ring.at(g_ring.count - 1).acc;
    Serial.print(F(" acc=("));
    Serial.print(a.x, 3); Serial.print(',');
    Serial.print(a.y, 3); Serial.print(',');
    Serial.print(a.z, 3); Serial.print(F(")g"));
  }
  Serial.print(F(" cal="));
  Serial.print(g_calSteady ? F("ok") : F("흔들림"));
  Serial.print('(');
  Serial.print(g_calSpread, 1);
  Serial.print(F("°/s)"));
  Serial.print(F(" gyroBias=("));
  Serial.print(g_gyroBias.bias.x, 2); Serial.print(',');
  Serial.print(g_gyroBias.bias.y, 2); Serial.print(',');
  Serial.print(g_gyroBias.bias.z, 2); Serial.print(F(")°/s"));
  Serial.print(F(" still="));           Serial.print(g_gyroBias.isStill() ? F("yes") : F("no"));
  Serial.print(F(" biasUpdates="));     Serial.println(g_gyroBias.updates());
  Serial.print(F("[STATUS] gyroPeak="));   Serial.print(g_gyroPeakDps, 0);
  Serial.print(F("dps gyroSat="));         Serial.print(g_gyroSatCount);
  Serial.print(F(" sensorHz="));           Serial.print(g_imuType == IMU_LSM6DS ? 1.0f / g_odrPeriodS : 1e6f / FAST_PERIOD_US, 1);
  Serial.print(F(" maxGapMs="));           Serial.print(g_maxGapUs / 1000.0f, 1);
  Serial.print(F(" missed="));             Serial.println(g_missedSamples);
  g_gyroPeakDps = 0;
  g_gyroSatCount = 0;
  g_maxGapUs = 0;
  g_missedSamples = 0;
}

// [설명] 명령은 한 글자다. 시리얼 모니터에서 입력해도 되고, 웹이 BLE RX(6e400002)로 보내도 된다.
//   c : 정면 맞추기 — 지금 스틱 방향을 스네어(기준)로
//   m : 모션 스트림 켜기 (웹 화면의 실시간 방향 표시)   x : 끄기
//   k : 지휘 모드 (타격 대신 박을 보냄)   d : 드럼 모드 (기본)
//   a : 축 맞추기 — 스틱 끝을 천장으로 세운 채 보내면 스틱 축을 다시 잰다 (그다음 c)
//   1 · 2 · 3 : 드럼 간격 좁게(25°) · 보통(40°) · 넓게(55°)
//   ? : 상태 한 줄 출력 (시리얼)
static void handleCommand(int c) {
  switch (c) {
    case 'c': case 'C':
      g_orient.recenter();
      if (!DEBUG_RAW) Serial.println(F("[CMD] 정면 맞춤 — 지금 방향 = 스네어"));
      break;
    case 'm': case 'M': g_streamMotion = true;  break;
    case 'x': case 'X': g_streamMotion = false; break;
    case 'a': case 'A': calibrateAxis();        break;
    case 'k': case 'K': g_mode = MODE_CONDUCT; g_ictus.reset(); break;
    case 'd': case 'D': g_mode = MODE_DRUM;     break;
    case '1': case '2': case '3': {
      const float* z = ZONE_PRESETS[c - '1'];
      ZONES = { z[0], z[0], z[1] };
      if (!DEBUG_RAW) { Serial.print(F("[CMD] 드럼 간격 좌우 ")); Serial.print(z[0], 0); Serial.print(F("° 위 ")); Serial.print(z[1], 0); Serial.println('°'); }
      break;
    }
    case '?':           printStatus();          break;
    default: break;     // 줄바꿈 등은 무시
  }
}

static void pollCommands() {
  while (Serial.available() > 0) handleCommand(Serial.read());
  while (bleuart.available() > 0) handleCommand(bleuart.read());
}

#if ZONE_LOG_ENABLED
// 구역이 바뀌고 15샘플(0.15초) 동안 유지되면 한 줄 출력
static void logZoneChange(uint8_t zone) {
  if (zone == g_loggedZone) { g_pendingCount = 0; return; }
  if (zone != g_pendingZone) { g_pendingZone = zone; g_pendingCount = 0; }
  if (++g_pendingCount < 15) return;
  g_loggedZone = zone;
  Serial.print(F("[ZONE] "));
  Serial.print(drumName(zone));
  Serial.print(F("  heading="));
  Serial.print(g_orient.headingDeg(), 1);
  Serial.print(F(" elev="));
  Serial.println(g_orient.elevationDeg(), 1);
}
#endif

// 부팅 시 자이로 오차를 재고 중력으로 첫 자세를 맞춘다. setup()에서만 부르므로 delay()를 써도 된다.
// 1초 동안 어느 한 축이라도 (최대-최소)가 GYRO_CAL_MAX_SPREAD_DPS를 넘으면 움직였다고 보고 다시 잰다.
static void calibrateOrientation() {
  // 켠 직후 값 버리기: 2026-10-07 측정에서 부팅 직후 1초 창의 흔들림이 5~27°/s였고,
  // 몇 초 뒤에는 축마다 1°/s 미만이었다 (첫 샘플이 0으로 읽히는 등 시작 과도 현상)
  for (uint16_t i = 0; i < IMU_SETTLE_MS / (SAMPLE_PERIOD_US / 1000); i++) {
    ImuSample s;
    imuRead(s);
    delay(SAMPLE_PERIOD_US / 1000);
  }
  Vec3 meanG = { 0, 0, 0 }, meanA = { 0, 0, 1 };
  bool steady = false;
  for (uint8_t t = 0; t < GYRO_CAL_TRIES && !steady; t++) {
    Vec3 sg = { 0, 0, 0 }, sa = { 0, 0, 0 };
    float lo[3] = { 1e9f, 1e9f, 1e9f }, hi[3] = { -1e9f, -1e9f, -1e9f };   // 축별 최소·최대
    uint16_t n = 0;
    for (uint16_t i = 0; i < GYRO_CAL_SAMPLES; i++) {
      ImuSample s;
      delay(SAMPLE_PERIOD_US / 1000);
      if (!imuRead(s)) continue;
      sg.x += s.gyro.x; sg.y += s.gyro.y; sg.z += s.gyro.z;
      sa.x += s.acc.x;  sa.y += s.acc.y;  sa.z += s.acc.z;
      const float v[3] = { s.gyro.x, s.gyro.y, s.gyro.z };
      for (uint8_t k = 0; k < 3; k++) {
        if (v[k] < lo[k]) lo[k] = v[k];
        if (v[k] > hi[k]) hi[k] = v[k];
      }
      n++;
    }
    if (n == 0) continue;
    meanG = { sg.x / n, sg.y / n, sg.z / n };
    meanA = { sa.x / n, sa.y / n, sa.z / n };
    g_calSpread = 0.0f;
    for (uint8_t k = 0; k < 3; k++) {
      if (hi[k] - lo[k] > g_calSpread) g_calSpread = hi[k] - lo[k];
    }
    steady = g_calSpread < GYRO_CAL_MAX_SPREAD_DPS;
    if (!steady && !DEBUG_RAW) {
      Serial.print(F("[IMU] 보정 중 움직임 감지 (축별 흔들림 "));
      for (uint8_t k = 0; k < 3; k++) { Serial.print(hi[k] - lo[k], 1); Serial.print(k < 2 ? '/' : ' '); }
      Serial.println(F("°/s) — 다시 잽니다. 센서를 가만히 두세요"));
    }
  }
  g_gyroBias.seed(meanG, steady);
  g_orient.begin(g_stickAxis, ORIENT_KP, ACCEL_TRUST_G);
  g_orient.alignToGravity(meanA);
  g_orientReady = true;
  g_calSteady = steady;
  if (!DEBUG_RAW) {
    Serial.print(steady ? F("[IMU] 자이로 보정 완료 bias=(") : F("[IMU] 자이로 보정 불안정(움직임) — 가만히 두면 자동으로 맞춰짐 bias=("));
    Serial.print(meanG.x, 2); Serial.print(',');
    Serial.print(meanG.y, 2); Serial.print(',');
    Serial.print(meanG.z, 2); Serial.println(F(")°/s"));
    Serial.println(F("[ZONE] 지금 방향을 정면(스네어)으로 잡음. 다시 잡으려면 'c'"));
  }
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

    uint8_t cls = classifyHit(g_ring, g_m1Zone);
    uint8_t vel = magnitudeToVelocity(g_m1);
    if (cls == CLASS_NOISE) {
#if HIT_LOG_ENABLED
      Serial.print(F("NOISE t=")); Serial.print(g_m1Ms);
      Serial.print(F(" peak="));   Serial.print(g_m1, 2); Serial.println(F("g — 모델이 치지 않는 동작으로 판정, 안 보냄"));
#endif
      return;
    }

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
    Serial.print(cls);
    Serial.print(' ');
    Serial.print(drumName(cls));
    Serial.print(F(" heading="));
    Serial.print(g_orient.headingDeg(), 1);
    Serial.print(F(" elev="));
    Serial.println(g_orient.elevationDeg(), 1);
#endif
  }
}

// ============================================================================
// setup / loop
// ============================================================================
// [설명] setup() 순서
//   LED 끄기 → USB 시리얼 시작(최대 1.5초 대기) → I2C 시작 → I2C 스캔(연결된 장치 주소 출력)
//   → IMU 찾기(최대 3번, 없으면 버튼 전용 모드) → 자이로 보정 1초(가만히 둘 것) → 버튼 핀 설정
//   → 전송 큐 만들기 → BLE 시작 + 광고 → BLE 전송 태스크 시작
//   시리얼 모니터(115200 baud)를 열면 이 과정이 로그로 보인다.
void setup() {
  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, !LED_STATE_ON);

  Serial.begin(115200);
  // 시리얼 터미널 없이도 동작해야 하므로 연결을 무한정 기다리지 않는다 (최대 1.5초)
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) delay(10);

  bool recovered = i2cBusRecover();
  Wire.setPins(PIN_IMU_SDA, PIN_IMU_SCL);
  Wire.begin();
  Wire.setClock(I2C_CLOCK_HZ);

  if (!DEBUG_RAW) Serial.println(F("\n=== AirBand-R 2단계 (방향으로 드럼 고르기) ==="));
  if (recovered && !DEBUG_RAW) Serial.println(F("[I2C] 버스가 막혀 있어 풀었습니다 (SDA/SCL LOW → 클럭 9회 + STOP)"));
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

  if (g_imuType != IMU_NONE) {
    loadStickAxis();
    if (!DEBUG_RAW) Serial.println(F("[IMU] 자이로 보정 중 — 1초 동안 가만히 두세요"));
    calibrateOrientation();
  }

#if ENABLE_BUTTONS
  buttonsBegin();
  if (!DEBUG_RAW) Serial.println(F("[BTN] 버튼 1~4 → 드럼 0~3 (스네어/킥/하이햇/탐)"));
#endif

  g_hitQueue = xQueueCreate(HIT_QUEUE_LEN, sizeof(HitPacket));
  g_motionQueue = xQueueCreate(1, sizeof(HitPacket));
  bleBegin();
  Scheduler.startLoop(bleSendLoop);

  if (!DEBUG_RAW) {
    Serial.print(F("[BLE] 광고 시작: "));
    Serial.println(BLE_DEVICE_NAME);
    Serial.println(F("[CMD] a=축 맞추기(스틱 세우고)  c=정면 맞추기  m/x=모션 스트림 켜기/끄기  k/d=지휘/드럼  ?=상태"));
  }

  g_nextSampleUs = micros();
}

// ============================================================================
// 방향 적분 (센서 값마다)
// ============================================================================
// [설명] 타격은 수십 ms 동안 1000°/s 넘게 꺾였다 돌아온다. 이걸 띄엄띄엄(예전 100Hz) 재거나 값을 하나라도 빠뜨리면
//   "나갈 때 잰 회전 ≠ 돌아올 때 잰 회전"이 되어 칠 때마다 좌우 각도가 조금씩 틀어지고, 좌우는 바로잡을 기준(중력 같은 것)이 없어
//   계속 쌓인다 (2026-10-15 사용자 실기 "칠수록 각도가 안 맞음"). 그래서
//   - LSM6DS: STATUS_REG(0x1E)의 GDA 비트로 "새 자이로 값이 나왔나"를 1ms마다 보고, 나올 때마다 읽는다 (416Hz 전부)
//   - dt는 읽은 시각 차이가 아니라 센서 값 간격(약 2.4ms, 실제 간격을 재서 맞춤) × 지나간 값 개수 → 읽는 시각이 1ms씩 들쭉날쭉해도 정확
//   - 그 밖의 센서(MPU-6050, 내부 1kHz): 2.5ms 타이머로 읽고 실제 흐른 시간으로 적분
static bool imuFresh(uint32_t nowUs) {
  if (g_imuType == IMU_LSM6DS) {
    uint8_t st = 0;
    if (i2cReadRegs(g_imuAddr, 0x1E, &st, 1) && (st & 0x02)) return true;   // STATUS_REG bit1 = GDA(새 자이로 값)
    // 안전장치: 이 칩에서 GDA가 안 켜지면(레지스터가 다른 변종) 10ms마다라도 읽는다 — '?'의 sensorHz가 100 근처면 이 경우
    return !g_haveSample || (nowUs - g_lastReadUs) > 10000;
  }
  if ((int32_t)(nowUs - g_nextFastUs) < 0) return false;
  g_nextFastUs = nowUs + FAST_PERIOD_US;
  return true;
}

static void integrateSample(const ImuSample& s, uint32_t nowUs) {
  if (!g_haveSample) {
    g_lastReadUs = g_odrStartUs = nowUs;
    g_odrSamples = 0;
  }
  uint32_t gap = nowUs - g_lastReadUs;
  g_lastReadUs = nowUs;
  if (gap > g_maxGapUs) g_maxGapUs = gap;
  float dt;
  if (g_imuType == IMU_LSM6DS) {
    // 지나간 센서 값 개수 (보통 1, 밀렸으면 2 이상)
    float n = roundf(gap * 1e-6f / g_odrPeriodS);
    if (n < 1) n = 1;
    if (n > 8) n = 8;   // 오래 멈췄으면(20ms 넘게) 그 사이 회전은 알 수 없음 — 크게 튀지 않게만
    if (n > 1) g_missedSamples += (uint32_t)n - 1;
    dt = g_haveSample ? n * g_odrPeriodS : g_odrPeriodS;
    // 실제 센서 간격 재기: 2초마다 (흐른 시간 / 값 개수), 정상 범위(±10%)일 때만 천천히 반영
    g_odrSamples += (uint32_t)n;
    uint32_t span = nowUs - g_odrStartUs;
    if (span > 2000000UL) {
      float per = span * 1e-6f / g_odrSamples;
      if (fabsf(per * LSM_ODR_HZ - 1.0f) < 0.1f) g_odrPeriodS += 0.2f * (per - g_odrPeriodS);
      g_odrStartUs = nowUs;
      g_odrSamples = 0;
    }
  } else {
    dt = gap * 1e-6f;
    if (!g_haveSample || dt <= 0.0f || dt > 0.02f) dt = FAST_PERIOD_US * 1e-6f;
  }
  const Vec3& bz = g_gyroBias.bias;
  Vec3 gyro = { s.gyro.x - bz.x, s.gyro.y - bz.y, s.gyro.z - bz.z };
  g_orient.update(gyro, s.acc, dt);
  float gMax = fmaxf(fabsf(s.gyro.x), fmaxf(fabsf(s.gyro.y), fabsf(s.gyro.z)));
  if (gMax > g_gyroPeakDps) g_gyroPeakDps = gMax;
  if (gMax > GYRO_SAT_DPS) g_gyroSatCount++;
  // 타격 순간 가속도 최대값은 센서 값 전부에서 (모션 패킷 · TinyML 블록 최대값용)
  float mf = sqrtf(s.acc.x * s.acc.x + s.acc.y * s.acc.y + s.acc.z * s.acc.z);
  if (mf > g_blockMaxG) g_blockMaxG = mf;
  g_lastSample = s;
  g_haveSample = true;
}

// [설명] loop() 한 바퀴
//   1) 버튼 읽기 · 명령 읽기 — 매번 (약 1ms마다)
//   2) 아직 다음 샘플 시각(10ms 간격)이 안 됐으면 → LED 끌 시간인지 확인하고 1ms 쉬고 끝
//   3) 샘플 시각이 됐으면 → IMU 읽기 → 링버퍼에 저장 → 방향 갱신 → 크기 계산 → 피크 감지
//      → (켜져 있으면) 모션 패킷
//   IMU가 없으면(버튼 전용 모드) 3)의 imuRead()가 false라서 바로 끝난다.
//   delay(10) 대신 micros() 비교를 쓰는 이유: 처리 시간과 상관없이 정확히 10ms 간격을 지키려고.
void loop() {
#if ENABLE_BUTTONS
  pollButtons();
#endif
  pollCommands();
  uint32_t nowUs = micros();
  if (g_ledOffMs && (int32_t)(millis() - g_ledOffMs) >= 0) {
    digitalWrite(PIN_STATUS_LED, !LED_STATE_ON);
    g_ledOffMs = 0;
  }
  if (g_imuType == IMU_NONE) {   // 버튼 전용 모드
    delay(1);
    return;
  }

  // 1) 새 IMU 값이 나왔으면 바로 읽어 방향을 적분한다 (LSM6DS: 센서가 값을 낼 때마다 = 416Hz, 하나도 안 빠뜨리게)
  bool fresh = imuFresh(nowUs);
  if (fresh) {
    ImuSample s;
    if (imuRead(s)) integrateSample(s, nowUs);
  }
  // 2) 10ms마다 나머지(타격 감지 · 링버퍼 · 모션 패킷)는 가장 최근 값으로
  if (!g_haveSample || (int32_t)(nowUs - g_nextSampleUs) < 0) {
    if (!fresh) delay(1);   // CPU를 쉬게 하고 BLE 태스크에 양보 (센서 값 간격 2.4ms보다 짧다)
    return;
  }
  g_nextSampleUs += SAMPLE_PERIOD_US;
  // 처리가 한 주기 이상 밀렸으면 누적 지연을 버리고 다시 맞춘다
  if ((int32_t)(nowUs - g_nextSampleUs) > (int32_t)SAMPLE_PERIOD_US) {
    g_nextSampleUs = nowUs + SAMPLE_PERIOD_US;
  }
  const ImuSample& s = g_lastSample;

  // ---- 여기부터 100Hz ----
  uint32_t nowMs = millis();
  g_ring.push(s, nowMs);
  g_gyroBias.correct(s.gyro, s.acc);   // 정지 판정 · bias 갱신은 예전처럼 100Hz 묶음(0.5초)으로
  uint8_t zone = g_orient.zone(ZONES);
  float m0 = sqrtf(s.acc.x * s.acc.x + s.acc.y * s.acc.y + s.acc.z * s.acc.z);

  // 25Hz 블록: 모델 입력과 모션 패킷이 같은 값(방향 + 블록 최대 가속도)을 쓴다 → 웹에서 모은 학습 데이터 = 보드 입력
  if (m0 > g_blockMaxG) g_blockMaxG = m0;
  if (++g_blockDiv >= SAMPLE_RATE_HZ / MOTION_STREAM_HZ) {
    g_blockDiv = 0;
#if TINYML_ACTIVE
    g_featH[g_featHead] = g_orient.headingDeg();
    g_featE[g_featHead] = g_orient.elevationDeg();
    g_featG[g_featHead] = g_blockMaxG;
    g_featHead = (g_featHead + 1) % ZONE_MODEL_WINDOW;
    if (g_featCount < ZONE_MODEL_WINDOW) g_featCount++;
#endif
    if (g_streamMotion) queueMotion(zone, g_blockMaxG);
    g_blockMaxG = 0.0f;
  }

#if DEBUG_RAW
  // Edge Impulse Data Forwarder 형식: 한 줄에 "ax,ay,az,gx,gy,gz" (g, °/s)
  Serial.print(s.acc.x, 4);  Serial.print(',');
  Serial.print(s.acc.y, 4);  Serial.print(',');
  Serial.print(s.acc.z, 4);  Serial.print(',');
  Serial.print(s.gyro.x, 2); Serial.print(',');
  Serial.print(s.gyro.y, 2); Serial.print(',');
  Serial.println(s.gyro.z, 2);
#endif

  if (g_mode == MODE_CONDUCT) {
    // 지휘 모드: 타격 대신 박. 타격 피크 상태는 계속 갱신만 해 둔다(드럼으로 돌아갈 때 튀지 않게)
    airband::Ictus b;
    Vec3 gb = g_orient.gravityBody();
    float lx = s.acc.x - gb.x, ly = s.acc.y - gb.y, lz = s.acc.z - gb.z;
    float lin = sqrtf(lx * lx + ly * ly + lz * lz);   // 움직임 가속도 (중력 뺀 값, g)
    if (g_ictus.update(nowMs, g_orient.elevationDeg(), g_orient.headingDeg(), lin, b)) {
      long v = lroundf(b.size * 2.0f);
      HitPacket p;
      buildPacket(p, 0, (uint8_t)(v < 1 ? 1 : v > 127 ? 127 : v), b.ms, MODE_CONDUCT);
      xQueueSend(g_hitQueue, &p, 0);
#if HIT_LOG_ENABLED
      Serial.print(F("BEAT t=")); Serial.print(b.ms); Serial.print(F(" size=")); Serial.println(b.size, 1);
#endif
    }
  } else {
    detectHit(m0);
  }

  g_m2 = g_m1;
  g_m1 = m0;
  g_m1Ms = nowMs;
  g_m1Zone = zone;

#if ZONE_LOG_ENABLED
  logZoneChange(zone);
#endif

}
