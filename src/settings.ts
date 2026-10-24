import type { ParameterSpec } from "foss-earth/settings";
import {
  catalogueDefaults,
  catalogueSpec,
  catalogueStore,
  type CatalogueParameters,
  type CatalogueRegistry,
  type CatalogueStore,
  type CatalogueValues,
} from "@0sfs/engines/parameterCatalogue";

/**
 * The flight sound's flight parameters: its part of the flight's settings, with
 * their homes, section titles and defaults. The host composes the parts into
 * its catalogue in this order and registers them. Spec:
 * docs/proposals/flight-settings.md.
 */

const SOUND = { tab: "sound", section: "sound" } as const;
const AFTERBURNER = { tab: "exhaust", section: "afterburner" } as const;

/** Section titles for the sections only the flight sound's parameters are in, by tab and section id. */
export const SOUND_SECTION_TITLES_1: readonly (readonly [tab: string, section: string, title: string])[] = [
  ["exhaust", "afterburner", "Afterburner"],
];

/** Section titles for the sections only the flight sound's parameters are in, by tab and section id. */
export const SOUND_SECTION_TITLES_2: readonly (readonly [tab: string, section: string, title: string])[] = [
  ["sound", "sound", "Sound"],
];

const main = <T extends { tab: string; section: string }>(home: T) => ({ ...home, level: "main" as const });
const all = <T extends { tab: string; section: string }>(home: T) => ({ ...home, level: "all" as const });
const within = (min: number, max: number) => () => ({ min, max });

export const SOUND_PARAMETERS = [
  // Sound tiers are a discrete choice, drawn as one shared segmented slider.
  // Manual tiers stay selected; Auto's live fallback never overwrites the choice.
  {
    id: "osfs.sound.enabled",
    label: "Sound",
    description: "The master switch: off releases the sound engine and silences the engine and tyres.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "Sound is on by default at the pilot's request; a normal interaction unlocks browser audio, and an explicit saved off preference is respected.",
    home: main(SOUND),
    appliesLive: true,
    source: "sound/src/createFlightAudio.ts",
  },
  {
    id: "osfs.sound.quality",
    label: "Sound tier",
    description: "Low, Med and High hold the selected quality. Auto chooses the highest supported tier and can lower it after overload. Force on or Retry sound restarts audio without reloading.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "off", label: "Off" },
      { id: "low", label: "Low", description: "Procedural, light." },
      { id: "med", label: "Med", description: "Procedural, with a cabin impulse response." },
      { id: "high", label: "High", description: "Procedural engine spectra and directionality." },
      { id: "auto", label: "Auto" },
    ],
    default: "med",
    defaultReason: "Med is the pilot's chosen default; Low, Med and High have been accepted in listening tests.",
    home: main(SOUND),
    appliesLive: true,
    source: "sound/src/audioQuality.ts",
  },
  soundVolume("masterVolume", "Master volume", "Scales the flight sound mix up to eight times the previous master maximum, before output limiting.", 2,
    "Twice the previous master maximum, chosen by the pilot after testing all volume sliders at maximum.", 8),
  soundVolume("engineVolume", "Engine volume", "Scales the engine and its afterburner sound, independently of the airframe, up to eight times its original level.", 0.8,
    "The original level is preserved; extra headroom is available for a quiet engine.", 8),
  soundVolume("afterburnerVolume", "Afterburner volume", "Scales the combustion-driven afterburner roar and its spectrum changes. Zero removes those additions; native thrust, shaft speed and fuel can still change the underlying engine sound.", 0.5,
    "Retain the pilot's preferred 50% control value; the combustion-driven sound contribution remains uncalibrated."),
  soundVolume("airframeVolume", "Airframe volume", "Scales wind and gear and flap turbulence, independently of the engine.", 0.6),
  {
    id: "osfs.sound.listenerCockpitBlend",
    label: "Sound position",
    description: "Blends the acoustic viewpoint from Camera (0) to Cockpit (1), including listener position, motion and cabin/exterior treatment. Intermediate viewpoints are artistic.",
    unit: "fraction",
    kind: "number",
    step: 0.01,
    bounds: within(0, 1),
    default: 1,
    defaultReason: "Cockpit sound stays at the pilot even when the visual camera moves outside the aircraft.",
    home: main(SOUND),
    appliesLive: true,
    source: "sound/src/audioPose.ts",
  },
  {
    id: "osfs.sound.engineMuted",
    label: "Mute engine",
    description: "Silences the engine and keeps the airframe and tyres.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: "The engine is heard.",
    home: main(SOUND),
    appliesLive: true,
    source: "sound/src/createFlightAudio.ts",
  },
  {
    id: "osfs.sound.reducedDynamicRange",
    label: "Reduced dynamic range",
    description: "Narrows the difference between loud and quiet sounds.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: "The full range the synthesis produces.",
    home: main(SOUND),
    appliesLive: true,
    source: "sound/src/createFlightAudio.ts",
  },
  {
    id: "osfs.sound.downgradedFrom",
    label: "Downgraded from",
    description: "A saved downgrade from an older version; Force on or Retry sound restores the original request. Current Auto fallback keeps the saved quality unchanged.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "none", label: "Not downgraded" },
      { id: "off", label: "Off" },
      { id: "low", label: "Low" },
      { id: "med", label: "Med" },
      { id: "high", label: "High" },
      { id: "auto", label: "Auto" },
    ],
    default: "none",
    defaultReason: "Nothing has been dropped yet.",
    home: all(SOUND),
    appliesLive: true,
    source: "sound/src/createFlightAudio.ts",
  },

  // Sound → what each tier may use at most. The caps are the tier budgets of
  // sound.md §1; these can only lower them, and shedding under load works
  // down from here.
  soundLimit("low", "partials", "Low: engine oscillators", "How many engine partials Low synthesises; the N1 and N2 fundamentals come first.", "count", 2, 4, 1),
  soundLimit("low", "noiseBands", "Low: noise sources", "How many engine and airframe noise bands Low synthesises, excluding the separate tire source.", "count", 0, 5, 1),
  soundLimit("med", "partials", "Med: engine oscillators", "How many engine partials Med synthesises; the N1 and N2 fundamentals come first.", "count", 2, 12, 1),
  soundLimit("med", "noiseBands", "Med: noise sources", "How many engine and airframe noise bands Med synthesises, excluding the separate tire source.", "count", 0, 6, 1),
  soundLimit("med", "irMs", "Med: cabin impulse response", "The length of the cabin and airframe colouring Med convolves with.", "ms", 0, 20, 1),
  soundLimit("high", "partials", "High: engine oscillators", "How many engine partials High synthesises; the N1 and N2 fundamentals come first.", "count", 2, 12, 1),
  soundLimit("high", "noiseBands", "High: noise sources", "How many engine and airframe noise bands High synthesises, excluding the separate tire source.", "count", 0, 8, 1),
  soundLimit("high", "irMs", "High: cabin impulse response", "The length of the cabin and airframe colouring High convolves with.", "ms", 0, 40, 1),
] as const satisfies readonly ParameterSpec[];

/** The effective value of each of the flight sound's parameters, by id. */
export type SoundParameterValues = CatalogueValues<typeof SOUND_PARAMETERS>;

export type SoundParameterId = keyof SoundParameterValues & string;

/** What the flight sound code reads its parameters through: the registry, or its defaults in a test. */
export type SoundParameters = CatalogueParameters<SoundParameterValues>;

/** Reads, writes and watches the flight sound's parameters, typed by id. */
export type SoundParameterStore = CatalogueStore<SoundParameterValues>;

/** The registry, typed for the flight sound's parameters. */
export function soundParameterStore(registry: CatalogueRegistry): SoundParameterStore {
  return catalogueStore(registry);
}

/** The spec of one of the flight sound's parameters. */
export const soundParameterSpec = catalogueSpec(SOUND_PARAMETERS);

/**
 * The flight sound's parameter defaults in memory, for code that runs without a
 * registry, such as a unit test. Overrides stand in for values the test sets.
 */
export function soundParameterDefaults(overrides: Partial<SoundParameterValues> = {}): SoundParameterStore {
  return catalogueDefaults(soundParameterSpec, overrides);
}

function soundVolume<Field extends string>(field: Field, label: string, description: string, value: number,
  defaultReason = "The original level.", maximum = 1) {
  return {
    id: `osfs.sound.${field}` as const,
    label,
    description,
    unit: "fraction" as const,
    kind: "number" as const,
    step: 0.05,
    bounds: within(0, maximum),
    default: value,
    defaultReason,
    home: main(field === "afterburnerVolume" ? AFTERBURNER : SOUND),
    appliesLive: true,
    source: "sound/src/createFlightAudio.ts",
  };
}

function soundLimit<Tier extends string, Field extends string>(
  tier: Tier, field: Field, label: string, description: string,
  unit: "count" | "ms" | "per-s", min: number, cap: number, step: number,
) {
  return {
    id: `osfs.sound.${tier}.${field}` as const,
    label,
    description,
    unit,
    kind: "number" as const,
    step,
    bounds: () => ({ min, max: cap, reason: "The tier's budget in docs/sound.md §1" }),
    default: cap,
    defaultReason: "The tier's full budget; shedding lowers it under load.",
    home: all(SOUND),
    appliesLive: true,
    source: "sound/src/core.cpp",
  };
}
