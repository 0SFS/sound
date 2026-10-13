// SPDX-License-Identifier: AGPL-3.0-only
// The offline render that check-engine-profile-reference.mjs compares, kept
// free of other repositories so fly's tests can import it as
// @0sfs/sound/validation/engineProfileReference.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readAbi } from "../../../benchmarks/audio/renderSweep.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export const REFERENCE_CASES = [44_100, 48_000].flatMap(sampleRate =>
  [1, 2].flatMap(tier => [0, 1].map(exterior => ({ sampleRate, tier, exterior }))));

/** Starts, changes power/configuration and winds down, with native SF50 units. */
export function referenceState(time, exterior) {
  const power = Math.min(1, time / 0.45);
  const burning = time >= 0.12 && time < 0.62;
  return {
    n1Pct: 24.3 + 70 * power, n2Pct: 53.4 + 43 * power,
    thrustLbf: burning ? 1846 * power : 0, fuelFlowPps: burning ? 0.0211 + 0.22 * power : 0,
    combustion: +burning, running: +(time >= 0.25 && burning), starter: +(time < 0.2), cutoff: +!burning,
    throttleNorm: power, kias: 210 * power, gearNorm: 1 - power, flapNorm: power * 0.5,
    sourceX: exterior ? 4 : 0, sourceY: exterior ? 2 : 0.96, sourceZ: exterior ? -12 : -4.06,
    sourceVelX: 0, sourceVelY: 0, sourceVelZ: 0, listenerVelX: 0, listenerVelY: 0, listenerVelZ: 0,
    soundSpeedMps: 343, exterior, groundReflectionM: exterior ? 4 : -1, augmentation: 0,
  };
}

/** Drives either the legacy or new ABI from that module's own retained header. */
export async function renderReference(wasmPath, headerPath, options) {
  const abi = readAbi(readFileSync(headerPath, "utf8"));
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, { env: { emscripten_notify_memory_growth() {} } });
  const dsp = instance.exports;
  dsp._initialize();
  if (!dsp.osfs_audio_init(options.sampleRate, 128, 0x53463530)) throw new Error("DSP refused fixture");
  dsp.osfs_audio_set_tier(options.tier);
  dsp.osfs_audio_set_gains(1, 1, 1, 1, 0);
  dsp.osfs_audio_set_tire(900);
  dsp.osfs_audio_set_epoch(1, 0, 0);
  const batch = new Float64Array(dsp.memory.buffer, dsp.osfs_audio_batch_ptr(), abi.batchLength);
  const frames = Math.round(options.sampleRate * 0.8);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let nextPublish = 0;
  let sequence = 0;
  for (let offset = 0; offset < frames; offset += 128) {
    const time = offset / options.sampleRate;
    while (nextPublish <= time + 0.1) {
      batch.fill(0);
      batch[0] = 1;
      const state = { ...referenceState(nextPublish, options.exterior), version: abi.version,
        sequence: ++sequence, epoch: 1, simTimeS: nextPublish,
        availability: abi.allAvailability };
      for (const [field, slot] of Object.entries(abi.slot)) batch[abi.batchHeader + slot] = state[field] ?? 0;
      dsp.osfs_audio_commit_batch();
      nextPublish += 1 / 60;
    }
    const count = Math.min(128, frames - offset);
    dsp.osfs_audio_process(offset, count);
    left.set(new Float32Array(dsp.memory.buffer, dsp.osfs_audio_out(0), count), offset);
    right.set(new Float32Array(dsp.memory.buffer, dsp.osfs_audio_out(1), count), offset);
  }
  return { left, right, outputSha256: hash(Buffer.concat([Buffer.from(left.buffer), Buffer.from(right.buffer)])),
    wasmSha256: hash(bytes) };
}
