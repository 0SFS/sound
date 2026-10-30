import { ChoiceTrack, Resettable } from "foss-earth/shell";
import type { FlightAudioStatus } from "./createFlightAudio";
import { AVAILABILITY_LABELS, type TierId } from "./audioQuality";
import {
  AUDIO_QUALITY_IDS, AUDIO_QUALITY_LABELS, type AudioQualityId, type AudioSettingsV1,
} from "./audioSettings";

export type SoundAction =
  | { type: "enable"; enabled: boolean }
  | { type: "quality"; quality: AudioQualityId }
  | { type: "settings"; patch: Partial<Pick<AudioSettingsV1,
    "masterVolume" | "engineVolume" | "afterburnerVolume" | "listenerCockpitBlend"
    | "airframeVolume" | "engineMuted" | "reducedDynamicRange">> }
  | { type: "retest" };

const percent = (value: number): string => Number.isFinite(value) ? `${value.toFixed(0)}%` : "n/a";

/** Shows native engine state, so "the engine went quiet" can be told apart from a sound fault. */
function engineLine(engine: NonNullable<FlightAudioStatus["engine"]>): string {
  if (engine.kind === "electric") return `Motor telemetry: ${(engine.rotorRpm ?? []).map(rpm => `${Math.round(rpm)} RPM`).join(" · ")}`;
  if (engine.kind === "piston") {
    const rpm = (value: number | undefined): string => value !== undefined && Number.isFinite(value)
      ? `${Math.round(value)} rpm` : "n/a";
    const state = engine.combustion ? "burning" : (engine.engineRpm ?? 0) > 1 ? "turning, not burning" : "stopped";
    const power = engine.shaftPowerHp !== undefined && Number.isFinite(engine.shaftPowerHp)
      ? `${Math.round(engine.shaftPowerHp)} hp` : "n/a";
    return `Engine telemetry: ${state} · engine ${rpm(engine.engineRpm)} · propeller ${rpm(engine.propellerRpm)} · power ${power}`;
  }
  const turning = (Number.isFinite(engine.n1Pct) && engine.n1Pct > 1) || (Number.isFinite(engine.n2Pct) && engine.n2Pct > 1);
  const state = engine.combustion
    ? "burning"
    : turning ? "not burning, shafts windmilling with airspeed" : "stopped";
  const fuel = Number.isFinite(engine.fuelFlowPps) ? `${Math.round(engine.fuelFlowPps * 3600)} lb/h` : "n/a";
  return `Engine telemetry: ${state} · N1 ${percent(engine.n1Pct)} · N2 ${percent(engine.n2Pct)} · fuel ${fuel}`;
}

const TIERS: readonly AudioQualityId[] = ["low", "med", "high"];

const COMBUSTION_SOURCE_LABELS: Record<string, string> = {
  "fuel-flow": "fuel flow",
  "running-only": "the engine running flag only",
  unavailable: "nothing (no combustion signal)",
};

const HOLD_LABELS = {
  pause: "paused", background: "page hidden", loading: "flight loading",
  fault: "flight fault", reset: "resetting flight", rest: "aircraft at rest",
} as const;

/**
 * Only concrete browser, renderer or asset failures belong in normal controls.
 * Listening acceptance and performance evidence are recorded in the docs.
 */
function qualityOption(state: FlightAudioStatus, id: AudioQualityId) {
  if (!TIERS.includes(id)) return { label: AUDIO_QUALITY_LABELS[id], disabled: false, reason: null };
  const availability = state.availability[id as TierId];
  if (availability.state === "available") return { label: AUDIO_QUALITY_LABELS[id], disabled: false, reason: null };
  return {
    label: `${AUDIO_QUALITY_LABELS[id]} — ${AVAILABILITY_LABELS[availability.state]}`,
    disabled: true,
    reason: availability.reason,
  };
}

const tierLabel = (tier: TierId): string => tier === "off" ? "Off" : AUDIO_QUALITY_LABELS[tier];
const positionLabel = (cockpit: number): string => cockpit === 0 ? "Camera" : cockpit === 1 ? "Cockpit"
  : `${Math.round(cockpit * 100)}% Cockpit / ${Math.round((1 - cockpit) * 100)}% Camera`;

export function SoundSettingsPanel({ state, onAction }: {
  state: FlightAudioStatus;
  onAction(action: SoundAction): void;
}) {
  const { settings } = state;
  const audible = state.mode === "sound" && state.effective !== "off" && !state.gestureLocked;
  const requestedReason = qualityOption(state, settings.requested).reason;
  const retryQuality = settings.downgradedFrom ?? settings.requested;
  return (
    <fieldset className="flight-panel__fieldset">
      <legend>Sound</legend>
      {!settings.enabled && !audible && <button className="flight-panel__command" type="button"
        onClick={() => onAction({ type: "enable", enabled: true })}>Enable sound</button>}
      {settings.enabled && <button className="flight-panel__command" type="button"
        onClick={() => onAction({ type: "enable", enabled: false })}>Turn sound off</button>}
      <ChoiceTrack heading="Sound quality" parameter="osfs.sound.quality"
        choices={AUDIO_QUALITY_IDS.map(id => ({ id, label: AUDIO_QUALITY_LABELS[id],
          unavailable: qualityOption(state, id).reason }))}
        value={settings.requested}
        onChange={quality => onAction({ type: "quality", quality: quality as AudioQualityId })}
        help={<>Low, Med and High keep your selected quality. Auto can lower quality when audio overloads.
          Use Force on or Retry sound to restart audio without reloading the page.</>} />
      <p className="flight-panel__hint" role="status" aria-label="Sound playback status">
        Selected {AUDIO_QUALITY_LABELS[settings.requested]} · Loaded {tierLabel(state.effective)}
        {state.loading ? " · loading sound" : ""}
        {state.gestureLocked ? " · waiting for a click or key press" : ""}
        {state.mode === "tire-only" ? " (tire cue only)" : ""}
        {state.held ? ` · held${state.holdReasons.length ? `: ${state.holdReasons.map(reason => HOLD_LABELS[reason]).join(", ")}` : ""}` : ""}
        {!state.held && !state.gestureLocked && !state.loading && state.contextState === "suspended"
          ? " · suspended" : ""}
      </p>
      {retryQuality !== "off" && <button className="flight-panel__command" type="button"
        onClick={() => onAction({ type: "retest" })}>
        {retryQuality === "auto" ? "Retry sound" : `Force ${AUDIO_QUALITY_LABELS[retryQuality]} on`}
      </button>}
      {requestedReason && <p className="flight-panel__hint">{requestedReason}</p>}
      {state.message && <p className="flight-panel__hint" role="alert">{state.message}</p>}
      {settings.downgradedFrom && <>
        <p className="flight-panel__hint">
          Quality was lowered from {AUDIO_QUALITY_LABELS[settings.downgradedFrom]} after an overload and
          can be restored with {retryQuality === "auto" ? "Retry sound" : `Force ${AUDIO_QUALITY_LABELS[retryQuality]} on`}.
        </p>
      </>}
      <label className="flight-panel__field">
        <span>Master volume · {percent(settings.masterVolume * 100)}</span>
        <Resettable parameter="osfs.sound.masterVolume">
          <input type="range" aria-label="Master volume" min={0} max={8} step={0.05} value={settings.masterVolume}
            onChange={event => onAction({ type: "settings", patch: { masterVolume: Number(event.target.value) } })} />
        </Resettable>
      </label>
      <label className="flight-panel__field">
        <span>Engine volume · {percent(settings.engineVolume * 100)}</span>
        <Resettable parameter="osfs.sound.engineVolume">
          <input type="range" aria-label="Engine volume" min={0} max={8} step={0.05} value={settings.engineVolume}
            onChange={event => onAction({ type: "settings", patch: { engineVolume: Number(event.target.value) } })} />
        </Resettable>
      </label>
      <label className="flight-panel__field">
        <span>Sound position · {positionLabel(settings.listenerCockpitBlend)}</span>
        <Resettable parameter="osfs.sound.listenerCockpitBlend" name="Sound position">
          <input type="range" aria-label="Sound position" aria-valuetext={positionLabel(settings.listenerCockpitBlend)}
            min={0} max={1} step={0.01} value={settings.listenerCockpitBlend}
            onChange={event => onAction({ type: "settings", patch: { listenerCockpitBlend: Number(event.target.value) } })} />
        </Resettable>
        <span>Camera ↔ Cockpit</span>
      </label>
      <p className="flight-panel__hint">
        Listen from Camera, Cockpit, or a position between them.
      </p>
      <label className="flight-panel__field">
        <span>Airframe wind volume</span>
        <Resettable parameter="osfs.sound.airframeVolume" name="Airframe wind volume">
          <input type="range" aria-label="Airframe wind volume" min={0} max={1} step={0.05} value={settings.airframeVolume}
            onChange={event => onAction({ type: "settings", patch: { airframeVolume: Number(event.target.value) } })} />
        </Resettable>
      </label>
      <p className="flight-panel__hint">
        Wind and gear/flap turbulence grow with airspeed. Independent of engine volume and engine mute.
      </p>
      <label className="flight-panel__field flight-panel__field--inline">
        <Resettable parameter="osfs.sound.engineMuted">
          <input type="checkbox" aria-label="Mute engine" checked={settings.engineMuted}
            onChange={event => onAction({ type: "settings", patch: { engineMuted: event.target.checked } })} />
        </Resettable>
        <span>Mute engine</span>
      </label>
      <label className="flight-panel__field flight-panel__field--inline">
        <Resettable parameter="osfs.sound.reducedDynamicRange">
          <input type="checkbox" aria-label="Reduced dynamic range" checked={settings.reducedDynamicRange}
            onChange={event => onAction({ type: "settings", patch: { reducedDynamicRange: event.target.checked } })} />
        </Resettable>
        <span>Reduced dynamic range</span>
      </label>
      <p className="flight-panel__hint">
        {state.telemetry?.profileLabel && <>{state.telemetry.profileLabel}. </>}
        {state.telemetry
          ? state.telemetry.kind === "electric" || state.engine?.kind === "electric"
            ? "Motor and propeller sound follow each rotor’s simulated speed and load."
            : `Engine sound follows the flight model. Combustion is read from ${
            COMBUSTION_SOURCE_LABELS[state.telemetry.combustionSource] ?? state.telemetry.combustionSource}.`
          : "This aircraft has no engine sound model; only the tire cue plays."}
        {" "}Tire sound and its volume are under Aircraft → Ground handling. For live engine data, click
        ENGINE on the flight display. Muting sound never hides engine gauges or warnings.
      </p>
      {state.telemetry && state.telemetry.missing.length > 0 && <p className="flight-panel__hint">
        Not published by this model, so left silent rather than guessed: {state.telemetry.missing.join(", ")}.
      </p>}
      {state.engine && <p className="flight-panel__hint" aria-label="Engine telemetry">{engineLine(state.engine)}</p>}
      {state.core && <p className="flight-panel__hint" aria-label="Sound timeline">
        Timeline: epoch {state.core.epoch} · resyncs {state.core.resyncs} · stale fades {state.core.staleFades}
        {" "}· dropped snapshots {state.core.snapshotsDropped}{state.held ? " · held" : ""}
      </p>}
      {state.readOnlyReason && <p className="flight-panel__hint">{state.readOnlyReason}</p>}
      <p className="flight-panel__hint" aria-label="Sound diagnostics">{state.stats}</p>
    </fieldset>
  );
}
