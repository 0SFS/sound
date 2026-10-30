import { describe, expect, it, vi } from "vitest";
import type { OsfsModManifest } from "@0sfs/mods/schema";
import io320 from "../../IO320/public/0sfs-mod.json";
import pistonSound from "../../piston-sound/public/0sfs-mod.json";
import { installAudioMod, onAudioModsChanged, uninstallAudioMod } from "../src/installAudioMod";
import { getEngineAcousticDefinition } from "../src/engineAcousticDefinitions";
import { getAudioRenderer } from "../src/audioRendererRegistry";
import { getAircraftAudioInstallation } from "../src/aircraftAudioProfiles";
import c172 from "../../C172/public/0sfs-mod.json";

describe("mod-owned audio registration", () => {
  it("uses an edited engine profile and restores the underlying installed profile on removal", () => {
    const original = getEngineAcousticDefinition("io320-piston")!;
    const replacement = structuredClone(io320) as OsfsModManifest;
    replacement.engine!.acousticProfile!.parameters = { ...(original.parameters as object), firingGain: 0.123 };
    const listener = vi.fn();
    const stop = onAudioModsChanged(listener);
    try {
      installAudioMod(replacement, { owner: "local-engine" });
      expect(getEngineAcousticDefinition(original.id)?.parameters).toMatchObject({ firingGain: 0.123 });
      uninstallAudioMod(replacement, "local-engine");
      expect(getEngineAcousticDefinition(original.id)).toBe(original);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally { stop(); uninstallAudioMod(replacement, "local-engine"); }
  });
  it("resolves relative local mod bases and restores the installed renderer after replacement", () => {
    const original = getAudioRenderer("procedural-piston-v1")!;
    const replacement = structuredClone(pistonSound) as OsfsModManifest;
    try {
      installAudioMod(replacement, { owner: "local-renderer", baseUrl: "/dev-mods/piston-sound/" });
      expect(getAudioRenderer(original.id)?.voiceWasmUrl?.href).toBe("http://localhost/dev-mods/piston-sound/audio/piston-sound/voice.wasm");
      uninstallAudioMod(replacement, "local-renderer");
      expect(getAudioRenderer(original.id)).toBe(original);
    } finally { uninstallAudioMod(replacement, "local-renderer"); }
  });
  it("restores aircraft source installations when a replacement aircraft is removed", () => {
    const original = getAircraftAudioInstallation("cessna-172")!;
    const replacement = structuredClone(c172) as OsfsModManifest;
    replacement.aircraft!.audio!.engineDefinitionId = "replacement-profile";
    try {
      installAudioMod(replacement, { owner: "local-aircraft" });
      expect(getAircraftAudioInstallation("cessna-172")?.engineSources[0].engineDefinitionId).toBe("replacement-profile");
      uninstallAudioMod(replacement, "local-aircraft");
      expect(getAircraftAudioInstallation("cessna-172")).toBe(original);
    } finally { uninstallAudioMod(replacement, "local-aircraft"); }
  });
});
