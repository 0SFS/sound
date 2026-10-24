import { describe, expect, it } from "vitest";
import { AVAILABILITY, type AudioSnapshotInit } from "../src/audioSnapshot";
import { createDspHarness, difference, rms, TIER } from "../src/dspHarness";
import { IO320_ACOUSTICS, IO320_DEFINITION, type PistonAcousticProfile } from "../src/engineAcousticDefinitions";

const native = AVAILABILITY.ENGINE_RPM | AVAILABILITY.PROPELLER_RPM | AVAILABILITY.SHAFT_POWER
  | AVAILABILITY.COMBUSTION | AVAILABILITY.FUEL_FLOW | AVAILABILITY.POSE;

async function render(options: {
  sampleRate?: number; tier?: number; engineRpm?: number; propellerRpm?: number; powerHp?: number;
  combustion?: boolean; availability?: number; parameters?: Partial<PistonAcousticProfile>;
} = {}) {
  const sampleRate = options.sampleRate ?? 48_000;
  const core = await createDspHarness({ sampleRate });
  core.setProfile({ ...IO320_DEFINITION, parameters: { ...IO320_ACOUSTICS, ...options.parameters } });
  core.exports.osfs_audio_set_tier(options.tier ?? TIER.low);
  core.exports.osfs_audio_set_gains(1, 1, 0, 0, 0);
  core.anchor(1, 0);
  let next = 0, sequence = 0;
  const output = core.renderSeconds(0.85, frame => {
    const time = frame / sampleRate;
    if (time < next) return;
    const snapshot: AudioSnapshotInit = {
      sequence: sequence++, epoch: 1, simTimeS: time, availability: options.availability ?? native,
      engineRpm: options.engineRpm ?? 1800, propellerRpm: options.propellerRpm ?? 1800,
      shaftPowerHp: options.powerHp ?? 80, fuelFlowPps: 0.015, combustion: options.combustion ?? true,
      source: [0, 0, 1], soundSpeedMps: 343, exterior: 1, groundReflectionM: -1,
    };
    core.pushSnapshot(snapshot);
    next += 1 / 60;
  });
  return { core, output: output.left, tail: output.left.subarray(Math.round(sampleRate * 0.35)), sampleRate };
}

/** Coherent amplitude at a requested shaft order; no FFT-bin rounding. */
function amplitude(signal: Float32Array, frequency: number, sampleRate: number): number {
  let real = 0, imaginary = 0;
  for (let i = 0; i < signal.length; i++) {
    const angle = 2 * Math.PI * frequency * i / sampleRate;
    real += signal[i] * Math.cos(angle);
    imaginary += signal[i] * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / signal.length;
}

const tonesOnly: Partial<PistonAcousticProfile> = {
  propellerGain: 0, mechanicalGain: 0, exhaustNoiseGain: 0, propellerNoiseGain: 0,
};

describe("IO320 piston and propeller synthesis in the shipped WASM", () => {
  it.each([44_100, 48_000])("renders finite, audible native piston inputs at every tier at %i Hz", async sampleRate => {
    for (const tier of [TIER.low, TIER.med, TIER.high]) {
      const sound = await render({ sampleRate, tier });
      expect(sound.output.every(Number.isFinite)).toBe(true);
      expect(rms(sound.tail)).toBeGreaterThan(0.01);
      expect(sound.core.stats()).toMatchObject({ nonFinite: 0, activeGrains: 0, tier });
    }
  });

  it("tracks four-cylinder four-stroke firing from crankshaft RPM without any N1/N2 telemetry", async () => {
    const idle = await render({ engineRpm: 900, parameters: tonesOnly });
    const fast = await render({ engineRpm: 1800, parameters: tonesOnly });
    // Four cylinders fire twice per revolution: 900 RPM => 30 Hz, 1800 => 60 Hz.
    expect(amplitude(idle.tail, 30, idle.sampleRate)).toBeGreaterThan(0.1);
    expect(amplitude(fast.tail, 60, fast.sampleRate)).toBeGreaterThan(0.1);
    expect(amplitude(fast.tail, 30, fast.sampleRate)).toBeLessThan(0.003);
  });

  it("tracks the independently observed propeller shaft and two blade passages per revolution", async () => {
    const sound = await render({ engineRpm: 900, propellerRpm: 1500, parameters: {
      ...tonesOnly, firingGain: 0, propellerGain: 1,
    } });
    expect(amplitude(sound.tail, 50, sound.sampleRate)).toBeGreaterThan(0.05);
    expect(amplitude(sound.tail, 30, sound.sampleRate)).toBeLessThan(0.003);
  });

  it("gates firing by native combustion and leaves rotating propeller/machinery audible", async () => {
    const firingOff = await render({ combustion: false, parameters: tonesOnly });
    expect(rms(firingOff.tail)).toBeLessThan(1e-6);
    const windmilling = await render({ combustion: false });
    expect(rms(windmilling.tail)).toBeGreaterThan(0.01);
    const stopped = await render({ engineRpm: 0, propellerRpm: 0, powerHp: 0, combustion: false });
    expect(rms(stopped.tail)).toBe(0);
  });

  it("uses shaft load for firing/noise level, clears missing shafts, and adds bounded detail above Low", async () => {
    const idle = await render({ powerHp: 0 });
    const power = await render({ powerHp: 150 });
    expect(rms(power.tail)).toBeGreaterThan(rms(idle.tail) * 1.5);
    const missing = await render({ availability: native & ~(AVAILABILITY.ENGINE_RPM | AVAILABILITY.PROPELLER_RPM) });
    expect(rms(missing.tail)).toBe(0);
    const med = await render({ tier: TIER.med });
    const low = await render();
    expect(rms(difference(med.tail, low.tail))).toBeGreaterThan(0.01);
    const repeat = await render({ tier: TIER.med });
    expect(repeat.output).toEqual(med.output);
  });
});
