#pragma once
#include "primitives.h"
namespace osfs_audio {
class TireVoice {
 public:
  void configure(double sampleRate, uint32_t seed) {
    sampleRate_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    rng_.seed(seed);
    noiseGain_.configure(sampleRate_, 0.010);
    squealGain_.configure(sampleRate_, 0.010);
    filterHz_.configure(sampleRate_, 0.015);
    squealHz_.configure(sampleRate_, 0.015);
    reset();
  }
  void reset() {
    band_.reset();
    squeal_.reset(0.0);
    noiseGain_.reset(0.0);
    squealGain_.reset(0.0);
    filterHz_.reset(1100.0);
    squealHz_.reset(1450.0);
  }

  double process(double slipPowerWatts) {
    const double power = std::fmax(0.0, sanitize(slipPowerWatts));
    const double intensity = power <= 2.0 ? 0.0 : std::fmin(1.0, std::sqrt(power / 15000.0));
    const double gain = noiseGain_.process(0.075 * intensity);
    const double squealLevel = squealGain_.process(0.012 * intensity * intensity);
    band_.bandpass(sampleRate_, filterHz_.process(1100.0 + 900.0 * intensity), 0.8);
    const double noise = band_.process(rng_.uniform()) * gain;
    const double tone = squeal_.process(sampleRate_, squealHz_.process(1450.0 + 550.0 * intensity))
        * squealLevel;
    return sanitize(noise + tone);
  }

 private:
  double sampleRate_ = 48000.0;
  Rng rng_;
  Biquad band_;
  Oscillator squeal_;
  Smoother noiseGain_, squealGain_, filterHz_, squealHz_;
};


}
