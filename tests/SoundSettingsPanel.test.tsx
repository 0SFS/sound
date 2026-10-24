// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tierAvailability, type AudioCapabilities } from "../src/audioQuality";
import { DEFAULT_AUDIO_SETTINGS, type AudioQualityId } from "../src/audioSettings";
import type { FlightAudioStatus } from "../src/createFlightAudio";
import { SoundSettingsPanel, type SoundAction } from "../src/SoundSettingsPanel";

const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const CAPABLE: AudioCapabilities = { audioWorklet: true, webAssembly: true, bankReady: false, loadObservable: false, highSynthesis: "procedural" };

function status(requested: AudioQualityId, overrides: Partial<FlightAudioStatus> = {}): FlightAudioStatus {
  return {
    enabled: true, requested, effective: "low", mode: "sound", gestureLocked: false, message: null, tireMessage: null,
    availability: {
      off: tierAvailability("off", CAPABLE), low: tierAvailability("low", CAPABLE),
      med: tierAvailability("med", CAPABLE), high: tierAvailability("high", CAPABLE),
    },
    stats: "Audio: low (requested auto)", transport: "port", sampleRateHz: 48_000, held: false, holdReasons: [],
    loading: false, contextState: "running",
    settings: { ...DEFAULT_AUDIO_SETTINGS, enabled: true, requested }, readOnlyReason: null,
    engine: null, core: null, running: null, telemetry: null,
    ...overrides,
  };
}

async function mount(state: FlightAudioStatus) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onAction = vi.fn<(action: SoundAction) => void>();
  await act(async () => root.render(<SoundSettingsPanel state={state} onAction={onAction} />));
  const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  const quality = (value: AudioQualityId) => host.querySelector<HTMLInputElement>(
    `[role="radiogroup"][aria-label="Sound quality"] input[type="radio"][value="${value}"]`,
  )!;
  const playback = () => host.querySelector<HTMLElement>('[role="status"][aria-label="Sound playback status"]')!;
  return { host, onAction, button, quality, playback };
}

describe("sound settings panel", () => {
  it("keeps engine identity without routine calibration warnings", async () => {
    const panel = await mount(status("med", { telemetry: {
      combustionSource: "fuel-flow", missing: [], profileLabel: "Approximate F135 procedural sound",
      approximation: "One main-engine source with generic turbine tones. F135 acoustics are uncalibrated; separate lift-fan sound is not modeled.",
    } }));
    expect(panel.host.textContent).toContain("Approximate F135 procedural sound");
    expect(panel.host.textContent).not.toContain("One main-engine source");
    expect(panel.host.textContent).not.toContain("uncalibrated");
  });

  it("shows burning piston engine RPM, propeller RPM and shaft power without turbine gauges", async () => {
    const panel = await mount(status("med", { engine: {
      kind: "piston", n1Pct: NaN, n2Pct: NaN, fuelFlowPps: 0.012, combustion: true, running: true,
      engineRpm: 2375.4, propellerRpm: 2375.4, shaftPowerHp: 137.6,
    } }));
    const telemetry = panel.host.querySelector('[aria-label="Engine telemetry"]')!;
    expect(telemetry.textContent).toBe("Engine telemetry: burning · engine 2375 rpm · propeller 2375 rpm · power 138 hp");
    expect(telemetry.textContent).not.toMatch(/N1|N2/);
  });

  it("shows a windmilling piston engine and unavailable native propeller RPM or power plainly", async () => {
    const panel = await mount(status("med", { engine: {
      kind: "piston", n1Pct: NaN, n2Pct: NaN, fuelFlowPps: 0.01, combustion: false, running: false,
      engineRpm: 910, propellerRpm: NaN, shaftPowerHp: NaN,
    } }));
    const telemetry = panel.host.querySelector('[aria-label="Engine telemetry"]')!;
    expect(telemetry.textContent).toBe("Engine telemetry: turning, not burning · engine 910 rpm · propeller n/a · power n/a");
    expect(telemetry.textContent).not.toMatch(/N1|N2|NaN/);
  });

  it.each(["med", "high"] as const)("sends %s the moment it is chosen, and asks for nothing more", async quality => {
    const panel = await mount(status("low"));
    await act(async () => panel.quality(quality).click());
    expect(panel.onAction).toHaveBeenCalledWith({ type: "quality", quality });
    expect(panel.onAction).toHaveBeenCalledOnce();
  });

  it("shows accepted High without calibration or validation warnings", async () => {
    const panel = await mount(status("high", { effective: "high" }));
    expect(panel.host.textContent).not.toContain("Acoustic calibration is pending");
    expect(panel.host.textContent).not.toContain("Not yet validated");
    expect(panel.host.textContent).not.toContain("FJ33 sample bank");
  });

  it("shows accepted Med running with no testing switch or evidence warning", async () => {
    const panel = await mount(status("med", { effective: "med" }));
    expect(panel.playback().textContent).toBe("Selected Med · Loaded Med");
    expect(panel.host.textContent).not.toMatch(/qualification evidence|Not yet validated/);
    expect(panel.button("anyway")).toBeUndefined();
    expect(panel.button("testing")).toBeUndefined();
  });

  it("groups all five quality steps in one track with plain labels and the saved selection", async () => {
    const panel = await mount(status("low"));
    const tracks = panel.host.querySelectorAll('[role="radiogroup"][aria-label="Sound quality"]');
    expect(tracks).toHaveLength(1);
    expect(panel.host.querySelector("select")).toBeNull();
    const options = [...tracks[0].querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(options.map(option => option.value)).toEqual(["off", "low", "med", "high", "auto"]);
    expect(options.map(option => option.closest("label")!.textContent)).toEqual(["Off", "Low", "Med", "High", "Auto"]);
    expect(options.every(option => !option.disabled)).toBe(true);
    expect(options.filter(option => option.checked).map(option => option.value)).toEqual(["low"]);
  });

  it("lets default-on sound waiting for browser activation be forced on with a fresh gesture", async () => {
    const panel = await mount(status("med", { effective: "off", gestureLocked: true }));
    expect(panel.button("Enable sound")).toBeUndefined();
    expect(panel.button("Turn sound off")).toBeDefined();
    expect(panel.playback().textContent).toBe("Selected Med · Loaded Off · waiting for a click or key press");
    await act(async () => panel.button("Force Med on")!.click());
    expect(panel.onAction.mock.calls).toEqual([[{ type: "retest" }]]);
  });

  it("offers a restart when sound is enabled but its selected implementation failed", async () => {
    const panel = await mount(status("high", { effective: "off", mode: "off", message: "Sound could not load." }));
    expect(panel.playback().textContent).toBe("Selected High · Loaded Off");
    expect(panel.host.textContent).toContain("Sound could not load.");
    await act(async () => panel.button("Force High on")!.click());
    expect(panel.onAction.mock.calls).toEqual([[{ type: "retest" }]]);
  });

  it("keeps Auto retry available even when an implementation is already loaded", async () => {
    const panel = await mount(status("auto", { effective: "low" }));
    expect(panel.playback().textContent).toBe("Selected Auto · Loaded Low");
    await act(async () => panel.button("Retry sound")!.click());
    expect(panel.onAction.mock.calls).toEqual([[{ type: "retest" }]]);
  });

  it("can restore a legacy overload downgrade to Off using the original quality", async () => {
    const panel = await mount(status("off", {
      effective: "off", mode: "off",
      settings: { ...DEFAULT_AUDIO_SETTINGS, enabled: true, requested: "off", downgradedFrom: "med" },
    }));
    expect(panel.quality("off").checked).toBe(true);
    expect(panel.host.textContent).toContain("Quality was lowered from Med after an overload");
    await act(async () => panel.button("Force Med on")!.click());
    expect(panel.onAction.mock.calls).toEqual([[{ type: "retest" }]]);
  });

  it("does not offer a force or retry action for intentionally selected Off", async () => {
    const panel = await mount(status("off", { effective: "off", mode: "off" }));
    expect(panel.button("Force")).toBeUndefined();
    expect(panel.button("Retry sound")).toBeUndefined();
  });

  it.each([
    [{ loading: true, effective: "low" }, "Selected Med · Loaded Low · loading sound"],
    [{ contextState: "suspended" }, "Selected Med · Loaded Low · suspended"],
    [{ held: true, holdReasons: ["loading", "pause"], contextState: "suspended" }, "Selected Med · Loaded Low · held: flight loading, paused"],
  ] as const)("shows the playback condition alongside selected and loaded quality: %s", async (overrides, expected) => {
    const panel = await mount(status("med", overrides));
    expect(panel.playback().textContent).toBe(expected);
  });

  it("preserves concrete capability and processor-fault messages", async () => {
    const state = status("high", { message: "Sound stopped after an audio processor fault." });
    state.availability.high = { state: "unsupported", reason: "The selected renderer has no High sound." };
    const panel = await mount(state);
    const high = panel.quality("high");
    expect(high.disabled).toBe(true);
    expect(high.closest("label")!.textContent).toBe("High");
    expect(high.closest("label")!.title).toBe("The selected renderer has no High sound.");
    expect(panel.host.textContent).toContain("The selected renderer has no High sound");
    expect(panel.host.textContent).toContain("audio processor fault");
    await act(async () => high.click());
    expect(panel.onAction).not.toHaveBeenCalled();
  });

  it("sends airframe wind volume on its own", async () => {
    const panel = await mount(status("low"));
    const slider = panel.host.querySelector<HTMLInputElement>('input[aria-label="Airframe wind volume"]')!;
    await act(async () => {
      // React tracks the value; set it through the native setter so the change is seen.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "0.25");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(panel.onAction).toHaveBeenCalledWith({ type: "settings", patch: { airframeVolume: 0.25 } });
  });

  it("leaves afterburner volume in Exhaust and shows one continuous Camera–Cockpit slider", async () => {
    const panel = await mount(status("med"));
    const afterburner = panel.host.querySelectorAll<HTMLInputElement>('input[aria-label="Afterburner volume"]');
    const position = panel.host.querySelectorAll<HTMLInputElement>('input[aria-label="Sound position"]');
    expect(afterburner).toHaveLength(0);
    expect(position).toHaveLength(1);
    expect(position[0].value).toBe("1");
    expect(position[0].type).toBe("range");
    expect(position[0].getAttribute("aria-valuetext")).toBe("Cockpit");
    expect(panel.host.textContent).toContain("Camera ↔ Cockpit");
    expect(panel.host.textContent).toContain("Listen from Camera, Cockpit, or a position between them");
  });

  it("sends a live listener blend patch", async () => {
    const panel = await mount(status("med"));
    const slider = panel.host.querySelector<HTMLInputElement>('input[aria-label="Sound position"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "0.4");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(panel.onAction.mock.calls).toEqual([
      [{ type: "settings", patch: { listenerCockpitBlend: 0.4 } }],
    ]);
  });

  it.each([[0, "Camera"], [0.75, "75% Cockpit / 25% Camera"]] as const)(
    "labels a saved listener blend of %s as %s", async (value, expected) => {
      const panel = await mount(status("med", { settings: { ...DEFAULT_AUDIO_SETTINGS, listenerCockpitBlend: value } }));
      const slider = panel.host.querySelector<HTMLInputElement>('input[aria-label="Sound position"]')!;
      expect(slider.value).toBe(String(value));
      expect(slider.getAttribute("aria-valuetext")).toBe(expected);
    },
  );

  it.each([
    ["Master volume", "masterVolume", 2],
    ["Engine volume", "engineVolume", 4],
  ] as const)("offers %s up to 800% and sends its value independently", async (label, field, value) => {
    const panel = await mount(status("med", { settings: { ...DEFAULT_AUDIO_SETTINGS, [field]: value } }));
    const slider = panel.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    expect(slider.max).toBe("8");
    expect(slider.value).toBe(String(value));
    expect(panel.host.textContent).toContain(`${label} · ${value * 100}%`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "8");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(panel.onAction.mock.calls).toEqual([[{ type: "settings", patch: { [field]: 8 } }]]);
    expect(panel.host.querySelector('input[aria-label="Afterburner volume"]')).toBeNull();
    const otherVolume = field === "masterVolume" ? "Engine volume" : "Master volume";
    const otherDefault = field === "masterVolume" ? DEFAULT_AUDIO_SETTINGS.engineVolume : DEFAULT_AUDIO_SETTINGS.masterVolume;
    expect(panel.host.querySelector<HTMLInputElement>(`input[aria-label="${otherVolume}"]`)!.value).toBe(String(otherDefault));
  });
});
