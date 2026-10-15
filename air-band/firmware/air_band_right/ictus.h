// 지휘 모드: 박(ictus) 감지 — 웹 src/conduct/ictus.ts와 같은 규칙 (폰 단독 모드가 그쪽을 쓴다)
//
// 아두이노 API를 쓰지 않는 순수 계산 코드.
//
// [한눈에 보기] 두 가지 신호 중 하나만 잡혀도 박이다 (초보자도 쉽게 잡히도록)
//   ① 위아래: 지휘봉 끝의 위아래 각도가 내려가다(< -downDps) 위로 돌아서는 바닥점. 꼭대기 → 바닥이 minDropDeg 이상
//   ② 툭 멈춤: 박을 찍는 순간 손목이 멈췄다 튀어 오르며 생기는 순간 가속도(중력 뺀 값)의 봉우리가 minAccG 이상
//      → 센서를 어느 방향으로 붙였든(축 맞추기를 안 했어도) 잡힌다
//   두 신호가 같은 박을 거의 동시에 잡으므로, 박 사이 최소 간격(minGapMs) 안의 두 번째는 버린다.
//   박 크기(셈여림) = 위아래 폭 · 좌우 폭 · 가속도×40 중 가장 큰 것 (도).
#pragma once

#include <stdint.h>

namespace airband {

struct IctusConfig {
  float downDps;     // 이보다 빠르게 내려가야 "내려치는 중" (°/s)
  float minDropDeg;  // 꼭대기 → 바닥이 이보다 작으면 손 떨림으로 보고 무시
  float minAccG;     // 툭 멈춤: 움직임 가속도 봉우리가 이 이상이면 박 (g)
  uint32_t minGapMs; // 박 사이 최소 간격 (270 BPM = 220ms)
  float velAlpha;    // 각도 · 속도 평활 계수 (0~1, 클수록 빠르게 반응 · 덜 매끄러움)
};

static const IctusConfig ICTUS_DEFAULT = { 12.0f, 2.5f, 0.22f, 220, 0.35f };

struct Ictus {
  uint32_t ms;     // 박 시각
  float    size;   // 박 크기 (도)
};

class IctusDetector {
 public:
  explicit IctusDetector(const IctusConfig& c = ICTUS_DEFAULT) : cfg_(c) {}

  void reset() { started_ = false; }

  // 새 샘플. linAccG = 움직임 가속도 크기(중력 뺀 값, g). 박이 감지되면 true와 out을 채운다.
  bool update(uint32_t ms, float elevDeg, float headingDeg, float linAccG, Ictus& out) {
    if (!started_) {
      started_ = true;
      prevMs_ = ms; prevE_ = elevDeg; vel_ = 0; descending_ = false;
      a1_ = a2_ = 0; a1Ms_ = ms;
      resetRange(ms, elevDeg, headingDeg);
      lastBeatMs_ = ms - cfg_.minGapMs;
      return false;
    }
    float dt = (ms - prevMs_) * 0.001f;
    if (dt <= 0.0f) return false;
    // 손 떨림을 줄이려고 각도 자체도 평활한 값으로 속도 · 꼭대기 · 바닥을 잰다
    float e = prevE_ + cfg_.velAlpha * (elevDeg - prevE_);
    vel_ += cfg_.velAlpha * ((e - prevE_) / dt - vel_);
    prevMs_ = ms; prevE_ = e;

    if (e > maxE_) maxE_ = e;
    if (e < minE_) { minE_ = e; minMs_ = ms; }
    if (headingDeg > maxH_) maxH_ = headingDeg;
    if (headingDeg < minH_) minH_ = headingDeg;
    if (linAccG > maxA_) maxA_ = linAccG;

    bool beat = false;
    uint32_t at = ms;

    // ② 툭 멈춤: 가속도 봉우리 (직전 값이 앞뒤보다 크고 기준 이상)
    float a0 = a1_ + 0.5f * (linAccG - a1_);   // 살짝 평활
    if (a1_ >= cfg_.minAccG && a1_ > a2_ && a1_ >= a0) { beat = true; at = a1Ms_; }
    a2_ = a1_; a1_ = a0; a1Ms_ = ms;

    // ① 위아래: 내려가다 위로 돌아선 바닥점
    if (vel_ < -cfg_.downDps) descending_ = true;
    if (descending_ && vel_ > 0.0f) {
      descending_ = false;
      if (maxE_ - minE_ >= cfg_.minDropDeg && !beat) { beat = true; at = minMs_; }
    }

    if (!beat || at - lastBeatMs_ < cfg_.minGapMs) return false;
    float drop = maxE_ - minE_, sweep = maxH_ - minH_, acc = maxA_ * 40.0f;
    float size = drop > sweep ? drop : sweep;
    out.ms = at;
    out.size = size > acc ? size : acc;
    lastBeatMs_ = at;
    descending_ = false;
    resetRange(ms, e, headingDeg);
    return true;
  }

 private:
  void resetRange(uint32_t ms, float e, float h) {
    maxE_ = minE_ = e; minMs_ = ms;
    maxH_ = minH_ = h;
    maxA_ = 0;
  }

  IctusConfig cfg_;
  bool     started_ = false, descending_ = false;
  uint32_t prevMs_ = 0, minMs_ = 0, lastBeatMs_ = 0, a1Ms_ = 0;
  float    prevE_ = 0, vel_ = 0, a1_ = 0, a2_ = 0;
  float    maxE_ = 0, minE_ = 0, maxH_ = 0, minH_ = 0, maxA_ = 0;
};

}  // namespace airband
