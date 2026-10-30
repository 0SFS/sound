# Sound

Aircraft sound for 0SFS: the shared audio host and Sound panel. One AudioContext
and worklet own telemetry timing, spatialization, mixing, tire cues and the final
limiter. Source synthesis comes from independently built `turbine-sound`,
`piston-sound` and `electric-sound` modules using `engine-sound`'s block ABI.

Engine mods own acoustic profiles. Aircraft mods own source installations; drone
propulsion mods own motor/propeller data used by both physics and sound. The host
contains no aircraft presets. Installed replacements shadow the underlying mod
until removed, and active sound adapters rebind when their installation changes.

`fly` checks the host and all family receipts with `npm run verify:audio`.
`npm run build:audio` rebuilds the host only; each generator has its own build
command. See [the module design](docs/proposals/modular-engine-audio.md).

The fly app depends on this package and runs its tests. From the `fly` directory, `npm test` includes them.

## Community

- [Code of conduct](https://github.com/0SFS/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/0SFS/.github/blob/main/CONTRIBUTING.md)
- [License](LICENSE)
- [Security](https://github.com/0SFS/.github/blob/main/SECURITY.md)
