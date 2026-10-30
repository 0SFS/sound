#!/usr/bin/env node
/** Compare a retained pre-extraction binary with the independent family pipeline. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFamilyPipeline } from "./familyPipeline.mjs";
import { readAbi } from "../../../benchmarks/audio/renderSweep.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.split("=")[1];
if (!baseline) throw new Error("Pass --baseline=/path/to/pre-extraction/audio-dsp.wasm");
const abi = readAbi(readFileSync(path.join(root, "src/snapshot.h"), "utf8"));
const shared = readFileSync(new URL("../../../../engine-sound/src/legacyProfile.ts", import.meta.url), "utf8");
const fields = name => [...shared.split(`export const ${name} = [`)[1].split("] as const")[0].matchAll(/"([^"]+)"/g)].map(m => m[1]);
const jets = fields("JET_ACOUSTIC_PROFILE_FIELDS"), pistons = fields("PISTON_ACOUSTIC_PROFILE_FIELDS");
async function render(wasm, engine, sampleRate, tier) {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasm), { env: { emscripten_notify_memory_growth() {} } });
  const x = instance.exports;
  x._initialize();
  x.osfs_audio_init(sampleRate, 128, 0x53463530);
  const current = typeof x.osfs_audio_prepare === "function";
  const profile = JSON.parse(readFileSync(new URL(`../../../../${engine}/public/0sfs-mod.json`, import.meta.url))).engine.acousticProfile;
  const p = profile.parameters, piston = engine === "IO320";
  if (!current) {
    const values = [...jets.map(k => piston ? 0 : p[k]), piston ? 1 : 0, ...pistons.map(k => piston ? p[k] : 0)];
    new Float64Array(x.memory.buffer, x.osfs_audio_profile_ptr(), values.length).set(values);
    if (!x.osfs_audio_commit_profile()) throw new Error("Baseline profile refused");
  }
  const pipeline = await createFamilyPipeline(x, { sampleRate, engine });
  x.osfs_audio_set_tier(tier);
  x.osfs_audio_set_gains(1, 1, 0, 1, 0);
  x.osfs_audio_set_epoch(1, 0, 0);
  const size = x.osfs_audio_snapshot_size(), length = x.osfs_audio_batch_length();
  const frames = Math.round(sampleRate * 1.3), outputs = [new Float32Array(frames), new Float32Array(frames)];
  let next = 0, sequence = 0, changed = false;
  for (let offset = 0; offset < frames; offset += 128) {
    const t = offset / sampleRate;
    if (!changed && t >= 0.35) { changed = true; x.osfs_audio_set_tier(tier === 1 ? 2 : 1); }
    // Stop publication after .7 s to exercise the common stale fade.
    while (next <= t + 0.1 && next <= 0.7) {
      const power = Math.min(1, next / 0.4), burning = next > 0.08 && next < 0.6;
      const batch = new Float64Array(x.memory.buffer, x.osfs_audio_batch_ptr(), length);
      batch.fill(0); batch[0] = 1;
      const state = { version: current ? 6 : 5, sequence: ++sequence, epoch: 1, simTimeS: next, availability: 0xffff,
        n1Pct: 20 + 75 * power, n2Pct: 40 + 58 * power,
        thrustLbf: p.thrustReferenceLbf * power || 0, fuelFlowPps: burning ? (p.fuelReferencePps || 0.02) * power : 0,
        combustion: +burning, running: +burning, starter: +(next < 0.1), cutoff: +!burning,
        engineRpm: 2700 * power, propellerRpm: 2600 * power, shaftPowerHp: 160 * power,
        kias: 90 * power, gearNorm: 1, flapNorm: power * 0.2,
        sourceX: 4 + next * 3, sourceY: 2, sourceZ: -12, soundSpeedMps: 343, exterior: 1,
        sourceAxisZ: 1, groundReflectionM: 4, augmentation: +(next > 0.3),
        afterburnerBurnedFuelFlowKgSec: engine === "F135" && next > 0.3 ? 2 * power : 0 };
      for (const [field, slot] of Object.entries(abi.slot)) if (slot < size) batch[abi.batchHeader + slot] = state[field] ?? 0;
      x.osfs_audio_commit_batch(); next += 1 / 60;
    }
    const count = Math.min(128, frames - offset);
    pipeline.process(offset, count);
    for (let ch = 0; ch < 2; ch++) outputs[ch].set(new Float32Array(x.memory.buffer, x.osfs_audio_out(ch), count), offset);
  }
  return outputs;
}
const cases = [];
for (const engine of ["FJ33", "F135", "IO320"]) for (const rate of [44100, 48000]) for (const tier of [1, 2, 3]) {
  const old = await render(path.resolve(baseline), engine, rate, tier);
  const fresh = await render(path.join(root, "src/audio-dsp.wasm"), engine, rate, tier);
  let maxError = 0, squared = 0;
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < old[ch].length; i++) {
    const error = Math.abs(old[ch][i] - fresh[ch][i]); maxError = Math.max(maxError, error); squared += error * error;
  }
  cases.push({ engine, rate, tier, maxError, rmsError: Math.sqrt(squared / (2 * old[0].length)) });
}
const report = { passed: cases.every(c => c.maxError <= 1e-7), tolerance: 1e-7,
  scenario: "startup, native power and combustion, F135 reheat, view range change, tier transition, stale fade", cases };
mkdirSync(path.join(root, "build/family-extraction"), { recursive: true });
writeFileSync(path.join(root, "build/family-extraction/report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
