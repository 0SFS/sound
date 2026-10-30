// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the 0sfs authors.
//
// The audio-thread core: telemetry interpolation, epoch clock, discrete events,
// spatialisation, tier caps and shedding. Everything reachable from
// osfs_audio_process() is allocation-free, lock-free and wait-free. Buffers are
// static, so the resident cost is a link-time fact rather than a heap guess.

#include <cstdlib>
#include <cstring>
#include <initializer_list>

#include "convolver.h"
#include "granular.h"
#include "primitives.h"
#include "snapshot.h"
#include "tire_voice.h"
#include "../../engine-sound/src/voice_caps.h"
#include "../../engine-sound/src/voice_abi.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define OSFS_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define OSFS_EXPORT extern "C"
#endif

namespace osfs_audio {
namespace {

constexpr int kMaxBlock = 1024;
constexpr int kQueueCapacity = 64;                 // ~1 s of 60 Hz telemetry
constexpr int kMaxSampleRate = 96000;
constexpr int kDelayCapacity = kMaxSampleRate / 2;  // sound.md §2: 0.5 s per mono path
constexpr int kMaxIrTaps = kMaxPartitions * kPartition;

/** sound.md §2: render two telemetry intervals behind the presentation clock. */
constexpr double kTelemetryLagSeconds = 2.0 / 60.0;
constexpr double kStaleSeconds = 0.25;
constexpr double kStaleFadeSeconds = 0.10;
constexpr double kTransitionFadeSeconds = 0.05;     // §1: 50 ms transitions
/** Sustained skew past this re-anchors the clock instead of growing a backlog. */
constexpr double kResyncSeconds = 0.50;
/**
 * Fresh snapshots stamped this far behind the render point mean the timeline
 * slipped: a main-thread stall the fixed-step loop did not replay, or clock
 * drift. Below the 250 ms stale threshold, so it re-anchors before fading.
 */
constexpr double kSlipSeconds = 0.15;
/** Smoothing time constant for gains and filter targets (§2, tau = 10 ms). */
constexpr double kSmoothTau = 0.010;
/** Equal-power pan normalisation: centre keeps unity through cos/sin. */
constexpr double kSqrt2 = 1.4142135623730951;

struct QueueEntry {
  double target = 0.0;   // audio frame this snapshot is aimed at
  double values[kSnapshotSize] = {};
};

struct PendingEvent {
  double target = 0.0;
  double simTimeS = 0.0;  // kept so a re-anchor can re-target the event
  int type = 0;
  double payload = 0.0;
};

// ---------------------------------------------------------------- state ----

double gSampleRate = 48000.0;
int gMaxBlock = kMaxBlock;
bool gReady = false;

int gTier = kTierOff;
int gPendingTier = -1;
/** 0 = full tier; each stage sheds detail in the documented order. */
int gShed = 0;

/**
 * The pilot's limits for each tier (the osfs.sound.<tier>.* parameters). They
 * can only lower the tier's own caps below; shedding then works down from
 * them. Until set, each tier runs at its caps.
 */
struct TierLimits {
  int partials = 12;
  int noiseBands = 8;
  int grains = kMaxGrains;
  double startsPerSecond = 160.0;
  double irSeconds = 0.040;
};
TierLimits gLimits[kTierHigh + 1];

double gMasterGain = 1.0;
double gEngineGain = 1.0;
double gTireGain = 1.0;
double gAirframeGain = 1.0;
/** Pilot gain for the augmentation contribution; separate from physical state. */
double gAfterburnerVolume = 1.0;

QueueEntry gQueue[kQueueCapacity];
int gQueueHead = 0;
int gQueueCount = 0;
int gBracket = 0;

PendingEvent gEvents[kEventCapacity];
int gEventCount = 0;

double gAnchorSim = 0.0;
double gAnchorFrame = 0.0;
int gEpoch = 0;
bool gAnchored = false;
bool gResyncRequested = false;
/** Set when a snapshot was accepted since the last rendered block. */
bool gFreshSnapshots = false;
/** Latched combustion state from a discrete event, until telemetry agrees. */
double gCombustionLatch = 0.0;
bool gHasCombustionLatch = false;

double gBatch[kBatchLength];

float gOutLeft[kMaxBlock];
float gOutRight[kMaxBlock];

struct SpatialVoice {
 float delayStorage[kDelayCapacity]; DelayLine delay;
 double irSpectra[kMaxPartitions*kFftSize*2], irFdl[kMaxPartitions*kFftSize*2], irScratch[4*kFftSize],irTaps[kMaxIrTaps];
 Convolver convolver; double wetIn[kPartition],wetOut[kPartition];int partIndex=0;double irSeconds=-1;
 Biquad colour;Smoother spatial,pan,colourHz,rangeFade,exterior,sourceCosine,sourceDirectionWeight;
 double delaySamples=0,delayAlternate=0,delayBlend=0;bool delayCrossfading=false,delaySeeded=false;int delayResetCounter=-1;
};
SpatialVoice gSpatialVoices[kVoiceMaxSources];
int gSourceCount=1,gFamilyResetCounter=0,gDelayResetCounter=0;
bool gElectricSources=false;
double gInteriorGain=0.12589254117941673,gInteriorHz=1200,gHighInteriorGain=0.12589254117941673,gHighInteriorHz=1400;
double gVoiceInputs[kVoiceMaxSources*kVoiceMaxFrames*kVoiceInputStride];
double gVoiceOutputs[kVoiceMaxSources*2*kVoiceMaxFrames];
EngineCaps gCaps;
double gIrSeconds=-1;
struct PreparedFrame {double values[kSnapshotSize];double fade;int tier;EngineCaps caps;double irSeconds;int delayResetCounter;};
PreparedFrame gPrepared[kMaxBlock];
double gPreparedExterior[kVoiceMaxSources][kMaxBlock];
int gPreparedCount=0;
TireVoice gTire;
GranularVoice gGrains;
Dynamics gDynamics;

Band gBands[kMaxBands];
float* gBandStorage[kMaxBands] = {};
int gBandCount = 0;


double gTireWatts = 0.0;
double gFade = 0.0;
double gFadeTarget = 1.0;
double gFadeStep = 1.0;
bool gCapsPending = false;

constexpr int kStatCount = 25;
double gStats[kStatCount];
enum Stat {
  kStatSnapshotsIn = 0, kStatSnapshotsDropped, kStatEventsIn, kStatEventsDropped,
  kStatResyncs, kStatStaleFades, kStatBlocks, kStatFrames, kStatPeak,
  kStatTelemetryAge, kStatActiveGrains, kStatGrainDrops, kStatNonFinite,
  kStatQueueDepth, kStatFade, kStatDoppler, kStatDistance, kStatTier,
  kStatShed, kStatEpoch,
  // What the current tier runs after the pilot's limits and shedding.
  kStatPartials, kStatNoiseBands, kStatGrainCap, kStatGrainStarts, kStatIrMs,
};

// -------------------------------------------------------------- helpers ----

double targetFrameFor(double simTimeS) {
  // k = 1 (sound.md §2): initial shipping support is real time only. A future
  // speed change must open a NEW epoch rather than scale pitch by k.
  return gAnchorFrame + (simTimeS - gAnchorSim) * gSampleRate;
}

void clearQueue() {
  gQueueHead = 0;
  gQueueCount = 0;
  gBracket = 0;
  gEventCount = 0;
  gHasCombustionLatch = false;
}

void beginFade(double target, double seconds) {
  gFadeTarget = clamp01(target);
  gFadeStep = 1.0 / std::fmax(seconds * gSampleRate, 1.0);
}

/** Tier caps from sound.md §1, after `gShed` stages of degradation. */
void applyCaps() {
  EngineCaps caps;
  int grains = 0;
  double starts = 0.0;
  double irSeconds = 0.0;

  switch (gTier) {
    case kTierLow:
      caps.partials = 4;    // + 1 tire squeal = 5 oscillators
      caps.noiseBands = 5;  // fan, jet, combustor, wind, config + tire = 6
      caps.bypassBand = false;
      break;
    case kTierMed:
      caps.partials = 12;   // + 1 tire squeal = 13 oscillators
      caps.noiseBands = 6;  // Low + bypass + tire = 7 noise sources
      caps.bypassBand = true;
      irSeconds = 0.020;
      break;
    case kTierHigh:
      caps.partials = 12;
      caps.noiseBands = 8;  // Med + fine mixing + shock surrogate + tire <= 9
      caps.bypassBand = true;
      caps.highFidelity = true;
      irSeconds = 0.040;
      // Shipping High is entirely procedural. A full recording cannot be
      // added to this component synthesis path as an unspecified residual.
      grains = 0;
      starts = 0.0;
      break;
    default:
      break;
  }

  // The pilot's limits lower the caps; they never raise them.
  const TierLimits& limit = gLimits[gTier];
  caps.partials = caps.partials < limit.partials ? caps.partials : limit.partials;
  caps.noiseBands = caps.noiseBands < limit.noiseBands ? caps.noiseBands : limit.noiseBands;
  grains = grains < limit.grains ? grains : limit.grains;
  starts = std::fmin(starts, limit.startsPerSecond);
  irSeconds = std::fmin(irSeconds, limit.irSeconds);
  // Duration and padded-tap ceilings both apply at elevated context rates.
  const int tierIrTaps = gTier == kTierMed ? 1024 : kMaxIrTaps;
  irSeconds = std::fmin(irSeconds, static_cast<double>(tierIrTaps) / gSampleRate);

  // Shedding order (sound.md §1): oscillator count, grain density, IR length,
  // then internal sample rate. Half-rate synthesis is deliberately NOT wired
  // up: it may only be enabled once its resampler-inclusive cost is measured
  // to be lower, and no such measurement exists.
  for (int stage = 0; stage < gShed; ++stage) {
    if (caps.partials > 8) { caps.partials = 8; continue; }
    if (grains > 8) { grains = 8; starts = 100.0; continue; }
    if (caps.partials > 4) { caps.partials = 4; continue; }
    if (grains > 4) { grains = 4; starts = 50.0; continue; }
    if (grains > 0) { grains = 0; starts = 0.0; continue; }
    if (irSeconds > 0.020) { irSeconds = 0.020; continue; }
    if (irSeconds > 0.010) { irSeconds = 0.010; continue; }
    if (irSeconds > 0.0) { irSeconds = 0.0; continue; }
    if (caps.partials > 2) { caps.partials = 2; continue; }
    break;
  }

  gCaps=caps;
  gGrains.setCaps(grains, starts);

  // Open-air electric installations have no cabin impulse response.
  if (gElectricSources) irSeconds = 0.0;
  gIrSeconds=irSeconds;
  gStats[kStatTier] = gTier;
  gStats[kStatShed] = gShed;
  gStats[kStatPartials] = caps.partials;
  gStats[kStatNoiseBands] = caps.noiseBands;
  gStats[kStatGrainCap] = grains;
  gStats[kStatGrainStarts] = starts;
  gStats[kStatIrMs] = irSeconds * 1000.0;
}

void applyPendingCaps() {
  if (gPendingTier >= 0) {
    gTier = gPendingTier;
    gPendingTier = -1;
    gShed = 0;
    ++gDelayResetCounter;
  }
  applyCaps();
  gCapsPending = false;
}

/** Live cap edits use one engine: fade down, apply the latest limits, fade up.
 * Setup (before any rendered frame) is immediate. The tire path is untouched.
 * No source pool grows to overlap old and new limits. */
void requestCaps() {
  if (gReady && gStats[kStatFrames] > 0.0) {
    gCapsPending = true;
    beginFade(0.0, kTransitionFadeSeconds * 0.5);
  } else {
    applyPendingCaps();
  }
}

void resetVoices() {
 ++gFamilyResetCounter;gTire.reset();gGrains.reset();gDynamics.reset();
 for(auto& v:gSpatialVoices){v.delay.reset();v.convolver.clear();v.colour.reset();v.partIndex=0;
  for(int i=0;i<kPartition;++i){v.wetIn[i]=0;v.wetOut[i]=0;}
  for(Smoother* sm:{&v.spatial,&v.pan,&v.exterior,&v.sourceCosine,&v.sourceDirectionWeight})sm->reset(0);
  v.colourHz.reset(1200);v.rangeFade.reset(1);v.delaySamples=0;v.delayAlternate=0;v.delayBlend=0;v.delayCrossfading=false;v.delaySeeded=false;v.irSeconds=-1;
 }
 gCapsPending=false;
}

/** Ingests one snapshot, keeping the queue ordered by target frame. */
void ingestSnapshot(const double* values) {
  if (!gAnchored || static_cast<int>(values[kEpoch]) != gEpoch) {
    gStats[kStatSnapshotsDropped] += 1.0;
    return;
  }
  for (int i = 0; i < kSnapshotSize; ++i) {
    if (!std::isfinite(values[i])) {
      gStats[kStatNonFinite] += 1.0;
      gStats[kStatSnapshotsDropped] += 1.0;
      return;
    }
  }
  const double target = targetFrameFor(values[kSimTimeS]);
  if (gQueueCount > 0) {
    QueueEntry& newest = gQueue[(gQueueHead + gQueueCount - 1) % kQueueCapacity];
    // The queue stays ordered by construction. A late snapshot would rewind
    // the interpolator and make staleness lie, so it is dropped; a repeat of
    // the same instant replaces the newest entry (newest state wins).
    if (target < newest.target - 0.5) {
      gStats[kStatSnapshotsDropped] += 1.0;
      return;
    }
    if (target <= newest.target + 0.5) {
      std::memcpy(newest.values, values, sizeof(double) * kSnapshotSize);
      gStats[kStatSnapshotsIn] += 1.0;
      gFreshSnapshots = true;
      return;
    }
  }
  if (gQueueCount >= kQueueCapacity) {
    // A full queue means the consumer is behind; the newest state is the one
    // worth keeping, so the oldest goes.
    gQueueHead = (gQueueHead + 1) % kQueueCapacity;
    gQueueCount--;
    if (gBracket > 0) gBracket--;
    gStats[kStatSnapshotsDropped] += 1.0;
  }
  QueueEntry& entry = gQueue[(gQueueHead + gQueueCount) % kQueueCapacity];
  std::memcpy(entry.values, values, sizeof(double) * kSnapshotSize);
  entry.target = target;
  gQueueCount++;
  gStats[kStatSnapshotsIn] += 1.0;
  gFreshSnapshots = true;
}

void ingestEvent(int type, double simTimeS, int epoch, double payload) {
  if (type == kEventEpoch || type == kEventResync) {
    gResyncRequested = true;
    return;
  }
  // A light-off from before a reset must not latch the new epoch's burner.
  if (!gAnchored || epoch != gEpoch) { gStats[kStatEventsDropped] += 1.0; return; }
  if (gEventCount >= kEventCapacity) {
    gStats[kStatEventsDropped] += 1.0;
    // sound.md §2: overflow resynchronises and reports. It never silently
    // loses an ignition or a shutdown.
    gResyncRequested = true;
    return;
  }
  PendingEvent& event = gEvents[gEventCount++];
  event.target = targetFrameFor(simTimeS);
  event.simTimeS = simTimeS;
  event.type = type;
  event.payload = payload;
  gStats[kStatEventsIn] += 1.0;
}

/**
 * Discrete transitions land at their own timestamp, not at the next telemetry
 * interval. Light-off latches combustion on until interpolated telemetry agrees,
 * so a dropped snapshot cannot leave the burner silent through a start.
 */
void applyEvent(int type) {
  switch (type) {
    case kEventLightOff:
    case kEventRunningOn:
      gCombustionLatch = 1.0;
      gHasCombustionLatch = true;
      break;
    case kEventFlameout:
    case kEventRunningOff:
      gCombustionLatch = 0.0;
      gHasCombustionLatch = true;
      break;
    default:
      break;  // Starter transitions are already visible through N2 telemetry.
  }
}

void drainEventsUpTo(double frame) {
  int keep = 0;
  for (int i = 0; i < gEventCount; ++i) {
    if (gEvents[i].target <= frame) {
      applyEvent(gEvents[i].type);
    } else {
      gEvents[keep++] = gEvents[i];
    }
  }
  gEventCount = keep;
}

/** Advances the bracket cursor and writes the interpolated snapshot. */
bool interpolateAt(double frame, double* out) {
  if (gQueueCount == 0) return false;
  // Retire entries the cursor has passed, always keeping one to bracket from.
  while (gQueueCount > 1) {
    const QueueEntry& next = gQueue[(gQueueHead + 1) % kQueueCapacity];
    if (next.target > frame) break;
    gQueueHead = (gQueueHead + 1) % kQueueCapacity;
    gQueueCount--;
  }
  const QueueEntry& a = gQueue[gQueueHead];
  if (gQueueCount == 1 || frame <= a.target) {
    std::memcpy(out, a.values, sizeof(double) * kSnapshotSize);
    return true;
  }
  const QueueEntry& b = gQueue[(gQueueHead + 1) % kQueueCapacity];
  const double span = b.target - a.target;
  const double t = span > 1e-9 ? clamp01((frame - a.target) / span) : 1.0;
  for (int i = 0; i < kSnapshotSize; ++i) {
    out[i] = a.values[i] + (b.values[i] - a.values[i]) * t;
  }
  // Identity and discrete fields must never be blended into a half-state.
  out[kVersion] = b.values[kVersion];
  out[kSequence] = b.values[kSequence];
  out[kEpoch] = b.values[kEpoch];
  out[kAvailability] = a.values[kAvailability];
  out[kRunning] = a.values[kRunning];
  out[kStarter] = a.values[kStarter];
  out[kCutoff] = a.values[kCutoff];
  out[kAugmentation] = a.values[kAugmentation];
  return true;
}

double newestTarget() {
  if (gQueueCount == 0) return 0.0;
  return gQueue[(gQueueHead + gQueueCount - 1) % kQueueCapacity].target;
}

}  // namespace
}  // namespace osfs_audio

// ----------------------------------------------------------------- API -----

using namespace osfs_audio;

OSFS_EXPORT int osfs_audio_init(double sampleRate, int maxBlockFrames, unsigned seed) {
  if (!(sampleRate > 8000.0) || sampleRate > kMaxSampleRate) return 0;
  gSampleRate = sampleRate;
  gPendingTier = -1;
  gAfterburnerVolume = 1.0;
  gMaxBlock = (maxBlockFrames > 0 && maxBlockFrames <= kMaxBlock) ? maxBlockFrames : kPartition;
  gTire.configure(sampleRate,0x74697265u);gGrains.configure(sampleRate,seed^0x9e3779b9u);gDynamics.configure(sampleRate);
 for(auto& v:gSpatialVoices){v.delay.configure(v.delayStorage,static_cast<int>(clamp(sampleRate*0.5,2.0,kDelayCapacity)));v.convolver.configure(v.irSpectra,v.irFdl,v.irScratch);
 for(Smoother* sm:{&v.spatial,&v.pan,&v.colourHz,&v.rangeFade,&v.exterior,&v.sourceCosine,&v.sourceDirectionWeight})sm->configure(sampleRate,kSmoothTau);}
  gIrSeconds = -1.0;
  for (int i = 0; i < kStatCount; ++i) gStats[i] = 0.0;
  clearQueue();
  resetVoices();
  applyCaps();
  gFade = 0.0;
  beginFade(1.0, kTransitionFadeSeconds);
  gReady = true;
  return 1;
}

OSFS_EXPORT void osfs_audio_reset(void) {
  clearQueue();
  resetVoices();
  applyPendingCaps();
  gAnchored = false;
  gResyncRequested = false;
  gFade = 0.0;
  beginFade(1.0, kTransitionFadeSeconds);
}

/** Family-neutral installation and block buffers. Family profiles never enter the host. */
OSFS_EXPORT void osfs_audio_set_source_type(int electric){gElectricSources=electric!=0;}
OSFS_EXPORT void osfs_audio_set_sources(int count,double gain,double hz,double highGain,double highHz){
 gSourceCount=static_cast<int>(clamp(count,1,kVoiceMaxSources));gInteriorGain=clamp(sanitize(gain),0,1);gInteriorHz=clamp(sanitize(hz,1200),20,20000);gHighInteriorGain=clamp(sanitize(highGain),0,1);gHighInteriorHz=clamp(sanitize(highHz,1200),20,20000);
}
OSFS_EXPORT double* osfs_audio_voice_input_ptr(){return gVoiceInputs;}
OSFS_EXPORT double* osfs_audio_voice_output_ptr(){return gVoiceOutputs;}
OSFS_EXPORT int osfs_audio_source_count(){return gSourceCount;}
OSFS_EXPORT void osfs_audio_set_tier(int tier) {
  const int next = (tier < kTierOff) ? kTierOff : (tier > kTierHigh ? kTierHigh : tier);
  if (next == gPendingTier || (next == gTier && gPendingTier < 0)) return;
  if (gReady && next != kTierOff && gTier != kTierOff && gStats[kStatFrames] > 0.0 && gFade > 0.0) {
    gPendingTier = next;
    gCapsPending = true;
    beginFade(0.0, kTransitionFadeSeconds * 0.5);
    return;
  }
  gTier = next;
  gPendingTier = -1;
  gShed = 0;
  gCapsPending = false;
  applyCaps();
  // Low does not run the delay line, so its tap is stale on the way back into
  // Med. The fade below covers re-seating it from the current geometry.
  ++gDelayResetCounter;
  // §1: fade down, switch, fade up. Never run two engines to cross a tier.
  gFade = 0.0;
  beginFade(1.0, kTransitionFadeSeconds);
}

OSFS_EXPORT int osfs_audio_get_tier(void) { return gTier; }

/**
 * One tier's limits: engine partials (at least the two fundamentals), noise
 * bands, simultaneous grains, grain starts per second and impulse-response
 * length. Each is clamped to what the tier allows at all.
 */
OSFS_EXPORT void osfs_audio_set_limits(int tier, int partials, int noiseBands, int grains,
                                       double startsPerSecond, double irMilliseconds) {
  if (tier <= kTierOff || tier > kTierHigh) return;
  TierLimits& limit = gLimits[tier];
  const TierLimits previous = limit;
  limit.partials = partials < 2 ? 2 : (partials > 12 ? 12 : partials);
  limit.noiseBands = noiseBands < 0 ? 0 : (noiseBands > 8 ? 8 : noiseBands);
  limit.grains = grains < 0 ? 0 : (grains > kMaxGrains ? kMaxGrains : grains);
  limit.startsPerSecond = std::isfinite(startsPerSecond) ? std::fmin(std::fmax(startsPerSecond, 0.0), 160.0) : 160.0;
  const double irSeconds = irMilliseconds / 1000.0;
  limit.irSeconds = std::isfinite(irSeconds) ? std::fmin(std::fmax(irSeconds, 0.0), 0.040) : 0.040;
  if (limit.partials == previous.partials && limit.noiseBands == previous.noiseBands
      && limit.grains == previous.grains && limit.startsPerSecond == previous.startsPerSecond
      && limit.irSeconds == previous.irSeconds) return;
  if (tier == gTier) requestCaps();
}

OSFS_EXPORT void osfs_audio_set_shed(int level) {
  const int next = level < 0 ? 0 : (level > 8 ? 8 : level);
  if (next == gShed) return;
  gShed = next;
  requestCaps();
}

OSFS_EXPORT int osfs_audio_get_shed(void) { return gShed; }

OSFS_EXPORT void osfs_audio_set_gains(double master, double engine, double tire,
                                      double airframe, double reducedRange) {
  gMasterGain = clamp(sanitize(master), 0.0, 8.0);
  gEngineGain = clamp(sanitize(engine), 0.0, 8.0);
  gTireGain = clamp01(sanitize(tire));
  gAirframeGain = clamp01(sanitize(airframe));
  gDynamics.setReducedRange(clamp01(sanitize(reducedRange)));
}

/** Live AB-only gain: no profile transaction, physical-state change or voice reset. */
OSFS_EXPORT void osfs_audio_set_afterburner_volume(double volume) {
  gAfterburnerVolume = clamp01(sanitize(volume));
  // Setup has no previous audible gain to preserve. A saved zero must not
  // leak reheat while smoothing from the core's default one on its first
  // rendered samples. Live edits still use the existing 10 ms dezipper.

}

OSFS_EXPORT void osfs_audio_set_epoch(int epoch, double simTimeS, double audioFrame) {
  gEpoch = epoch;
  gAnchorSim = sanitize(simTimeS);
  gAnchorFrame = sanitize(audioFrame);
  gAnchored = true;
  gResyncRequested = false;
  clearQueue();
  gStats[kStatEpoch] = epoch;
  if (gCapsPending) {
    applyPendingCaps();
  }
  // A reset, a seek or a model replacement is a discontinuity: mute, rebase,
  // and come back up rather than gliding through unrelated state. That includes
  // re-seating the propagation delay, so a teleport lands on its new range
  // under the fade below instead of holding the old one.
  ++gDelayResetCounter;
  gFade = 0.0;
  beginFade(1.0, kTransitionFadeSeconds);
}

OSFS_EXPORT double* osfs_audio_batch_ptr(void) { return gBatch; }
OSFS_EXPORT int osfs_audio_batch_length(void) { return kBatchLength; }
OSFS_EXPORT int osfs_audio_snapshot_size(void) { return kSnapshotSize; }

OSFS_EXPORT void osfs_audio_commit_batch(void) {
  const int snapshots = static_cast<int>(sanitize(gBatch[0]));
  const int events = static_cast<int>(sanitize(gBatch[1]));
  const int snapshotCount = snapshots < 0 ? 0 : (snapshots > kBatchSnapshots ? kBatchSnapshots : snapshots);
  const int eventCount = events < 0 ? 0 : (events > kEventCapacity ? kEventCapacity : events);
  for (int i = 0; i < snapshotCount; ++i) {
    ingestSnapshot(gBatch + kBatchHeader + i * kSnapshotSize);
  }
  const double* eventBase = gBatch + kBatchHeader + kBatchSnapshots * kSnapshotSize;
  for (int i = 0; i < eventCount; ++i) {
    const double* e = eventBase + i * kEventSize;
    ingestEvent(static_cast<int>(e[0]), e[1], static_cast<int>(e[2]), e[3]);
  }
}

OSFS_EXPORT void osfs_audio_set_tire(double slipPowerWatts) {
  gTireWatts = std::fmax(0.0, sanitize(slipPowerWatts));
}

OSFS_EXPORT float* osfs_audio_out(int channel) {
  return channel == 0 ? gOutLeft : gOutRight;
}

OSFS_EXPORT double* osfs_audio_stats(void) { return gStats; }
OSFS_EXPORT int osfs_audio_stats_count(void) { return kStatCount; }

/**
 * Tier 3 band storage. Called only from the setup path, never from process().
 * There is no shipping bank: sound.md §4 excludes the Recordist library, so the
 * only callers today are original synthetic test fixtures.
 */
OSFS_EXPORT float* osfs_audio_band_alloc(int index, int frames, double n1, double exterior) {
  if (index < 0 || index >= kMaxBands || frames <= 0 || frames > 60 * kMaxSampleRate) return nullptr;
  std::free(gBandStorage[index]);
  gBandStorage[index] = static_cast<float*>(std::calloc(static_cast<size_t>(frames), sizeof(float)));
  if (!gBandStorage[index]) {
    gBands[index] = Band{};
    return nullptr;
  }
  gBands[index].samples = gBandStorage[index];
  gBands[index].length = frames;
  gBands[index].n1 = clamp01(sanitize(n1));
  gBands[index].exterior = clamp01(sanitize(exterior));
  if (index >= gBandCount) gBandCount = index + 1;
  gGrains.setBands(gBands, gBandCount);
  return gBandStorage[index];
}

OSFS_EXPORT void osfs_audio_band_clear(void) {
  for (int i = 0; i < kMaxBands; ++i) {
    std::free(gBandStorage[i]);
    gBandStorage[i] = nullptr;
    gBands[i] = Band{};
  }
  gBandCount = 0;
  gGrains.setBands(nullptr, 0);
  gGrains.reset();
}

/** Reports whether a bank is loaded, not whether the current tier plays it. */
OSFS_EXPORT int osfs_audio_bands_ready(void) { return gGrains.hasBands() ? 1 : 0; }

/**
 * Renders `frames` samples starting at absolute audio frame `blockStartFrame`.
 * No allocation, no locking, no waiting, no logging.
 */
OSFS_EXPORT void osfs_audio_prepare(double blockStartFrame, int frames) {
  const int count = frames < 0 ? 0 : (frames > gMaxBlock ? gMaxBlock : frames);
  gPreparedCount=count;
  if (!gReady || gTier == kTierOff) {
    for(int i=0;i<count;++i)gPrepared[i].tier=0;
    for(int v=0;v<gSourceCount;++v)for(int i=0;i<count;++i){double* row=gVoiceInputs+(v*kVoiceMaxFrames+i)*kVoiceInputStride;for(int j=0;j<kVoiceInputStride;++j)row[j]=0;}
    for (int i = 0; i < count; ++i) { gOutLeft[i] = 0.0f; gOutRight[i] = 0.0f; }
    return;
  }

  const double start = sanitize(blockStartFrame);
  const double lagFrames = kTelemetryLagSeconds * gSampleRate;

  if (gResyncRequested && gQueueCount > 0) {
    // Re-anchor so the newest snapshot lands at the evaluation point. A growing
    // backlog is never left to accumulate.
    // The newest state is kept, so the render has a target through the fade
    // instead of reading the rebase as missing telemetry.
    const int newest = (gQueueHead + gQueueCount - 1) % kQueueCapacity;
    if (newest != 0) gQueue[0] = gQueue[newest];
    gQueueHead = 0;
    gQueueCount = 1;
    gBracket = 0;
    gAnchorSim = gQueue[0].values[kSimTimeS];
    gAnchorFrame = start - lagFrames;
    gQueue[0].target = gAnchorFrame;
    // Pending transitions keep their own timestamps on the new timeline; any
    // now in the past land on the next sample rather than vanishing.
    for (int e = 0; e < gEventCount; ++e) gEvents[e].target = targetFrameFor(gEvents[e].simTimeS);
    gResyncRequested = false;
    gStats[kStatResyncs] += 1.0;
    // No fade: voices, phases and filters carry straight through a re-anchor,
    // and the 10 ms target smoothing absorbs the jump in state. Fading from
    // silence here turned every small timeline slip (a few blocked physics
    // frames) into an audible dropout.
  }

  // Sustained skew in either direction is a clock problem, not a data problem:
  // telemetry far ahead is a backlog, and FRESH telemetry stamped behind the
  // render point is a slipped timeline that would otherwise read as stale
  // forever and never come back.
  if (gQueueCount > 0 && gAnchored) {
    const double skew = (newestTarget() - (start - lagFrames)) / gSampleRate;
    if (skew > kResyncSeconds || (gFreshSnapshots && -skew > kSlipSeconds)) {
      gResyncRequested = true;
    }
  }
  gFreshSnapshots = false;

  double interpolated[kSnapshotSize] = {};
  const double ceilingDelay = gSampleRate * 0.42;   // fade out before the 0.5 s cap

  for (int i = 0; i < count; ++i) {
    const double frame = start + i;
    const double evalFrame = frame - lagFrames;
    drainEventsUpTo(evalFrame);

    const bool haveTelemetry = interpolateAt(evalFrame, interpolated);
    double staleSeconds = 0.0;
    if (haveTelemetry) {
      staleSeconds = std::fmax(0.0, (evalFrame - newestTarget()) / gSampleRate);
    }

    // Hold the last valid target through a missing bracket; fade to silence
    // once telemetry has been stale for 250 ms (sound.md §2).
    if (!haveTelemetry || staleSeconds > kStaleSeconds) {
      if (gFadeTarget != 0.0) {
        beginFade(0.0, kStaleFadeSeconds);
        gStats[kStatStaleFades] += 1.0;
      }
    } else if (gFadeTarget == 0.0 && !gResyncRequested && !gCapsPending) {
      beginFade(1.0, kTransitionFadeSeconds);
    }
    gFade += clamp(gFadeTarget - gFade, -gFadeStep, gFadeStep);
    if (gCapsPending && gFade <= 0.0) {
      applyPendingCaps();
      if (haveTelemetry && staleSeconds <= kStaleSeconds) beginFade(1.0, kTransitionFadeSeconds * 0.5);
    }
    if (gTier == kTierOff) {
      gPrepared[i].tier=0;
      for(int v=0;v<gSourceCount;++v)gVoiceInputs[(v*kVoiceMaxFrames+i)*kVoiceInputStride+kVoiceTier]=0;
      continue;
    }
    const bool spatialTier = gTier >= kTierMed;

    gStats[kStatTelemetryAge]=staleSeconds;
    PreparedFrame& pf=gPrepared[i];std::memcpy(pf.values,interpolated,sizeof(interpolated));pf.fade=gFade;pf.tier=gTier;pf.caps=gCaps;pf.irSeconds=gIrSeconds;pf.delayResetCounter=gDelayResetCounter;
    const int availability=static_cast<int>(interpolated[kAvailability]);
    double combustionTarget=(availability&kAvailCombustion)?clamp01(interpolated[kCombustion]):0;
    if(gHasCombustionLatch){if(std::fabs(combustionTarget-gCombustionLatch)<0.5)gHasCombustionLatch=false;else combustionTarget=gCombustionLatch;}
    const bool electric=gElectricSources;
    for(int v=0;v<gSourceCount;++v){auto& spatial=gSpatialVoices[v];double* row=gVoiceInputs+(v*kVoiceMaxFrames+i)*kVoiceInputStride;for(int j=0;j<kVoiceInputStride;++j)row[j]=0;
     row[kVoiceN1Pct]=(availability&kAvailN1)?interpolated[kN1Pct]:0;row[kVoiceN2Pct]=(availability&kAvailN2)?interpolated[kN2Pct]:0;
     row[kVoiceThrustLbf]=(availability&kAvailThrust)?interpolated[kThrustLbf]:0;row[kVoiceFuelFlowPps]=(availability&kAvailFuelFlow)?interpolated[kFuelFlowPps]:0;
     row[kVoiceCombustion]=combustionTarget;row[kVoiceEngineRpm]=(availability&kAvailEngineRpm)?interpolated[kEngineRpm]:0;row[kVoicePropellerRpm]=(availability&kAvailPropellerRpm)?interpolated[kPropellerRpm]:0;row[kVoiceShaftPowerHp]=(availability&kAvailShaftPower)?interpolated[kShaftPowerHp]:0;
     row[kVoiceKias]=(availability&kAvailAirspeed)?interpolated[kKias]:0;row[kVoiceGearNorm]=(availability&kAvailConfig)?interpolated[kGearNorm]:0;row[kVoiceFlapNorm]=(availability&kAvailConfig)?interpolated[kFlapNorm]:0;
     const bool haveBurned=(availability&kAvailAfterburnerBurnedFuel)&&(availability&kAvailFuelFlow)&&(availability&kAvailAugmentation)&&interpolated[kAugmentation]>.5&&interpolated[kFuelFlowPps]>0;
     row[kVoiceAfterburnerFraction]=haveBurned?clamp01(interpolated[kAfterburnerBurnedFuelFlowKgSec]/(interpolated[kFuelFlowPps]*.45359237)):0;row[kVoiceAfterburnerVolume]=gAfterburnerVolume;
     const int rotor=kRotor0Rpm+v*16;
     const int pos=electric?rotor+6:kSourceX,vel=electric?rotor+9:kSourceVelX,axis=electric?rotor+12:kSourceAxisX;
     const double sx=interpolated[pos],sy=interpolated[pos+1],sz=interpolated[pos+2],distance=std::sqrt(sx*sx+sy*sy+sz*sz);
     const double soundSpeed=std::fmax(50.0,interpolated[kSoundSpeedMps]);
     const double exterior=spatial.exterior.process((availability&kAvailPose)?clamp01(interpolated[kExterior]):0);
     double cosine=0;bool known=false;if((availability&kAvailPose)&&(electric||(availability&kAvailSourceAxis))&&distance>1e-3){const double ax=interpolated[axis],ay=interpolated[axis+1],az=interpolated[axis+2],len=std::sqrt(ax*ax+ay*ay+az*az);if(len>1e-6){cosine=clamp(-(ax*sx+ay*sy+az*sz)/(len*distance),-1,1);known=true;}}
     gPreparedExterior[v][i]=exterior;
     row[kVoiceDownstreamCosine]=spatial.sourceCosine.process(cosine);row[kVoiceDirectionWeight]=spatial.sourceDirectionWeight.process(known?exterior:0);
     double doppler=1;if(distance>1e-3){const double nx=-sx/distance,ny=-sy/distance,nz=-sz/distance;const double vs=interpolated[vel]*nx+interpolated[vel+1]*ny+interpolated[vel+2]*nz,vl=interpolated[kListenerVelX]*nx+interpolated[kListenerVelY]*ny+interpolated[kListenerVelZ]*nz;const double denominator=soundSpeed-vs;doppler=std::fabs(denominator)>1e-6?(soundSpeed-vl)/denominator:1;doppler=clamp(sanitize(doppler,1),.5,2);}
     row[kVoiceCullScale]=gTier>=kTierMed?doppler:1;
     if(electric){row[kVoiceRotorRpm]=interpolated[rotor];row[kVoiceThrustN]=interpolated[rotor+1];row[kVoiceTorqueNm]=interpolated[rotor+2];row[kVoiceInducedVelocityMps]=interpolated[rotor+3];row[kVoiceVrs]=interpolated[rotor+4];row[kVoiceAirDensityKgM3]=(availability&kAvailDensity)?interpolated[kAirDensityKgM3]:1.225;row[kVoiceArmed]=interpolated[kArmed];row[kVoiceAxialVelocityMps]=-interpolated[kAirVelocityZ]; /* Current drone thrust axes are body -Z. */}
     row[kVoiceTier]=gTier;
     // Electric caps are installation totals: every rotor retains its blade-passage tone.
     row[kVoicePartials]=electric?gCaps.partials/gSourceCount+(v<gCaps.partials%gSourceCount):gCaps.partials;
     row[kVoiceNoiseBands]=electric?gCaps.noiseBands/gSourceCount+(v<gCaps.noiseBands%gSourceCount):gCaps.noiseBands;row[kVoiceBypassBand]=gCaps.bypassBand;row[kVoiceHighFidelity]=gCaps.highFidelity;row[kVoiceResetCounter]=gFamilyResetCounter;row[kVoiceValid]=haveTelemetry&&(!electric||((availability&kAvailElectricRotors)&&interpolated[rotor+5]>.5));row[kVoiceAirframeOwner]=v==0;
     // Geometry inputs are snapshotted separately; smoothing must advance only once.

    }
  }
}
OSFS_EXPORT void osfs_audio_mix(double blockStartFrame,int frames){
 const int count=frames<0?0:(frames>gPreparedCount?gPreparedCount:frames);const double ceilingDelay=gSampleRate*.42;
 for(int i=0;i<count;++i){const auto& pf=gPrepared[i];if(!gReady||pf.tier==kTierOff){gOutLeft[i]=gOutRight[i]=0;continue;}
  const double* interpolated=pf.values;const int availability=static_cast<int>(interpolated[kAvailability]);const bool electric=gElectricSources;
  const int tier=pf.tier;const bool spatialTier=tier>=kTierMed;double left=0,right=0,tireField=1;
  for(int v=0;v<gSourceCount;++v){auto& state=gSpatialVoices[v];
   auto& gDelay=state.delay;
   auto& gConvolver=state.convolver;
   auto& gColour=state.colour;
   auto& gSpatial=state.spatial;
   auto& gPan=state.pan;
   auto& gColourHz=state.colourHz;
   auto& gRangeFade=state.rangeFade;
   auto& gDelaySamples=state.delaySamples;
   auto& gDelayAlternate=state.delayAlternate;
   auto& gDelayBlend=state.delayBlend;
   auto& gDelayCrossfading=state.delayCrossfading;
   auto& gDelaySeeded=state.delaySeeded;
   auto& gPartIndex=state.partIndex;
   auto& gWetIn=state.wetIn;
   auto& gWetOut=state.wetOut;
   if(state.delayResetCounter!=pf.delayResetCounter){state.delaySeeded=false;state.delayResetCounter=pf.delayResetCounter;}
   if(state.irSeconds!=pf.irSeconds){state.irSeconds=pf.irSeconds;if(pf.irSeconds<=0)state.convolver.setImpulse(nullptr,0);else {const int taps=generateCabinImpulse(state.irTaps,kMaxIrTaps,gSampleRate,pf.irSeconds,0x53463530u);state.convolver.setImpulse(state.irTaps,taps);}state.partIndex=0;for(int j=0;j<kPartition;++j){state.wetIn[j]=state.wetOut[j]=0;}}
   const int rotor=kRotor0Rpm+v*16,pos=electric?rotor+6:kSourceX,vel=electric?rotor+9:kSourceVelX;
   const double sx=interpolated[pos],sy=interpolated[pos+1],sz=interpolated[pos+2],distance=std::sqrt(sx*sx+sy*sy+sz*sz),soundSpeed=std::fmax(50.0,interpolated[kSoundSpeedMps]);
   const double exterior=gPreparedExterior[v][i];double doppler=1,rangeRate=0;if(distance>1e-3){const double nx=-sx/distance,ny=-sy/distance,nz=-sz/distance,vs=interpolated[vel]*nx+interpolated[vel+1]*ny+interpolated[vel+2]*nz,vl=interpolated[kListenerVelX]*nx+interpolated[kListenerVelY]*ny+interpolated[kListenerVelZ]*nz;const double denominator=soundSpeed-vs;doppler=std::fabs(denominator)>1e-6?(soundSpeed-vl)/denominator:1;doppler=clamp(sanitize(doppler,1),.5,2);rangeRate=sanitize(vl-vs);}
   const double source=sanitize(gVoiceOutputs[(v*2)*kVoiceMaxFrames+i]),airframeNoise=v==0?sanitize(gVoiceOutputs[(v*2+1)*kVoiceMaxFrames+i]):0;
   double mono=source*gEngineGain+airframeNoise*gAirframeGain;
    // ---- propagation ----------------------------------------------------
    double direct = mono;
    if (spatialTier) {
      gDelay.write(mono);
      // Sound arriving now left the source when it was `wanted` seconds ago, so
      // the target solves tau = d(t - tau)/c, not d(t)/c. For constant velocity
      // that is d / (c + rangeRate); the denominator gets the same 0.5..2 guard
      // as the ratio itself. With a rigidly parented camera the range rate is 0
      // and this is the plain distance/c the app has always used.
      const double wanted = distance * gSampleRate
          / clamp(soundSpeed + rangeRate, soundSpeed * 0.5, soundSpeed * 2.0);
      // What the ear hears from a delay line is the RATE its read pointer
      // moves, so that rate is the modelled Doppler ratio and nothing else.
      // Distance sets where the tap sits, never how fast it travels.
      //
      // audioPose.ts reports a rigidly parented camera: it shares the
      // aircraft's velocity, so the ratio is 1 and the tap holds still. A
      // chase-camera zoom moves that same listener tens of metres between two
      // 60 Hz snapshots, and reading the new distance as travel made every
      // zoom an octave-wide pitch glide; a wide enough one walked the read
      // pointer backwards into reversed audio. A view is not a flight path, so
      // the tap now ignores it. Genuine motion still arrives through `doppler`,
      // which is what the exterior flyby fixture exercises. Measured either way
      // in docs/validation/evidence/audio/camera-zoom-med-2026-09-16.md.
      //
      // The tap is re-seated only at a declared discontinuity
      // (osfs_audio_set_epoch) and on a tier change, where a fade already
      // covers it.
      if (gDelaySeeded) {
        gDelaySamples += 1.0 - doppler;
        if (gDelayCrossfading) gDelayAlternate += 1.0 - doppler;
      } else {
        gDelaySamples = wanted;
        gDelayCrossfading = false;
        gDelayBlend = 0.0;
        gDelaySeeded = true;
      }
      // A pinned tap has read speed 1, so clamping it silently loses Doppler.
      // Before exhausting the finite history, crossfade onto another tap
      // travelling at the SAME Doppler ratio. Distance still never drives the
      // tap rate, preserving the no-pitch-bend camera zoom contract. This loses
      // exact long-range propagation age, not the sustained frequency shift.
      // Recentring is a bounded-history approximation, not sonic-boom physics.
      const double maxDelay = gSampleRate * 0.5 - 2.0;
      const double crossfadeFrames = gSampleRate * kTransitionFadeSeconds;
      const double guard = std::fabs(1.0 - doppler) * crossfadeFrames + 4.0;
      gDelaySamples = clamp(gDelaySamples, 1.0, maxDelay);
      if (!gDelayCrossfading && ((doppler < 1.0 && gDelaySamples > maxDelay - guard)
          || (doppler > 1.0 && gDelaySamples < 1.0 + guard))) {
        gDelayAlternate = maxDelay * 0.5;
        gDelayBlend = 0.0;
        gDelayCrossfading = true;
      }
      const double delaySamples = gDelaySamples;
      direct = gDelay.read(delaySamples);
      double alternateWeight = 0.0;
      double directWeight = 1.0;
      if (gDelayCrossfading) {
        gDelayBlend = std::fmin(1.0, gDelayBlend + 1.0 / crossfadeFrames);
        // Complementary raised-cosine weights never boost correlated taps.
        // Independent broadband energy can dip briefly, and periodic tones
        // can interfere: finite-history recentering is explicitly approximate.
        directWeight = 0.5 + 0.5 * std::cos(gDelayBlend * kPi);
        alternateWeight = 1.0 - directWeight;
        direct = direct * directWeight + gDelay.read(gDelayAlternate) * alternateWeight;
      }

      const double pathDifference = interpolated[electric?rotor+15:kGroundReflectionM];
      if (pathDifference >= 0.0) {
        // One ground-image reflection, gain <= 0.25 (sound.md §3). This tap
        // sits a path difference further back, so it reaches the cap first, and
        // it is the one that does fade: a reflection pinned to the cap would
        // comb at a path difference the geometry never asked for, and a wrong
        // comb is audible in a way a wrong absolute lag is not.
        const double reflectedDelay = delaySamples + pathDifference / soundSpeed * gSampleRate;
        const double reflectedFade = gRangeFade.process(
            1.0 - clamp01((reflectedDelay - ceilingDelay) / (gSampleRate * 0.06)));
        direct += gDelay.read(reflectedDelay) * 0.25 * reflectedFade * directWeight;
        if (gDelayCrossfading) {
          const double alternateReflected = gDelayAlternate + pathDifference / soundSpeed * gSampleRate;
          const double alternateFade = 1.0 - clamp01((alternateReflected - ceilingDelay) / (gSampleRate * 0.06));
          direct += gDelay.read(alternateReflected) * 0.25 * alternateFade * alternateWeight;
        }
      }
      if (gDelayCrossfading && gDelayBlend >= 1.0) {
        gDelaySamples = gDelayAlternate;
        gDelayCrossfading = false;
      }
    }

    // ---- installation colour and distance -------------------------------
    // Interior is not a free-field point source: the cockpit uses a fixed
    // -18 dB installation gain instead of the 1/d law, and the two land at a
    // comparable level near 10 m, so switching view is not a loudness jump.
    const double freeField = std::fmin(1.0, 1.0 / std::fmax(distance, 1e-3));
    const double cockpitGain=tier==kTierHigh?gHighInteriorGain:gInteriorGain;
    const double cockpitHz=tier==kTierHigh?gHighInteriorHz:gInteriorHz;
    const double absorption = clamp(18000.0 / (1.0 + distance / 200.0), 500.0, 18000.0);
    const double colourHz = gColourHz.process(cockpitHz + (absorption - cockpitHz) * exterior);
    // Without pose the source stays where it was last placed rather than
    // jumping to the listener, which would be a loud artefact.
    const double spatialGain =
        gSpatial.process(cockpitGain + (freeField - cockpitGain) * exterior);
    gColour.lowpass(gSampleRate, colourHz, 0.707);
    double coloured = gColour.process(direct) * spatialGain;

    // ---- cabin/airframe impulse response --------------------------------
    if (gConvolver.active()) {
      const double wet = gWetOut[gPartIndex];
      gWetIn[gPartIndex] = coloured;
      if (++gPartIndex >= kPartition) {
        gConvolver.process(gWetIn, gWetOut);
        gPartIndex = 0;
      }
      // High treats the generated IR as cockpit-only colour. Applying a cabin
      // IR to free-field jet sound would invent an installation at the mic.
      const double wetGain = electric ? 0.0 : 0.35 * (tier == kTierHigh ? 1.0 - exterior : 1.0);
      coloured = coloured * (1.0 - wetGain) + wet * wetGain;
    }

   const double pan=gPan.process(distance>1e-3?clamp(sx/std::fmax(distance,.5),-1,1):0),angle=(pan+1)*kPi*.25;
   left+=coloured*std::cos(angle)*kSqrt2*clamp01(pf.fade);right+=coloured*std::sin(angle)*kSqrt2*clamp01(pf.fade);
   if(v==0)tireField=1+(freeField-1)*exterior;
   gStats[kStatDoppler]=doppler;gStats[kStatDistance]=distance;
  }
  const double tire=gTire.process(gTireWatts)*gTireGain*tireField;left=(left+tire)*gMasterGain;right=(right+tire)*gMasterGain;gDynamics.process(left,right);gOutLeft[i]=static_cast<float>(left);gOutRight[i]=static_cast<float>(right);const double peak=std::fmax(std::fabs(left),std::fabs(right));if(peak>gStats[kStatPeak])gStats[kStatPeak]=peak;
 }
 gStats[kStatBlocks]+=1;gStats[kStatFrames]+=count;gStats[kStatQueueDepth]=gQueueCount;gStats[kStatFade]=gFade;gStats[kStatActiveGrains]=0;gStats[kStatGrainDrops]=0;
}
/** Compatibility mixer entry point; synthesis is supplied exclusively by family modules. */
OSFS_EXPORT void osfs_audio_process(double blockStartFrame,int frames){osfs_audio_prepare(blockStartFrame,frames);osfs_audio_mix(blockStartFrame,frames);}
