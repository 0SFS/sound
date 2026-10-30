# Modular engine audio

Implemented 29 October 2026. `sound` owns the shared playback host;
`engine-sound` owns the allocation-free `osfs-engine-voice-v1` ABI and shared
primitives. `turbine-sound`, `piston-sound` and `electric-sound` own independent
WASM artifacts. Legacy turbine/piston algorithms remain C++; electric has an
exact TypeScript reference and Rust/WASM twin.

## Ownership and data flow

Engine manifests select a generator with `acousticProfile.rendererId`, a
telemetry schema and numeric parameters. Generator component manifests declare
`audioRenderer` with ABI, compatible classes/schemas, relative WASM path and
SHA-256. These are sandboxed WASM mods; no generator JavaScript is loaded.
The dependency graph installs generators before profiles and aircraft.

The Mini 2 and Air 2S aircraft depend on their respective propulsion engine
mods. `engine.electric.propeller` is the single physical motor/propeller
configuration; `quad.propulsionId` resolves it for physics and audio. Rotor
hubs, spin directions and CG remain on the airframe. Legacy inline propeller
configuration is still accepted. Drones retain FDM `engine: "none"`; their
rotors are not fabricated JSBSim combustion engines.

Accepted physics steps provide per-rotor RPM, thrust N, shaft torque N m,
induced velocity m/s, VRS and validity, plus density, body-relative air velocity,
armed state and simulation time. A lightweight gate preserves lazy drone
loading. Presentation-frame instruments are not the audio producer.
Snapshot v6 appends four rotor blocks to the original fields. Required input
availability is distinct from zero. Current rotor thrust axes are body -Z;
axial airflow is projected in that body frame.

## Playback

Audio enablement loads the common host and selected family, verifies the family
hash and sandbox, compiles off the audio thread and transfers compiled modules
to the existing worklet. Each quantum prepares interpolated inputs, renders the
family once and spatializes/mixes the source planes. Fixed-size buffers carry
Float64 measurements and source/airframe samples; only the final output is
Float32. In-block tier/reset counters preserve sample-accurate transitions.
There are no sample-wise JavaScript/WASM calls, allocations or memory growth
in rendering.

Electric uses four independently seeded voices and four spatial paths, with one
installation-wide harmonic/noise budget. Low retains all four blade-passage
fundamentals. Geometry, simulated load and inflow shape tones and broadband
noise; there are no invented motor pole counts or ESC switching frequencies.
Invalid inputs fade each voice over 10 ms. The shared stale timer, epochs,
pause holds and source reset paths clear old sound. Drone views bypass airplane
cabin filtering and reverb.

One aircraft airframe bus and tire cue feed one master limiter. Legacy aircraft
retain their installation color, source-axis directivity, native burned-reheat
fuel response, propagation and camera-zoom behavior. Registry entries are owned
by their installed mods; removing a replacement restores the prior entry and
notifies active adapters.

## Validation

From `fly`, run focused audio tests, `npm run typecheck` and
`npm run verify:audio`. `electric-sound` provides `npm test`, `npm run check:wasm`
and `npm run references`. Reference WAVs are driven multirotor-plant fixtures,
not aircraft recordings or acoustic calibration.

`check-family-extraction.mjs --baseline=/path/to/old/audio-dsp.wasm` compares a
retained pre-extraction artifact with the new pipeline. The implementation run
compared FJ33, F135 and IO320 at 44.1/48 kHz and all three tiers, including
startup, power changes, reheat, tier changes and stale fades: all 18 cases were
bit-for-bit identical. Calibration and device performance remain unmeasured;
use the flight Test tab for listening feedback.
