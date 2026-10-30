# Drone sound and generator extraction validation

29 October 2026. Local implementation; no source committed, pushed or deployed.

## Completed checks

- Shared host and independent turbine/piston/electric artifacts pass source,
  binary hash, export, ABI and sandbox verification. Final production output
  emits the worklet, host and all family modules with verified bytes.
- TypeScript application typecheck passes.
- The combined run covered 53 test files (564 passing tests and one skipped).
  Its one camera-preview fixture compatibility failure was corrected and the
  affected tests passed on rerun. Final focused reruns passed 29 and 46 tests.
  Audio, drone, mod-loader and engine ownership tests cover actual shipped WASMs,
  per-motor telemetry, source placement, Low detail budgets, malformed modules,
  lifecycle, dependency removal and profile restoration. Electric standalone
  Rust/WASM/TypeScript tests pass exact parity, including 10 ms invalid fades.
- Before/after waveform comparisons of retained legacy FJ33, F135 and IO320
  output pass all 18 cases bit-for-bit at 44.1/48 kHz and Low/Med/High. The trace
  covers startup, power changes, combustion/reheat, camera range changes, tier
  transitions and stale fades. See the ignored `sound/build/family-extraction/`.
- A real Chrome AudioContext/AudioWorklet renders four independent voices for
  both drones, with nonzero analyser output, zero nonfinite samples, no sound
  errors and no failed module requests. This uses synthetic physical inputs and
  a muted browser; it does not establish listening acceptance or device timing.
- The actual flight Test tab shows the custom checklist and produces a
  downloadable `foss-earth-test-feedback` JSON. Sound-panel screenshots were
  reviewed. Local artifacts are in `fly/build/drone-sound/` and `fly/build/shots/`.

## Existing workspace checks requiring separate work

The full `npm run build` preflight stops at `verify:exhaust`: the existing
`F135/src/generated/f135-exhaust-lut.png` differs from its generator. This task
only changes F135's sound dependency and documentation, and does not regenerate
its exhaust assets. Direct Vite production compilation and audio output
verification pass separately.

A broader `createFlightSimApp.test.ts` run has three failures in existing bug
report UI, combat-scene mock and propeller-disc assertion paths. Their changes
were already in progress separately. The focused sound/native-adapter tests,
mod ownership checks and real browser audio checks pass.

## Listening handoff

Run `cd ~/gh/0sfs/fly && npm run dev` in the maintainer's terminal, then open
`fly/build/drone-sound/review.html`. It links the custom Test-tab checklist,
the six reference WAVs and the screenshot review. Select each drone and try
idle, hover, maneuvering, camera distance, quality levels, shutdown, pause and
switching. Finish the checklist and download feedback for tuning.

Reference WAVs are driven multirotor-plant fixtures using the authoritative
propulsion manifests. Geometry and live simulated load influence synthesis;
absolute loudness, spectra, motor electrical characteristics and real-world
acoustic accuracy have not been calibrated.

## Source review and push handoff

Preserve the other work in progress in shared files. Nothing has been staged or
committed by this task; new public repositories currently contain no pushed
source. Review and commit explicit paths before running these commands. All
listed checkouts use `main`, with the expected `https://github.com/0SFS/<repo>.git`
push remote verified during the handoff.

After review commits exist, these are the source push commands (not run):

```sh
for repo in engine-sound turbine-sound piston-sound electric-sound \
  DJI-Mini2-propulsion DJI-Air-2S-propulsion mods engines sound \
  IO320 FJ33 F135 DJI-Mini2 DJI-Air-2S fly; do
  git -C "$HOME/gh/0sfs/$repo" push -u origin main || break
done
```

The agent can run these only on an explicit request to push. There is no
publishing or deployment command in this handoff. The default pack already
brings in aircraft dependencies transitively, so no additional top-level pack
content is required.
