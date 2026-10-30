import { OwnedRegistry } from "@0sfs/mods/ownedRegistry";
/** Native semantic fields; a schema selects paths without aircraft-specific code. */
export type EngineTelemetryField = "n1Pct" | "n2Pct" | "thrustLbf" | "fuelFlowPps" | "running" | "augmentation" | "starter" | "cutoff" | "throttleNorm" | "thermalValid" | "afterburnerBurnedFuelFlowKgSec" | "engineRpm" | "propellerRpm" | "shaftPowerHp";
export interface NativeEngineTelemetrySchema {
  readonly id: string;
  readonly required: readonly EngineTelemetryField[];
  /** {engineIndex} is expanded by the native adapter; unavailable is never zero. */
  readonly paths: Readonly<Partial<Record<EngineTelemetryField, string>>>;
  /** Native global commands describe the selected engine(s), not each engine. */
  readonly commandScope?: { readonly selectionPath: string; readonly allEnginesValue: number };
  readonly combustion: { readonly rule: "fuel-flow-or-running" | "running"; readonly minimumFuelFlowPps: number };
}

export const JSBSIM_TURBINE_TELEMETRY: NativeEngineTelemetrySchema = Object.freeze({
  id: "jsbsim-turbine-v1",
  required: ["n1Pct", "n2Pct", "thrustLbf", "fuelFlowPps"] as const,
  commandScope: { selectionPath: "propulsion/active_engine", allEnginesValue: -1 },
  combustion: { rule: "fuel-flow-or-running" as const, minimumFuelFlowPps: 1e-4 },
  paths: Object.freeze({
    n1Pct: "propulsion/engine[{engineIndex}]/n1", n2Pct: "propulsion/engine[{engineIndex}]/n2",
    thrustLbf: "propulsion/engine[{engineIndex}]/thrust-lbs", fuelFlowPps: "propulsion/engine[{engineIndex}]/fuel-flow-rate-pps",
    running: "propulsion/engine[{engineIndex}]/set-running", augmentation: "propulsion/engine[{engineIndex}]/augmentation",
    starter: "propulsion/starter_cmd", cutoff: "propulsion/cutoff_cmd",
    throttleNorm: "fcs/throttle-cmd-norm[{engineIndex}]",
  }),
});

/** Native combustion partition, rather than selection alone, drives reheat sound. */
export const JSBSIM_THERMAL_TURBINE_TELEMETRY: NativeEngineTelemetrySchema = Object.freeze({
  ...JSBSIM_TURBINE_TELEMETRY,
  id: "jsbsim-thermal-turbine-v1",
  paths: Object.freeze({
    ...JSBSIM_TURBINE_TELEMETRY.paths,
    thermalValid: "propulsion/engine[{engineIndex}]/thermal/valid",
    afterburnerBurnedFuelFlowKgSec: "propulsion/engine[{engineIndex}]/thermal/afterburner-burned-fuel-flow-kg-sec",
  }),
});

/** A piston crankshaft and propeller are native shafts, never turbine percentages. */
export const JSBSIM_PISTON_TELEMETRY: NativeEngineTelemetrySchema = Object.freeze({
  id: "jsbsim-piston-v1",
  required: ["engineRpm", "propellerRpm", "shaftPowerHp", "fuelFlowPps", "running"] as const,
  commandScope: { selectionPath: "propulsion/active_engine", allEnginesValue: -1 },
  // Fuel can still be metered with ignition off. Native running confirms firing.
  combustion: { rule: "running" as const, minimumFuelFlowPps: 1e-4 },
  paths: Object.freeze({
    engineRpm: "propulsion/engine[{engineIndex}]/engine-rpm",
    propellerRpm: "propulsion/engine[{engineIndex}]/propeller-rpm",
    shaftPowerHp: "propulsion/engine[{engineIndex}]/power-hp",
    thrustLbf: "propulsion/engine[{engineIndex}]/thrust-lbs",
    fuelFlowPps: "propulsion/engine[{engineIndex}]/fuel-flow-rate-pps",
    running: "propulsion/engine[{engineIndex}]/set-running",
    starter: "propulsion/starter_cmd", cutoff: "propulsion/cutoff_cmd",
    throttleNorm: "fcs/throttle-cmd-norm[{engineIndex}]",
  }),
});

export { JET_ACOUSTIC_PROFILE_FIELDS, PISTON_ACOUSTIC_PROFILE_FIELDS, ACOUSTIC_PROFILE_FIELDS } from "@0sfs/engine-sound/legacyProfile";
export type { EngineAcousticProfile, PistonAcousticProfile } from "@0sfs/engine-sound/legacyProfile";
import { acousticProfileValues as turbineProfileValues } from "@0sfs/turbine-sound/profile";
import { pistonProfileValues } from "@0sfs/piston-sound/profile";
export { pistonProfileValues };

export interface EngineAcousticDefinition {
  /** Open hardware metadata; renderer compatibility is an independent gate. */
  readonly engineClass: string;
  readonly manufacturerFamily: string;
  readonly rendererId: string;
  readonly telemetry: NativeEngineTelemetrySchema;
  readonly id: string;
  readonly label: string;
  readonly approximation: string;
  readonly parameters: unknown;
}

/** Populated by installed engine mods; no hardware defaults live in the host. */
const DEFINITIONS = new OwnedRegistry<EngineAcousticDefinition>();

export const MULTIROTOR_ELECTRIC_TELEMETRY: NativeEngineTelemetrySchema = Object.freeze({
  id: "multirotor-electric-v1", required: [] as const, paths: {},
  combustion: { rule: "running" as const, minimumFuelFlowPps: 0 },
});

export function telemetryById(id: string): NativeEngineTelemetrySchema | undefined {
  if (id === MULTIROTOR_ELECTRIC_TELEMETRY.id) return MULTIROTOR_ELECTRIC_TELEMETRY;
  if (id === JSBSIM_PISTON_TELEMETRY.id) return JSBSIM_PISTON_TELEMETRY;
  if (id === JSBSIM_THERMAL_TURBINE_TELEMETRY.id) return JSBSIM_THERMAL_TURBINE_TELEMETRY;
  if (id === JSBSIM_TURBINE_TELEMETRY.id) return JSBSIM_TURBINE_TELEMETRY;
  return undefined;
}

/** Installed mod data is authoritative, including a refreshed profile with the same id. */
export function registerEngineAcousticDefinition(definition: EngineAcousticDefinition, owner?: string): void {
  DEFINITIONS.set(definition.id, definition, owner);
}

export function getEngineAcousticDefinition(id: string): EngineAcousticDefinition | undefined {
  return DEFINITIONS.get(id);
}

export function unregisterEngineAcousticDefinition(id: string, owner?: string): void { DEFINITIONS.remove(id, owner); }

/** Compatibility encoder for legacy validation callers; no hardware default is inferred. */
export function acousticProfileValues(definition: EngineAcousticDefinition | undefined): number[] {
  if (!definition) throw new Error("An explicit engine acoustic definition is required.");
  return definition.rendererId === "procedural-piston-v1" ? pistonProfileValues(definition) : turbineProfileValues(definition);
}
