// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the 0sfs authors.
//
// ABI shared with ../audioSnapshot.ts. The field order below IS the wire
// format; audioSnapshot.test.ts parses this file and fails when the two drift.
#pragma once

namespace osfs_audio {

constexpr int kSnapshotVersion = 6;

// AUDIO_SNAPSHOT_FIELDS
enum SnapshotSlot {
  kVersion = 0,
  kSequence,
  kEpoch,
  kSimTimeS,
  kAvailability,

  kN1Pct,
  kN2Pct,
  kThrustLbf,
  kFuelFlowPps,
  kThrottleNorm,
  kCombustion,
  kRunning,
  kStarter,
  kCutoff,

  kKias,
  kGearNorm,
  kFlapNorm,

  kSourceX, kSourceY, kSourceZ,
  kSourceVelX, kSourceVelY, kSourceVelZ,
  kListenerVelX, kListenerVelY, kListenerVelZ,
  kSoundSpeedMps,
  kExterior,
  kGroundReflectionM,
  kAugmentation,
  kSourceAxisX, kSourceAxisY, kSourceAxisZ,
  kAfterburnerBurnedFuelFlowKgSec,
  kEngineRpm, kPropellerRpm, kShaftPowerHp,

  kElectricSourceCount, kAirDensityKgM3, kAirVelocityX, kAirVelocityY, kAirVelocityZ, kArmed,
  kRotor0Rpm, kRotor0ThrustN, kRotor0TorqueNm, kRotor0InducedVelocityMps, kRotor0Vrs, kRotor0Valid, kRotor0SourceX, kRotor0SourceY, kRotor0SourceZ, kRotor0SourceVelX, kRotor0SourceVelY, kRotor0SourceVelZ, kRotor0AxisX, kRotor0AxisY, kRotor0AxisZ, kRotor0GroundReflectionM,
  kRotor1Rpm, kRotor1ThrustN, kRotor1TorqueNm, kRotor1InducedVelocityMps, kRotor1Vrs, kRotor1Valid, kRotor1SourceX, kRotor1SourceY, kRotor1SourceZ, kRotor1SourceVelX, kRotor1SourceVelY, kRotor1SourceVelZ, kRotor1AxisX, kRotor1AxisY, kRotor1AxisZ, kRotor1GroundReflectionM,
  kRotor2Rpm, kRotor2ThrustN, kRotor2TorqueNm, kRotor2InducedVelocityMps, kRotor2Vrs, kRotor2Valid, kRotor2SourceX, kRotor2SourceY, kRotor2SourceZ, kRotor2SourceVelX, kRotor2SourceVelY, kRotor2SourceVelZ, kRotor2AxisX, kRotor2AxisY, kRotor2AxisZ, kRotor2GroundReflectionM,
  kRotor3Rpm, kRotor3ThrustN, kRotor3TorqueNm, kRotor3InducedVelocityMps, kRotor3Vrs, kRotor3Valid, kRotor3SourceX, kRotor3SourceY, kRotor3SourceZ, kRotor3SourceVelX, kRotor3SourceVelY, kRotor3SourceVelZ, kRotor3AxisX, kRotor3AxisY, kRotor3AxisZ, kRotor3GroundReflectionM,

  kSnapshotSize,
};
// END AUDIO_SNAPSHOT_FIELDS

// AVAILABILITY
enum Availability {
  kAvailN1 = 1 << 0,
  kAvailN2 = 1 << 1,
  kAvailThrust = 1 << 2,
  kAvailFuelFlow = 1 << 3,
  kAvailCombustion = 1 << 4,
  kAvailRunning = 1 << 5,
  kAvailCommands = 1 << 6,
  kAvailAirspeed = 1 << 7,
  kAvailConfig = 1 << 8,
  kAvailPose = 1 << 9,
  kAvailAugmentation = 1 << 10,
  kAvailSourceAxis = 1 << 11,
  kAvailAfterburnerBurnedFuel = 1 << 12,
  kAvailEngineRpm = 1 << 13,
  kAvailPropellerRpm = 1 << 14,
  kAvailShaftPower = 1 << 15,
  kAvailElectricRotors = 1 << 16, kAvailDensity = 1 << 17,
};
// END AVAILABILITY

// AUDIO_EVENT
enum EventType {
  kEventEpoch = 0,
  kEventStarterOn = 1,
  kEventStarterOff = 2,
  kEventLightOff = 3,
  kEventFlameout = 4,
  kEventRunningOn = 5,
  kEventRunningOff = 6,
  kEventResync = 7,
};
// END AUDIO_EVENT

constexpr int kEventSize = 4;
constexpr int kEventCapacity = 32;
constexpr int kBatchSnapshots = 8;
constexpr int kBatchHeader = 2;
constexpr int kBatchLength =
    kBatchHeader + kBatchSnapshots * kSnapshotSize + kEventCapacity * kEventSize;

// Tiers. Off allocates no voices; the core still exists so that enabling does
// not have to fetch or compile anything.
enum Tier {
  kTierOff = 0,
  kTierLow = 1,
  kTierMed = 2,
  kTierHigh = 3,
};

}  // namespace osfs_audio
