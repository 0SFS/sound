import { OwnedRegistry } from "@0sfs/mods/ownedRegistry";
import type { AircraftId } from "@0sfs/aircraft/aircraftIds";
import { getEngineAcousticDefinition, type EngineAcousticDefinition } from "./engineAcousticDefinitions";
import { rendererAdmission, type AudioRendererRegistration } from "./audioRendererRegistry";

export interface InstalledEngineSoundSource {
  readonly id: string;
  readonly engineIndex: number;
  readonly engineDefinitionId: string;
  readonly position: { readonly kind: "native-engine" } | {
    readonly kind: "rotor";
    /** JSBSim structural metres, from the same origin as the CG. */
    readonly hubM: readonly [number, number, number];
    readonly cgM: readonly [number, number, number];
  };
}
export interface AircraftAudioInstallation { readonly engineSources: readonly InstalledEngineSoundSource[] }
export interface ResolvedEngineSoundSource {
  readonly installation: InstalledEngineSoundSource;
  readonly definition: EngineAcousticDefinition;
}
export type AircraftAudioAdmission =
  | { supported: true; source: ResolvedEngineSoundSource; sources: readonly ResolvedEngineSoundSource[]; renderer: AudioRendererRegistration }
  | { supported: false; reason: string };

const INSTALLATIONS = new OwnedRegistry<AircraftAudioInstallation>();
export function registerAircraftAudioInstallation(id: AircraftId, setup: string | AircraftAudioInstallation, owner?: string): void {
  INSTALLATIONS.set(id, typeof setup === "string" ? {
    engineSources: [{ id: "main-exhaust", engineIndex: 0, engineDefinitionId: setup, position: { kind: "native-engine" } }],
  } : setup, owner);
}
export function unregisterAircraftAudioInstallation(id: AircraftId, owner?: string): void { INSTALLATIONS.remove(id, owner); }
export function getAircraftAudioInstallation(id: AircraftId): AircraftAudioInstallation | undefined { return INSTALLATIONS.get(id); }

/** Admit the complete installation; never discard extra motors or invent a default profile. */
export function resolveAircraftAudioInstallation(installation?: AircraftAudioInstallation,
  definitions: (id: string) => EngineAcousticDefinition | undefined = getEngineAcousticDefinition): AircraftAudioAdmission {
  if (!installation?.engineSources.length) return { supported: false, reason: "No engine sound installation is defined." };
  const sources: ResolvedEngineSoundSource[] = [];
  const ids = new Set<string>();
  let selected: AudioRendererRegistration | undefined;
  for (const source of installation.engineSources) {
    if (!source.id || ids.has(source.id) || !Number.isInteger(source.engineIndex) || source.engineIndex < 0
      || !["native-engine", "rotor"].includes(source.position.kind)) {
      return { supported: false, reason: "Invalid engine sound source installation." };
    }
    ids.add(source.id);
    const definition = definitions(source.engineDefinitionId);
    if (!definition) return { supported: false, reason: `Engine acoustic definition ${source.engineDefinitionId} is unavailable.` };
    const admitted = rendererAdmission(definition);
    if (!admitted.supported) return admitted;
    if (selected && selected.id !== admitted.renderer.id) return { supported: false, reason: "Mixed audio renderers are not implemented." };
    if ((source.position.kind === "rotor") !== (definition.engineClass === "electric")) {
      return { supported: false, reason: "Sound source placement does not match its telemetry." };
    }
    if (source.position.kind === "rotor" && (source.position.hubM.length !== 3 || source.position.cgM.length !== 3
      || ![...source.position.hubM, ...source.position.cgM].every(Number.isFinite))) {
      return { supported: false, reason: "Invalid rotor source geometry." };
    }
    selected = admitted.renderer;
    sources.push({ installation: source, definition });
  }
  if (!selected || sources.length > selected.maxEngineSources) return { supported: false, reason: "Current audio renderer source capacity is exceeded; multiple-source rendering is unavailable for this installation." };
  return { supported: true, source: sources[0], sources, renderer: selected };
}
export function getAircraftAudioProfile(id: AircraftId): EngineAcousticDefinition | undefined {
  const admitted = resolveAircraftAudioInstallation(getAircraftAudioInstallation(id));
  return admitted.supported ? admitted.source.definition : undefined;
}
export { ACOUSTIC_PROFILE_FIELDS, acousticProfileValues } from "./engineAcousticDefinitions";
export type { EngineAcousticProfile, EngineAcousticDefinition as AircraftAudioProfile } from "./engineAcousticDefinitions";
