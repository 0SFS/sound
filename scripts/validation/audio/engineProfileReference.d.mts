/** Types for `engineProfileReference.mjs`, which fly's tests import as `@0sfs/sound/validation/engineProfileReference`. */
export interface ReferenceCase {
  sampleRate: number;
  tier: number;
  exterior: number;
}

export interface ReferenceRender {
  left: Float32Array;
  right: Float32Array;
  outputSha256: string;
  wasmSha256: string;
}

export const REFERENCE_CASES: ReferenceCase[];
export function referenceState(time: number, exterior: number): Record<string, number>;
export function renderReference(wasmPath: string, headerPath: string, options: ReferenceCase): Promise<ReferenceRender>;
