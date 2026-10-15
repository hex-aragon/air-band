// 스틱 방향 추정 + 드럼 구역 판정 (2단계)
//
// 아두이노 API를 쓰지 않는 순수 계산 코드라서 PC에서도 그대로 컴파일해 시험할 수 있다.
//
// [한눈에 보기]
//   자이로(회전 속도)를 시간에 따라 더하면 스틱이 "얼마나 돌았는지"를 알 수 있다.
//   하지만 자이로에는 작은 오차(bias)가 있어서 그냥 더하면 방향이 조금씩 흘러간다(drift).
//   그래서 가만히 있을 때 읽히는 중력(가속도)으로 위/아래 기울기를 계속 바로잡는다 → Mahony 필터.
//   좌우 방향(heading)은 중력으로 바로잡을 수 없으므로, 가만히 있을 때 자이로 오차를 다시 재고(GyroBias),
//   "정면 맞추기"(recenter)로 기준을 다시 잡는다.
//
//   타격 순간 스틱이 가리키는 방향으로 드럼을 고른다.
//
//          (위로 든 상태 → 크래시)
//      하이햇   |   스네어   |   탐
//     ←왼쪽 ─────── 정면 ─────── 오른쪽→
//
// [설명] 좌표계
//   센서 좌표계(body): 칩에 인쇄된 X/Y/Z 축. 스틱에 어떻게 붙였는지에 따라 스틱 방향이 달라진다
//                      → STICK_AXIS(.ino)로 "어느 축이 스틱 끝을 가리키는지" 정한다.
//   세계 좌표계(world): Z가 하늘(위) 방향. X/Y는 켤 때(또는 정면 맞추기 때) 방향 기준.
//   쿼터니언 q : 센서 좌표 → 세계 좌표 회전을 나타내는 숫자 4개. 각도 3개보다 계산이 안정적이다.
#pragma once

#include <math.h>
#include <stdint.h>

namespace airband {

struct Vec3 {
  float x, y, z;
};

// 드럼 클래스 번호 — 패킷 class 칸, 웹 audio.ts의 DRUM_CLASSES와 같아야 한다
enum DrumClass : uint8_t {
  DRUM_SNARE = 0,
  DRUM_KICK  = 1,   // 발 동작이라 스틱 구역에는 없음 (버튼 2 / 화면 패드)
  DRUM_HIHAT = 2,
  DRUM_TOM   = 3,
  DRUM_CRASH = 4,
};

// 구역 경계 (단위: 도). 기준 방향(정면 맞추기 한 자세)에서 얼마나 벗어났는지로 판정한다.
struct ZoneConfig {
  float leftDeg;    // 이 각도 이상 왼쪽 → 하이햇
  float rightDeg;   // 이 각도 이상 오른쪽 → 탐
  float upDeg;      // 기준보다 이 각도 이상 위 → 크래시 (좌우와 상관없이)
};

static const float DEG = 57.2957795f;   // 라디안 → 도

static inline float wrap180(float d) {
  while (d > 180.0f) d -= 360.0f;
  while (d < -180.0f) d += 360.0f;
  return d;
}

// ---------------------------------------------------------------------------
// 자이로 오차(bias) 추정
// ---------------------------------------------------------------------------
// [설명] 가만히 있는데도 자이로가 0이 아닌 값(예: 0.5°/s)을 읽는 것이 bias다.
//   1초에 0.5°면 1분에 30° 흘러간다. 부팅 때 한 번 재고(seed), 그 뒤에도 가만히 있는 순간마다
//   아주 천천히 따라가게(track) 해서 온도 변화 등으로 바뀌는 오차를 줄인다.
// [주의] "가만히 있나"는 bias를 뺀 값이 아니라 원본 자이로가 **흔들리지 않는지**(0.5초 동안 최대-최소)로 본다.
//   예전에는 "bias를 뺀 회전 < 3°/s"로 봤는데, 부팅 때 움직여서 bias가 크게 틀리면(2026-10-14 실측 -14°/s)
//   가만히 둬도 그 조건을 영영 못 넘어 bias가 고쳐지지 않았다 → 좌우 각도가 계속 흘러감(1.4°/s).
//   천천히 일정하게 도는 동작을 bias로 착각하지 않도록, 지금 bias와 MAX_JUMP_DPS 넘게 다르면 받아들이지 않는다.
class GyroBias {
 public:
  Vec3 bias = { 0, 0, 0 };

  // trusted=false: 부팅 보정 중 움직여서 b를 믿을 수 없음 → 처음 정지할 때는 MAX_JUMP_DPS 제한 없이 바로 맞춘다
  void seed(const Vec3& b, bool trusted = true) {
    bias = b;
    trusted_ = trusted;
  }

  // raw: 자이로 원본(°/s), acc: 가속도(g). bias를 빼서 돌려주고, 정지 상태면 bias를 갱신한다.
  Vec3 correct(const Vec3& raw, const Vec3& acc) {
    float an = sqrtf(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
    const float v[3] = { raw.x, raw.y, raw.z };
    if (n_ == 0) {
      for (uint8_t k = 0; k < 3; k++) { lo_[k] = hi_[k] = v[k]; sum_[k] = 0; }
      aLo_ = aHi_ = an;
    }
    for (uint8_t k = 0; k < 3; k++) {
      sum_[k] += v[k];
      if (v[k] < lo_[k]) lo_[k] = v[k];
      if (v[k] > hi_[k]) hi_[k] = v[k];
    }
    if (an < aLo_) aLo_ = an;
    if (an > aHi_) aHi_ = an;
    if (++n_ >= WINDOW) finishWindow();
    return { raw.x - bias.x, raw.y - bias.y, raw.z - bias.z };
  }

  bool isStill() const { return stillWindows_ >= STILL_WINDOWS; }
  // 정지 판정으로 bias를 몇 번 고쳤는지 ('?' 상태 표시용)
  uint32_t updates() const { return updates_; }

 private:
  void finishWindow() {
    float mean[3], spread = 0;
    for (uint8_t k = 0; k < 3; k++) {
      mean[k] = sum_[k] / n_;
      if (hi_[k] - lo_[k] > spread) spread = hi_[k] - lo_[k];
    }
    float dx = mean[0] - bias.x, dy = mean[1] - bias.y, dz = mean[2] - bias.z;
    float jump = sqrtf(dx * dx + dy * dy + dz * dz);
    bool still = spread < STILL_SPREAD_DPS && (aHi_ - aLo_) < STILL_ACC_SPREAD_G && (jump < MAX_JUMP_DPS || !trusted_);
    stillWindows_ = still ? (stillWindows_ < 1000 ? stillWindows_ + 1 : stillWindows_) : 0;
    if (stillWindows_ >= STILL_WINDOWS) {
      float a = trusted_ ? TRACK_ALPHA : 1.0f;   // 못 믿는 값이면 한 번에 바꾼다
      bias.x += a * dx;
      bias.y += a * dy;
      bias.z += a * dz;
      trusted_ = true;
      updates_++;
    }
    n_ = 0;
  }

  static constexpr uint8_t  WINDOW            = 50;     // 0.5초(100Hz) 묶음으로 본다
  static constexpr float    STILL_SPREAD_DPS  = 10.0f;  // 묶음 안 축별 (최대-최소)가 이보다 작고 (정지 시 1~7, 손에 들고 흔들면 수십)
  static constexpr float    STILL_ACC_SPREAD_G = 0.06f; // |가속도|도 거의 안 변하고
  static constexpr float    MAX_JUMP_DPS      = 30.0f;  // 지금 bias와 이보다 많이 다르면 "천천히 도는 중"으로 보고 무시
  static constexpr uint16_t STILL_WINDOWS     = 2;      // 이런 묶음이 연속 2개(1초)면 "정지"
  static constexpr float    TRACK_ALPHA       = 0.3f;   // 정지 묶음마다 차이의 30%씩 따라감 (약 1.5초면 거의 맞음)
  uint8_t  n_ = 0;
  float    sum_[3] = { 0, 0, 0 }, lo_[3] = { 0, 0, 0 }, hi_[3] = { 0, 0, 0 };
  float    aLo_ = 0, aHi_ = 0;
  uint16_t stillWindows_ = 0;
  uint32_t updates_ = 0;
  bool     trusted_ = true;
};

// ---------------------------------------------------------------------------
// 스틱 방향 (Mahony 상보 필터)
// ---------------------------------------------------------------------------
class StickOrientation {
 public:
  // stickAxis: 센서 좌표계에서 스틱 끝을 가리키는 단위벡터 (예: +X → {1,0,0})
  // kp       : 중력으로 기울기를 바로잡는 세기. 크면 빨리 맞추지만 흔들림에 민감
  // trustG   : |가속도|가 1g에서 이만큼 이상 벗어나면(휘두르는 중·타격 충격) 중력 보정을 쉰다
  void begin(const Vec3& stickAxis, float kp, float trustG) {
    axis_ = stickAxis;
    kp_ = kp;
    trustG_ = trustG;
  }

  // 스틱 끝 축을 바꾼다 (축 보정 'a'). 좌우 기준은 새 축으로 다시 잡아야 하므로 recenter()도 부른다.
  void setAxis(const Vec3& stickAxis) {
    axis_ = stickAxis;
    computeDirection();
    recenter();
  }

  // 정지 상태 가속도로 초기 기울기를 바로 맞춘다 (좌우 방향은 0으로 시작). 부팅 때 한 번.
  void alignToGravity(const Vec3& a) {
    float roll  = atan2f(a.y, a.z);
    float pitch = atan2f(-a.x, sqrtf(a.y * a.y + a.z * a.z));
    float cr = cosf(roll * 0.5f), sr = sinf(roll * 0.5f);
    float cp = cosf(pitch * 0.5f), sp = sinf(pitch * 0.5f);
    q0_ = cr * cp;
    q1_ = sr * cp;
    q2_ = cr * sp;
    q3_ = -sr * sp;
    computeDirection();
    recenter();
  }

  // gyroDps: bias를 뺀 자이로(°/s), accG: 가속도(g), dt: 샘플 간격(초)
  void update(const Vec3& gyroDps, const Vec3& accG, float dt) {
    float gx = gyroDps.x / DEG, gy = gyroDps.y / DEG, gz = gyroDps.z / DEG;   // rad/s

    // [설명] 중력 보정: 지금 자세라면 중력이 센서에서 어느 방향으로 보여야 하는지(v)와
    //   실제 가속도 방향(a)의 차이(외적 e)만큼 회전 속도를 살짝 더해 기울기를 끌어당긴다.
    float an = sqrtf(accG.x * accG.x + accG.y * accG.y + accG.z * accG.z);
    if (an > 1e-3f && fabsf(an - 1.0f) < trustG_) {
      float ax = accG.x / an, ay = accG.y / an, az = accG.z / an;
      float vx = 2.0f * (q1_ * q3_ - q0_ * q2_);
      float vy = 2.0f * (q0_ * q1_ + q2_ * q3_);
      float vz = q0_ * q0_ - q1_ * q1_ - q2_ * q2_ + q3_ * q3_;
      float ex = ay * vz - az * vy;
      float ey = az * vx - ax * vz;
      float ez = ax * vy - ay * vx;
      gx += kp_ * ex;
      gy += kp_ * ey;
      gz += kp_ * ez;
    }

    // 쿼터니언 적분: 이번 dt 동안 ω 축으로 |ω|·dt 만큼 돈 회전을 정확히 곱한다 (q ← q ⊗ Δq).
    // [설명] 예전 1차 근사(q += ½ q ⊗ ω · dt)는 한 번에 몇 도씩 도는 빠른 스윙(2000°/s × 2.5ms = 5°)에서 조금씩 틀리고,
    //   그 오차가 타격마다 쌓였다. 정확한 회전은 sin/cos 두 번이면 된다.
    float wn = sqrtf(gx * gx + gy * gy + gz * gz);
    float th = 0.5f * wn * dt;
    float c = cosf(th);
    float k = wn > 1e-9f ? sinf(th) / wn : 0.5f * dt;
    float b1 = gx * k, b2 = gy * k, b3 = gz * k;
    float a0 = q0_, a1 = q1_, a2 = q2_, a3 = q3_;
    q0_ = a0 * c - a1 * b1 - a2 * b2 - a3 * b3;
    q1_ = a0 * b1 + a1 * c + a2 * b3 - a3 * b2;
    q2_ = a0 * b2 - a1 * b3 + a2 * c + a3 * b1;
    q3_ = a0 * b3 + a1 * b2 - a2 * b1 + a3 * c;
    float n = sqrtf(q0_ * q0_ + q1_ * q1_ + q2_ * q2_ + q3_ * q3_);
    q0_ /= n; q1_ /= n; q2_ /= n; q3_ /= n;

    computeDirection();
  }

  // 지금 자세에서 중력이 센서 좌표로 어느 방향인지 (단위 g). 가속도 - 이것 = 움직임 때문에 생긴 가속도
  Vec3 gravityBody() const {
    return { 2.0f * (q1_ * q3_ - q0_ * q2_), 2.0f * (q0_ * q1_ + q2_ * q3_), q0_ * q0_ - q1_ * q1_ - q2_ * q2_ + q3_ * q3_ };
  }

  // 지금 스틱 방향을 기준(정면 · 스네어 자리)으로 삼는다
  void recenter() {
    headingRef_ = headingAbs_;
    elevRef_ = elevAbs_;
  }

  // 기준 대비 좌우 각도. + = 왼쪽, - = 오른쪽 (위에서 볼 때 반시계가 +)
  float headingDeg() const { return wrap180(headingAbs_ - headingRef_); }
  // 기준 대비 위아래 각도. + = 위
  float elevationDeg() const { return elevAbs_ - elevRef_; }

  // 현재 방향이 어느 드럼 구역인지
  uint8_t zone(const ZoneConfig& z) const {
    float h = headingDeg();
    float e = elevationDeg();
    if (e >= z.upDeg) return DRUM_CRASH;
    if (h >= z.leftDeg) return DRUM_HIHAT;
    if (h <= -z.rightDeg) return DRUM_TOM;
    return DRUM_SNARE;
  }

 private:
  // 스틱 끝 방향을 세계 좌표로 돌려서 좌우(heading)·위아래(elevation) 각도를 구한다
  void computeDirection() {
    const Vec3& s = axis_;
    float dx = (1 - 2 * (q2_ * q2_ + q3_ * q3_)) * s.x + 2 * (q1_ * q2_ - q0_ * q3_) * s.y + 2 * (q1_ * q3_ + q0_ * q2_) * s.z;
    float dy = 2 * (q1_ * q2_ + q0_ * q3_) * s.x + (1 - 2 * (q1_ * q1_ + q3_ * q3_)) * s.y + 2 * (q2_ * q3_ - q0_ * q1_) * s.z;
    float dz = 2 * (q1_ * q3_ - q0_ * q2_) * s.x + 2 * (q2_ * q3_ + q0_ * q1_) * s.y + (1 - 2 * (q1_ * q1_ + q2_ * q2_)) * s.z;
    if (dz > 1.0f) dz = 1.0f;
    if (dz < -1.0f) dz = -1.0f;
    elevAbs_ = asinf(dz) * DEG;
    // 스틱이 거의 수직이면 좌우 방향이 정의되지 않으므로 이전 값을 유지한다
    if (fabsf(dz) < 0.97f) headingAbs_ = atan2f(dy, dx) * DEG;
  }

  Vec3  axis_ = { 1, 0, 0 };
  float kp_ = 1.0f, trustG_ = 0.25f;
  float q0_ = 1, q1_ = 0, q2_ = 0, q3_ = 0;
  float headingAbs_ = 0, elevAbs_ = 0;
  float headingRef_ = 0, elevRef_ = 0;
};

}  // namespace airband
