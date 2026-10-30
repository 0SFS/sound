import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { JSBSimSdk } from "@felipegalind0/jsbsim";
import type { OsfsModManifest } from "@0sfs/mods/schema";
import { installAudioMod } from "../src/installAudioMod";
import { getAircraftAudioInstallation, resolveAircraftAudioInstallation } from "../src/aircraftAudioProfiles";
import { createElectricAudioAdapter, type ElectricAudioFeed } from "../src/electricAudioAdapter";
import { toSnapshot } from "../src/jsbsimAudioAdapter";
import { AVAILABILITY, type AudioSnapshotInit, type ElectricRotorSnapshot } from "../src/audioSnapshot";
import { createDspHarness, rms, TIER } from "../src/dspHarness";
import { VOICE_INPUT, VOICE_INPUT_FIELDS, VOICE_MAX_FRAMES } from "@0sfs/engine-sound/voiceAbi";

const manifest = (repo: string): OsfsModManifest => JSON.parse(readFileSync(new URL(`../../${repo}/public/0sfs-mod.json`, import.meta.url), "utf8"));
function installation(repo = "DJI-Mini2", id = "dji-mini2") {
  for (const name of ["electric-sound", `${repo}-propulsion`, repo]) installAudioMod(manifest(name), { bundled: true });
  const result = resolveAircraftAudioInstallation(getAircraftAudioInstallation(id));
  if (!result.supported) throw new Error(result.reason);
  return result;
}
const availability = AVAILABILITY.ELECTRIC_ROTORS | AVAILABILITY.DENSITY | AVAILABILITY.POSE;
function rotor(rpm: number, source: readonly [number, number, number] = [0, 0, 1]): ElectricRotorSnapshot {
  return { rpm, thrustN: 0.65, shaftTorqueNm: 0.003, inducedVelocityMps: 3, vrs: 0,
    valid: true, source, sourceVelocity: [0, 0, 0], sourceAxis: [0, 1, 0], groundReflectionM: -1 };
}

async function render(options: {
  speeds?: number[]; tier?: number; positions?: readonly (readonly [number, number, number])[];
  availability?: number; invalidAfter?: number; clearBitAfter?: number; seconds?: number;
  sampleRate?: number; repo?: string; aircraftId?: string;
} = {}) {
  const resolved = installation(options.repo, options.aircraftId);
  const profile = { ...resolved.source.definition, parameters: {
    ...(resolved.source.definition.parameters as Record<string, number>), broadbandGain: 0, mechanicalGain: 0,
  } };
  const core = await createDspHarness({ sampleRate: options.sampleRate ?? 48000, profile, family: "electric", voiceCount: 4 });
  core.exports.osfs_audio_set_tier(options.tier ?? TIER.med);
  core.exports.osfs_audio_set_gains(1, 1, 0, 0, 0);
  core.anchor(1, 0);
  let sequence = 0;
  let next = 0;
  const output = core.renderSeconds(options.seconds ?? 0.45, frame => {
    const time = frame / core.sampleRate;
    if (time < next) return;
    const rotors = (options.speeds ?? [6000, 6600, 7200, 7800]).map((rpm, index) => ({
      ...rotor(rpm, options.positions?.[index]), valid: !(time >= (options.invalidAfter ?? Infinity)),
    }));
    const snapshot: AudioSnapshotInit = { sequence: sequence++, epoch: 1, simTimeS: time,
      availability: time >= (options.clearBitAfter ?? Infinity) ? AVAILABILITY.POSE : options.availability ?? availability,
      source: [0, 0, 1], sourceVelocity: [0, 0, 0], listenerVelocity: [0, 0, 0], exterior: 1,
      soundSpeedMps: 343, groundReflectionM: -1, electricRotors: rotors,
      airDensityKgM3: 1.225, airVelocityBodyMps: [0, 0, 0], armed: true };
    core.pushSnapshot(snapshot);
    next += 1 / 60;
  });
  return { core, output, tail: output.left.subarray(Math.round(core.sampleRate * 0.2)) };
}
function amplitude(samples: Float32Array, frequency: number, rate = 48000) {
  let real = 0; let imaginary = 0;
  for (let i = 0; i < samples.length; i++) {
    const angle = 2 * Math.PI * frequency * i / rate;
    real += samples[i] * Math.cos(angle); imaginary += samples[i] * Math.sin(angle);
  }
  return Math.hypot(real, imaginary) / samples.length;
}

describe("four-rotor electric synthesis through the shipped family and shared host", () => {
  it.each([["DJI-Mini2", "dji-mini2"], ["DJI-Air-2S", "dji-air2s"]])("admits %s as four physical sources with mod-owned geometry", (repo, id) => {
    const resolved = installation(repo, id);
    expect(resolved.sources.map(s => s.installation.id)).toEqual(["front-left", "front-right", "rear-left", "rear-right"]);
    expect(resolved.sources.every(s => s.installation.position.kind === "rotor")).toBe(true);
    expect(resolved.source.definition.engineClass).toBe("electric");
    expect(resolved.renderer.id).toBe("procedural-electric-v1");
    expect(resolved.source.definition.parameters).toMatchObject(repo === "DJI-Mini2"
      ? { radiusM: 0.0597, blades: 2, maxRpm: 13300 }
      : { radiusM: 0.0917, blades: 2, maxRpm: 9200 });
  });

  it("renders all four blade-passage frequencies and changing one rotor moves only its spectral line", async () => {
    const baseline = await render();
    const changed = await render({ speeds: [6000, 6600, 9000, 7800] });
    for (const frequency of [200, 220, 240, 260]) expect(amplitude(baseline.tail, frequency)).toBeGreaterThan(0.003);
    for (const frequency of [200, 220, 260]) {
      expect(amplitude(changed.tail, frequency)).toBeCloseTo(amplitude(baseline.tail, frequency), 3);
    }
    expect(amplitude(changed.tail, 240)).toBeLessThan(amplitude(baseline.tail, 240) * 0.05);
    expect(amplitude(changed.tail, 300)).toBeGreaterThan(0.01);
    expect(baseline.core.exports.osfs_audio_source_count()).toBe(4);
    expect(baseline.core.stats().nonFinite).toBe(0);
    expect(baseline.core.stats().irMs).toBe(0);
  });

  it.each([[TIER.low, 4, 5], [TIER.med, 12, 6]])("preserves four motor fundamentals within installation tier %s budgets", async (tier, partials, noiseBands) => {
    const sound = await render({ tier });
    for (const frequency of [200, 220, 240, 260]) expect(amplitude(sound.tail, frequency)).toBeGreaterThan(0.002);
    const prepared = new Float64Array(sound.core.exports.memory.buffer, sound.core.exports.osfs_audio_voice_input_ptr(), 4 * VOICE_MAX_FRAMES * VOICE_INPUT_FIELDS.length);
    const sum = (field: number) => [0, 1, 2, 3].reduce((total, voice) => total + prepared[voice * VOICE_MAX_FRAMES * VOICE_INPUT_FIELDS.length + field], 0);
    expect(sum(VOICE_INPUT.partials)).toBe(partials);
    expect(sum(VOICE_INPUT.noiseBands)).toBe(noiseBands);
    expect(sound.core.stats()).toMatchObject({ partials, noiseBands });
  });

  it.each([TIER.med, TIER.high])("spatializes the active rotor's own position at tier %s", async tier => {
    const left = await render({ tier, speeds: [6000, 0, 0, 0], positions: [[-1, 0, 1], [1, 0, 1], [0, 0, 1], [0, 0, 1]] });
    const right = await render({ tier, speeds: [0, 6000, 0, 0], positions: [[-1, 0, 1], [1, 0, 1], [0, 0, 1], [0, 0, 1]] });
    const start = Math.round(0.2 * 48000);
    expect(rms(left.output.left, start)).toBeGreaterThan(rms(left.output.right, start) * 2);
    expect(rms(right.output.right, start)).toBeGreaterThan(rms(right.output.left, start) * 2);
  });

  it("keeps stopped, missing and invalid rotors silent without falling back to a native engine", async () => {
    expect(rms((await render({ speeds: [0, 0, 0, 0] })).tail)).toBe(0);
    expect(rms((await render({ availability: AVAILABILITY.POSE })).tail)).toBe(0);
    for (const options of [{ invalidAfter: 0.15 }, { clearBitAfter: 0.15 }]) {
      const sound = await render({ ...options, seconds: 0.6 });
      expect(rms(sound.output.left, 5000, 6500)).toBeGreaterThan(0.001);
      expect(rms(sound.output.left, 24000)).toBeLessThan(1e-8);
    }
  });

  it("fades invalid live rotor data without a source discontinuity", async () => {
    const sound = await render({ invalidAfter: 0.15, seconds: 0.35, speeds: [6000, 0, 0, 0], tier: TIER.low });
    let jump = 0;
    for (let i = 6500; i < 12000; i++) jump = Math.max(jump, Math.abs(sound.output.left[i] - sound.output.left[i - 1]));
    expect(jump).toBeLessThan(0.0015);
    expect(rms(sound.output.left, 14400)).toBeLessThan(1e-8);
  });

  it("stale physics fades all sources, then a stopped new epoch clears delayed audio", async () => {
    const sound = await render({ seconds: 0.25 });
    const stale = sound.core.renderSeconds(0.6);
    expect(rms(stale.left, 24000)).toBeLessThan(1e-8);
    expect(sound.core.stats().staleFades).toBeGreaterThan(0);
    sound.core.anchor(2, 0);
    let next = 0; let sequence = 0;
    const stopped = sound.core.renderSeconds(0.4, frame => {
      const time = frame / sound.core.sampleRate;
      if (time < next) return;
      sound.core.pushSnapshot({ sequence: sequence++, epoch: 2, simTimeS: time - 0.85, availability,
        electricRotors: [rotor(0), rotor(0), rotor(0), rotor(0)], airDensityKgM3: 1.225,
        airVelocityBodyMps: [0, 0, 0], source: [0, 0, 1], exterior: 1 });
      next = time + 1 / 60;
    });
    expect(rms(stopped.left, 12000)).toBeLessThan(1e-8);
    expect(sound.core.stats().epoch).toBe(2);
  });
});

describe("electric telemetry adapter freshness and ownership", () => {
  function setup() {
    const resolved = installation();
    let time = 1;
    let failNative = false;
    let failFeed = false;
    let feed: ElectricAudioFeed | null = { aircraftId: "dji-mini2", valid: true, armed: true,
      simTimeS: 1, airDensityKgM3: 1.225, airVelocityBodyMps: [2, 0, -1],
      rotors: [rotor(6000), rotor(6600), rotor(7200), rotor(7800)] };
    const dispose = vi.fn();
    const batch = { read(target: Float64Array) {
      if (failNative) throw new Error("native read failure");
      target.set([time, 3, -2, 1, 1125]);
    }, dispose };
    const sdk = { createPropertyBatch: vi.fn(() => batch) } as unknown as JSBSimSdk;
    const adapter = createElectricAudioAdapter(sdk, { aircraftId: "dji-mini2", gearHeightMetres: 0.04,
      sources: resolved.sources, readTelemetry() { if (failFeed) throw new Error("feed failure"); return feed; } });
    return { adapter, sdk, dispose, get feed() { return feed!; }, set feed(value: ElectricAudioFeed | null) { feed = value; },
      set time(value: number) { time = value; }, set failNative(value: boolean) { failNative = value; }, set failFeed(value: boolean) { failFeed = value; } };
  }
  it("reads four fresh motors without native engine properties and preserves electric snapshot fields", () => {
    const state = setup();
    const reading = state.adapter.read();
    expect(reading.availability & AVAILABILITY.ELECTRIC_ROTORS).not.toBe(0);
    expect(reading.availability & (AVAILABILITY.N1 | AVAILABILITY.N2 | AVAILABILITY.FUEL_FLOW)).toBe(0);
    expect(reading.electricRotors?.map(r => r.rpm)).toEqual([6000, 6600, 7200, 7800]);
    expect(state.sdk.createPropertyBatch).toHaveBeenCalledWith(expect.not.arrayContaining([expect.stringContaining("propulsion/engine")]), { create: false });
    expect(state.adapter.diagnostics.sourceOffsets).toHaveLength(4);
    expect(state.adapter.diagnostics.sourceOffsets?.[0][0]).toBeCloseTo(0.0877);
    const snapshot = toSnapshot(reading, { sequence: 1, epoch: 1, source: [0, 0, 1], sourceVelocity: [0, 0, 0],
      listenerVelocity: [0, 0, 0], exterior: 1, groundReflectionM: -1, poseValid: true });
    expect(snapshot.electricRotors?.map(r => r.rpm)).toEqual([6000, 6600, 7200, 7800]);
    expect(snapshot.airDensityKgM3).toBe(1.225);
    expect(snapshot.armed).toBe(true);
    state.adapter.dispose(); state.adapter.dispose();
    expect(state.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong aircraft", "stale", "missing", "native failure", "feed failure", "invalid"])("invalidates %s and recovers with a fresh valid frame", reason => {
    const state = setup();
    expect(state.adapter.read().availability & AVAILABILITY.ELECTRIC_ROTORS).not.toBe(0);
    const valid = structuredClone(state.feed);
    if (reason === "wrong aircraft") state.feed = { ...valid, aircraftId: "dji-air2s" };
    if (reason === "stale") state.time = 1.2;
    if (reason === "missing") state.feed = null;
    if (reason === "native failure") state.failNative = true;
    if (reason === "feed failure") state.failFeed = true;
    if (reason === "invalid") state.feed = { ...valid, valid: false };
    const invalid = state.adapter.read();
    expect(invalid.availability & AVAILABILITY.ELECTRIC_ROTORS).toBe(0);
    expect(invalid.electricRotors?.every(r => !r.valid && r.rpm === 0)).toBe(true);
    expect(state.adapter.diagnostics.telemetryAvailable).toBe(false);
    state.feed = valid; state.time = 1; state.failNative = false; state.failFeed = false;
    expect(state.adapter.read().availability & AVAILABILITY.ELECTRIC_ROTORS).not.toBe(0);
    expect(state.adapter.diagnostics.telemetryAvailable).toBe(true);
    state.adapter.dispose();
  });
});
