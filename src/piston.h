// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the 0sfs authors.
#pragma once

#include "acoustic_profile.h"
#include "turbofan.h"

namespace osfs_audio {

struct PistonInput {
  double engineRpm = 0.0;
  double propellerRpm = 0.0;
  double powerHp = 0.0;
  double combustion = 0.0;
  double kias = 0.0, gear = 0.0, flap = 0.0;
};

/** Original periodic firing/propeller synthesis, not a recording or a turbine
 * voice. Frequencies follow the two native shafts. Four-stroke firing events
 * occur cylinders/2 times per crank revolution; blade passage follows the
 * independently observed propeller RPM. Harmonic weights and noise are an
 * explicit artistic approximation, not a calibrated IO320 spectrum. */
class PistonVoice {
 public:
  void configure(double sampleRate, uint32_t seed) {
    sampleRate_ = sampleRate;
    exhaustRng_.seed(seed ^ 0x70697374u);
    propRng_.seed(seed ^ 0x70726f70u);
    windRng_.seed(seed ^ 0x77696e64u);
    configRng_.seed(seed ^ 0x636f6e66u);
    reset();
  }
  void reset() {
    for (int i = 0; i < kMaxPartials; ++i) oscillators_[i].reset(0.0);
    exhaust_.reset(); propWash_.reset(); wind_.reset(); config_.reset();
  }
  void setCaps(const EngineCaps& caps) { caps_ = caps; }
  bool setProfile(const double* values) {
    if (!profile_.set(values) || profile_.at(kProfileVoiceKind) != 1.0) return false;
    reset();
    return true;
  }
  double cockpitGain() const { return profile_.at(kProfilePistonCockpitGain); }
  double cockpitHz() const { return profile_.at(kProfilePistonCockpitHz); }

  double process(const PistonInput& in, double cullScale, double* airframeOut) {
    const double crankHz = clamp(in.engineRpm, 0.0, 10000.0) / 60.0;
    const double propHz = clamp(in.propellerRpm, 0.0, 10000.0) / 60.0;
    const double rpm = clamp01(in.engineRpm / profile_.at(kProfileRatedRpm));
    const double prop = clamp01(in.propellerRpm / profile_.at(kProfileRatedRpm));
    const double power = clamp01(in.powerHp / profile_.at(kProfileRatedPowerHp));
    const double burning = clamp01(in.combustion);
    const double firingHz = crankHz * profile_.at(kProfileCylinders) * 2.0 / profile_.at(kProfileStrokeCycle);
    const double bladeHz = propHz * profile_.at(kProfilePropellerBlades);
    const double firingEnvelope = burning * clamp01(in.engineRpm / 400.0) * (0.24 + 0.76 * std::sqrt(power));
    const double propEnvelope = prop * prop * (0.30 + 0.70 * std::sqrt(power));
    double firing = 0.0, propeller = 0.0, mechanical = 0.0, firingPulse = 0.0;
    const int active = caps_.partials < kMaxPartials ? caps_.partials : kMaxPartials;
    // First four preserve the firing fundamental, blade passage, crankshaft
    // mechanical tone and the second firing harmonic even on Low.
    struct PistonPartial { int source; double order; double gain; };
    static const PistonPartial partials[kMaxPartials] = {
      {0, 1, 1}, {1, 1, 1}, {2, 1, 1}, {0, 2, 0.42},
      {1, 2, 0.32}, {0, 3, 0.25}, {1, 3, 0.16}, {0, 4, 0.18},
      {1, 4, 0.10}, {0, 5, 0.13}, {1, 5, 0.07}, {0, 6, 0.11},
    };
    for (int i = 0; i < active; ++i) {
      const int source = partials[i].source;
      const double order = partials[i].order;
      const double frequency = (source == 0 ? firingHz : source == 1 ? bladeHz : crankHz) * order;
      const double value = oscillators_[i].process(sampleRate_, frequency, cullScale);
      const double weight = partials[i].gain;
      if (source == 0) { firing += value * weight; if (i == 0) firingPulse = value; }
      else if (source == 1) propeller += value * weight;
      else mechanical += value;
    }
    double source = firing * profile_.at(kProfileFiringGain) * firingEnvelope
        + propeller * profile_.at(kProfilePropellerGain) * propEnvelope
        + mechanical * profile_.at(kProfileMechanicalGain) * rpm;
    if (caps_.noiseBands >= 1) {
      const double exhaust = exhaust_.process(exhaustRng_.uniform(), sampleRate_, 220.0 + 1300.0 * power);
      source += exhaust * (0.55 + 0.45 * firingPulse) * profile_.at(kProfileExhaustNoiseGain) * firingEnvelope;
    }
    if (caps_.noiseBands >= 2) {
      source += propWash_.process(propRng_.uniform(), sampleRate_, 400.0 + 1400.0 * prop)
          * profile_.at(kProfilePropellerNoiseGain) * propEnvelope;
    }
    const double speed = clamp01(in.kias / 180.0);
    double airframe = 0.0;
    if (caps_.noiseBands >= 3) {
      airframe = wind_.process(windRng_.uniform(), sampleRate_, 350.0 + 1400.0 * speed) * 0.12 * speed * speed;
    }
    if (caps_.noiseBands >= 4) {
      airframe += config_.process(configRng_.uniform(), sampleRate_, 220.0)
          * (0.3 * clamp01(in.gear) + 0.2 * clamp01(in.flap)) * speed * speed * 0.5;
    }
    if (airframeOut) *airframeOut = sanitize(airframe);
    return sanitize(source) * profile_.at(kProfilePistonOutputGain);
  }

 private:
  double sampleRate_ = 48000.0;
  AcousticProfile profile_;
  EngineCaps caps_;
  Oscillator oscillators_[kMaxPartials];
  Rng exhaustRng_, propRng_, windRng_, configRng_;
  OnePoleLowpass exhaust_, propWash_, wind_, config_;
};

}  // namespace osfs_audio
