import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { acousticProfileValues } from "../src/aircraftAudioProfiles";
import { FJ33_DEFINITION, F135_DEFINITION } from "./fixtures/engineProfiles";

/** Real plain-JS wrapper + shipped WASM in Node, not an audio-thread/device check. */
async function create(initial?: number[]) {
  const module = await WebAssembly.compile(readFileSync("../sound/src/audio-dsp.wasm"));
  const voiceModule = await WebAssembly.compile(readFileSync("../turbine-sound/public/audio/turbine-sound/voice.wasm"));
  let Processor: new (options: object) => {
    ready: boolean;
    failure: string | null;
    voice: { memory: WebAssembly.Memory; osfs_voice_profile_ptr(index:number): number; osfs_voice_profile_size(): number };
    onMessage(event: { data: object }): void;
    process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  };
  const messages: object[] = [];
  class AudioWorkletProcessor {
    port = { onmessage: null, postMessage(message: object) { messages.push(message); } };
  }
  runInNewContext(readFileSync("../sound/src/dspProcessor.js", "utf8"), {
    AudioWorkletProcessor, WebAssembly, Float32Array, Float64Array, Int32Array,
    sampleRate: 48_000, currentFrame: 0,
    registerProcessor(_name: string, implementation: typeof Processor) { Processor = implementation; },
  });
  const processor = new Processor!({ processorOptions: { module, voiceModule, initial: {
    profile: initial, tier: 1,
    gains: { master: 0.7, engine: 0.8, airframe: 0.6, tire: 0, reducedRange: 0, afterburner: 0.5 },
  } } });
  return { processor, messages };
}

describe("real worklet setup wrapper with actual WASM (Node, no device qualification)", () => {
  it("applies F135 setup before the first quantum and restores FJ33 on replacement", async () => {
    const fighter = acousticProfileValues(F135_DEFINITION);
    const { processor, messages } = await create(fighter);
    expect(processor.ready).toBe(true);
    expect(messages).toContainEqual({ type: "ready", sampleRate: 48_000 });
    const setup = () => [...new Float64Array(processor.voice.memory.buffer,
      processor.voice.osfs_voice_profile_ptr(0), processor.voice.osfs_voice_profile_size())];
    expect(setup()).toEqual(fighter);
    const output = [[new Float32Array(128), new Float32Array(128)]];
    expect(processor.process([], output)).toBe(true);
    expect(output[0][0].every(Number.isFinite)).toBe(true);
    processor.onMessage({ data: { type: "gains", master: 0.7, engine: 0.8,
      airframe: 0.6, tire: 0, reducedRange: 0, afterburner: 0 } });
    expect(setup()).toEqual(fighter);
    expect(processor.process([], output)).toBe(true);
    processor.onMessage({ data: { type: "profile", values: acousticProfileValues(FJ33_DEFINITION) } });
    expect(setup()).toEqual(acousticProfileValues(FJ33_DEFINITION));
  });

  it("refuses a mismatched setup ABI during boot", async () => {
    const { processor, messages } = await create([1, 2, 3]);
    expect(processor.ready).toBe(false);
    expect(processor.failure).toMatch(/profile ABI mismatch/);
    expect(messages).toContainEqual({ type: "failed", reason: "Acoustic profile ABI mismatch" });
  });

  it("stops output rather than retaining the old engine after an invalid replacement", async () => {
    const { processor, messages } = await create(acousticProfileValues(FJ33_DEFINITION));
    const invalid = acousticProfileValues(F135_DEFINITION);
    invalid[0] = 100;
    processor.onMessage({ data: { type: "profile", values: invalid } });
    expect(processor.ready).toBe(false);
    expect(messages).toContainEqual({ type: "failed", reason: "Invalid acoustic profile" });
    const output = [[new Float32Array(128).fill(1), new Float32Array(128).fill(1)]];
    expect(processor.process([], output)).toBe(false);
    expect(output[0][0].every(value => value === 0)).toBe(true);
  });

  it("echoes the bank request identity with the actual native allocation result", async () => {
    const { processor, messages } = await create(acousticProfileValues(FJ33_DEFINITION));
    processor.onMessage({ data: { type: "band", requestId: 41, index: 0, frames: 10, n1: 0.5,
      exterior: 0, samples: new Float32Array(10).buffer } });
    expect(messages).toContainEqual({ type: "band", requestId: 41, index: 0, accepted: true });
    processor.onMessage({ data: { type: "band", requestId: 42, index: 6, frames: 10, n1: 0.5,
      exterior: 0, samples: new Float32Array(10).buffer } });
    expect(messages).toContainEqual({ type: "band", requestId: 42, index: 6, accepted: false });
  });
});
