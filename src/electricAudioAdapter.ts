import type { JSBSimSdk } from "@felipegalind0/jsbsim";
import { AVAILABILITY, type ElectricRotorSnapshot } from "./audioSnapshot";
import type { AudioAdapter, AudioAdapterReading } from "./jsbsimAudioAdapter";
import type { ResolvedEngineSoundSource } from "./aircraftAudioProfiles";

/** Plain data port supplied by the lazy flight model; this package imports no drone implementation. */
export interface ElectricAudioFeed {
  aircraftId: string;
  valid: boolean;
  armed: boolean;
  simTimeS: number;
  airDensityKgM3: number;
  airVelocityBodyMps: readonly [number, number, number];
  rotors: readonly ElectricRotorSnapshot[];
}
export function createElectricAudioAdapter(sdk: JSBSimSdk, options: {
  aircraftId: string;
  gearHeightMetres: number;
  sources: readonly ResolvedEngineSoundSource[];
  readTelemetry(): ElectricAudioFeed | null;
}): AudioAdapter {
  if (options.sources.length !== 4 || options.sources.some(s => s.installation.position.kind !== "rotor")) {
    throw new Error("Electric audio requires four rotor sources.");
  }
  const offsets = options.sources.map(source => {
    const position = source.installation.position;
    if (position.kind !== "rotor") throw new Error("Invalid rotor source.");
    const [x, y, z] = position.hubM.map((v, i) => v - position.cgM[i]);
    return [-y, z + options.gearHeightMetres, -x] as const;
  });
  const batch = sdk.createPropertyBatch(["simulation/sim-time-sec", "velocities/v-east-fps",
    "velocities/v-down-fps", "velocities/v-north-fps", "atmosphere/a-fps"], { create: false });
  const values = new Float64Array(5);
  const rotors: ElectricRotorSnapshot[] = options.sources.map(() => ({
    rpm: 0, thrustN: 0, shaftTorqueNm: 0, inducedVelocityMps: 0, vrs: 0, valid: false,
  }));
  const diagnostics: AudioAdapter["diagnostics"] = {
    missing: [], combustionSource: "unavailable", sourceOffset: offsets[0], sourceOffsets: offsets,
    sourceProfiles: options.sources.map(source => source.definition), profile: options.sources[0].definition,
    // The feed is structurally installed before the first physics step. Freshness is checked on each read.
    telemetryAvailable: true,
  };
  const reading: AudioAdapterReading = { simTimeS: NaN, availability: 0, n1Pct: 0, n2Pct: 0,
    thrustLbf: 0, fuelFlowPps: 0, throttleNorm: 0, combustion: false, running: false,
    starter: false, cutoff: false, kias: 0, gearNorm: 0, flapNorm: 0,
    velocity: [0, 0, 0], soundSpeedMps: 343, augmentation: false, sourceAxis: [0, 1, 0],
    electricRotors: rotors, armed: false };
  let disposed = false;
  return {
    diagnostics,
    read() {
      if (disposed) return reading;
      let feed: ElectricAudioFeed | null = null;
      try { feed = options.readTelemetry(); } catch { /* A failed feed invalidates this reading. */ }
      let nativeValid = false;
      try { batch.read(values); nativeValid = values.every(Number.isFinite); } catch { /* Invalidate; never replay old measurements as fresh. */ }
      reading.simTimeS = nativeValid ? values[0] : NaN;
      const valid = nativeValid && !!feed?.valid && feed.aircraftId === options.aircraftId && feed.rotors.length === 4
        && Number.isFinite(feed.simTimeS) && Math.abs(reading.simTimeS - feed.simTimeS) <= 0.05;
      diagnostics.telemetryAvailable = valid;
      diagnostics.missing = valid ? [] : ["fresh multirotor telemetry"];
      reading.availability = valid ? AVAILABILITY.ELECTRIC_ROTORS | AVAILABILITY.DENSITY : 0;
      reading.armed = valid && feed!.armed;
      reading.running = reading.armed;
      reading.airDensityKgM3 = valid ? feed!.airDensityKgM3 : NaN;
      reading.airVelocityBodyMps = valid ? feed!.airVelocityBodyMps : [0, 0, 0];
      reading.velocity[0] = nativeValid ? values[1] * 0.3048 : 0;
      reading.velocity[1] = nativeValid ? -values[2] * 0.3048 : 0;
      reading.velocity[2] = nativeValid ? -values[3] * 0.3048 : 0;
      reading.soundSpeedMps = nativeValid && values[4] > 0 ? values[4] * 0.3048 : 343;
      for (let i = 0; i < 4; i++) {
        const rotor = valid ? feed!.rotors[i] : null;
        Object.assign(rotors[i], rotor ?? { rpm: 0, thrustN: 0, shaftTorqueNm: 0, inducedVelocityMps: 0, vrs: 0 });
        rotors[i].valid = !!rotor?.valid;
      }
      return reading;
    },
    dispose() { if (!disposed) { disposed = true; batch.dispose(); } },
  };
}
