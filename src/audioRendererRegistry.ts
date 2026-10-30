import { OwnedRegistry } from "@0sfs/mods/ownedRegistry";
import { ENGINE_VOICE_ABI } from "@0sfs/engine-sound/voiceAbi";
import { acousticProfileValues } from "@0sfs/turbine-sound/profile";
import { pistonProfileValues } from "@0sfs/piston-sound/profile";
import { electricProfileValues } from "@0sfs/electric-sound/profile";
import { turbineVoiceWasmUrl } from "@0sfs/turbine-sound/assets";
import { pistonVoiceWasmUrl } from "@0sfs/piston-sound/assets";
import { electricSoundWasmUrl as electricVoiceWasmUrl } from "@0sfs/electric-sound/assets";
import { audioDspWasmUrl, audioWorkletUrl } from "./audioAssets";
import { AUDIO_SNAPSHOT_VERSION } from "./audioSnapshot";
import type { EngineAcousticDefinition } from "./engineAcousticDefinitions";

export interface InstallationColor { sourceType?: "electric" | "native"; count: number; interiorGain: number; interiorHz: number; highInteriorGain: number; highInteriorHz: number }
export interface AudioRendererRegistration {
  readonly id: string;
  readonly wasmUrl: URL;
  readonly voiceWasmUrl?: URL;
  readonly voiceSha256?: string;
  readonly workletUrl: URL;
  readonly processorName: string;
  readonly abi: { readonly id: string; readonly snapshotVersion: number };
  readonly voiceAbi?: string;
  readonly maxEngineSources: number;
  readonly telemetrySchemaIds: readonly string[];
  readonly engineClasses: readonly string[];
  readonly acousticStatus: "approximate-unvalidated";
  readonly highSynthesis?: "procedural";
  encodeParameters(definition: EngineAcousticDefinition): number[];
  installationColor(definition: EngineAcousticDefinition, count: number): InstallationColor;
}
export const AUDIO_HOST_RENDERER: AudioRendererRegistration = {
  id: "audio-host-v6", wasmUrl: audioDspWasmUrl, workletUrl: audioWorkletUrl, processorName: "osfs-dsp",
  abi: { id: "osfs-audio-dynamics-v6", snapshotVersion: AUDIO_SNAPSHOT_VERSION }, maxEngineSources: 0,
  telemetrySchemaIds: [], engineClasses: [], acousticStatus: "approximate-unvalidated",
  encodeParameters() { throw new Error("The audio host has no source profile."); },
  installationColor: (_definition, count) => ({ count, interiorGain: 1, interiorHz: 18000, highInteriorGain: 1, highInteriorHz: 18000 }),
};
const color = (definition: EngineAcousticDefinition, count: number): InstallationColor => {
  const p = definition.parameters as Record<string, number>;
  if (definition.engineClass === "piston") return { count, interiorGain: p.pistonCockpitGain, interiorHz: p.pistonCockpitHz,
    highInteriorGain: p.pistonCockpitGain, highInteriorHz: p.pistonCockpitHz };
  if (definition.engineClass === "electric") return { ...AUDIO_HOST_RENDERER.installationColor(definition, count), sourceType: "electric" };
  return { count, interiorGain: 0.12589254117941673, interiorHz: 1200, highInteriorGain: p.highCockpitGain, highInteriorHz: p.highCockpitHz };
};
const common = { ...AUDIO_HOST_RENDERER, voiceAbi: ENGINE_VOICE_ABI, installationColor: color,
  highSynthesis: "procedural" as const };
const FAMILIES: Record<string, AudioRendererRegistration> = {
  "procedural-jet-v1": { ...common, id: "procedural-jet-v1", voiceWasmUrl: turbineVoiceWasmUrl, maxEngineSources: 1,
    telemetrySchemaIds: ["jsbsim-turbine-v1", "jsbsim-thermal-turbine-v1"], engineClasses: ["turbofan"], encodeParameters: acousticProfileValues },
  "procedural-piston-v1": { ...common, id: "procedural-piston-v1", voiceWasmUrl: pistonVoiceWasmUrl, maxEngineSources: 1,
    telemetrySchemaIds: ["jsbsim-piston-v1"], engineClasses: ["piston"], encodeParameters: pistonProfileValues },
  "procedural-electric-v1": { ...common, id: "procedural-electric-v1", voiceWasmUrl: electricVoiceWasmUrl, maxEngineSources: 4,
    telemetrySchemaIds: ["multirotor-electric-v1"], engineClasses: ["electric"], encodeParameters: electricProfileValues },
};
export const AUDIO_RENDERERS: Record<string, AudioRendererRegistration> = {};
const registrations = new OwnedRegistry<AudioRendererRegistration>();
export function unregisterAudioRenderer(id: string, owner?: string): void {
  registrations.remove(id, owner);
  const remaining = registrations.get(id);
  if (remaining) AUDIO_RENDERERS[id] = remaining;
  else delete AUDIO_RENDERERS[id];
}
export const getAudioRenderer = (id: string): AudioRendererRegistration | undefined =>
  Object.hasOwn(AUDIO_RENDERERS, id) ? AUDIO_RENDERERS[id] : undefined;

/** Built-in families keep bundler-resolved URLs; downloaded replacements use their own mod directory. */
export function registerAudioRenderer(contribution: {
  rendererId: string; abi: string; engineClasses: readonly string[]; telemetrySchemaIds: readonly string[];
  wasm: { path: string; sha256: string };
}, moduleUrl?: URL, owner?: string): void {
  const family = FAMILIES[contribution.rendererId];
  if (!family || contribution.abi !== ENGINE_VOICE_ABI) throw new Error(`Unsupported audio renderer ${contribution.rendererId}.`);
  if (contribution.engineClasses.some(kind => !family.engineClasses.includes(kind))
    || contribution.telemetrySchemaIds.some(id => !family.telemetrySchemaIds.includes(id))) throw new Error("Incompatible audio renderer metadata.");
  const renderer = { ...family, voiceWasmUrl: moduleUrl ?? family.voiceWasmUrl, voiceSha256: contribution.wasm.sha256 };
  registrations.set(contribution.rendererId, renderer, owner);
  AUDIO_RENDERERS[contribution.rendererId] = renderer;
}
export function rendererAdmission(definition: EngineAcousticDefinition,
  renderers: Readonly<Record<string, AudioRendererRegistration>> = AUDIO_RENDERERS):
  { supported: true; renderer: AudioRendererRegistration } | { supported: false; reason: string } {
  const renderer = Object.hasOwn(renderers, definition.rendererId) ? renderers[definition.rendererId] : undefined;
  if (!renderer) return { supported: false, reason: `Audio renderer ${definition.rendererId} is not implemented.` };
  if (renderer.abi.id !== "osfs-audio-dynamics-v6" || renderer.abi.snapshotVersion !== AUDIO_SNAPSHOT_VERSION
    || renderer.voiceAbi !== ENGINE_VOICE_ABI) return { supported: false, reason: `Audio renderer ${renderer.id} requires an unsupported ABI.` };
  if (!renderer.engineClasses.includes(definition.engineClass)) return { supported: false, reason: `Renderer ${renderer.id} does not implement ${definition.engineClass} engines.` };
  if (!renderer.telemetrySchemaIds.includes(definition.telemetry.id)) return { supported: false, reason: `Renderer ${renderer.id} does not accept telemetry ${definition.telemetry.id}.` };
  try { renderer.encodeParameters(definition); } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { supported: true, renderer };
}
