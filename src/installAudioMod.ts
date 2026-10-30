import type { OsfsModManifest } from "@0sfs/mods/schema";
import type { AircraftId } from "@0sfs/aircraft/aircraftIds";
import { registerAudioRenderer, unregisterAudioRenderer } from "./audioRendererRegistry";
import { registerEngineAcousticDefinition, telemetryById, unregisterEngineAcousticDefinition } from "./engineAcousticDefinitions";
import { registerAircraftAudioInstallation, unregisterAircraftAudioInstallation } from "./aircraftAudioProfiles";

const listeners = new Set<() => void>();
export function onAudioModsChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function changed(): void { for (const listener of listeners) listener(); }

/** Shared by bundled and downloaded mods, so the two paths admit identical sound data. */
export function installAudioMod(manifest: OsfsModManifest, options: { baseUrl?: string; bundled?: boolean; owner?: string } = {}): void {
  const owner = options.owner ?? manifest.id;
  if (manifest.audioRenderer) {
    const base = options.baseUrl && new URL(options.baseUrl, globalThis.location?.href ?? "http://localhost/");
    if (!options.bundled && !base) throw new Error("A downloaded sound generator needs its mod base URL.");
    const url = options.bundled ? undefined : new URL(manifest.audioRenderer.wasm.path, base);
    registerAudioRenderer(manifest.audioRenderer, url, owner);
  }
  const engine = manifest.engine;
  const acoustic = engine?.acousticProfile;
  if (engine && acoustic) {
    const telemetry = telemetryById(acoustic.telemetryId);
    if (!telemetry) throw new Error(`Unknown engine sound telemetry ${acoustic.telemetryId}.`);
    const parameters = engine.type === "electric"
      ? { ...(acoustic.parameters as Record<string, unknown>), radiusM: engine.electric.propeller.radiusM,
        blades: engine.electric.propeller.blades, chordM: engine.electric.propeller.chordM,
        pitchM: engine.electric.propeller.pitchM, maxRpm: engine.electric.propeller.maxRpm }
      : acoustic.parameters;
    registerEngineAcousticDefinition({ ...acoustic, telemetry, parameters }, owner);
  }
  const audio = manifest.aircraft?.audio;
  if (!audio) { if (manifest.audioRenderer || acoustic) changed(); return; }
  for (const id of Object.keys(manifest.aircraft!.fdmProfiles)) {
    if (audio.sourceKind !== "rotor") registerAircraftAudioInstallation(id as AircraftId, audio.engineDefinitionId, owner);
    else {
      if (!manifest.quad || manifest.quad.rotors.length !== 4) throw new Error("Rotor sound requires four installed rotors.");
      const quad = manifest.quad;
      registerAircraftAudioInstallation(id as AircraftId, { engineSources: quad.rotors.map((rotor, index) => ({
        id: rotor.position, engineIndex: index, engineDefinitionId: audio.engineDefinitionId,
        position: { kind: "rotor", hubM: rotor.hubM, cgM: quad.cgM },
      })) }, owner);
    }
  }
  changed();
}
export function uninstallAudioMod(manifest: OsfsModManifest, owner = manifest.id): void {
  if (manifest.audioRenderer) unregisterAudioRenderer(manifest.audioRenderer.rendererId, owner);
  if (manifest.engine?.acousticProfile) unregisterEngineAcousticDefinition(manifest.engine.acousticProfile.id, owner);
  for (const id of Object.keys(manifest.aircraft?.fdmProfiles ?? {})) unregisterAircraftAudioInstallation(id as AircraftId, owner);
  changed();
}
