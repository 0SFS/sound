/** Validation fixtures read the actual mod data; runtime libraries own no engine presets. */
import io320 from "../../../IO320/public/0sfs-mod.json";
import fj33 from "../../../FJ33/public/0sfs-mod.json";
import f135 from "../../../F135/public/0sfs-mod.json";
import { getEngineAcousticDefinition, telemetryById, type EngineAcousticDefinition, type EngineAcousticProfile, type PistonAcousticProfile } from "../../src/engineAcousticDefinitions";
import { createDspHarness } from "../../src/dspHarness";
function definition(profile: typeof fj33.engine.acousticProfile | typeof io320.engine.acousticProfile): EngineAcousticDefinition {
  return getEngineAcousticDefinition(profile.id) ?? { ...profile, telemetry: telemetryById(profile.telemetryId)! };
}
export const FJ33_DEFINITION = definition(fj33.engine.acousticProfile);
export const F135_DEFINITION = definition(f135.engine.acousticProfile);
export const IO320_DEFINITION = definition(io320.engine.acousticProfile);
export const FJ33_ACOUSTICS = FJ33_DEFINITION.parameters as EngineAcousticProfile;
export const IO320_ACOUSTICS = IO320_DEFINITION.parameters as PistonAcousticProfile;
export function createReferenceHarness(options: NonNullable<Parameters<typeof createDspHarness>[0]> = {}) {
  return createDspHarness({ ...options, profile: options.profile ?? FJ33_DEFINITION });
}
