#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Identifies the committed audio DSP artifact and checks it against its
// provenance record. With --dist it also proves the production bundle actually
// emitted the WASM and the worklet, under whatever base path was built.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { verifyFamily } from "../../engine-sound/scripts/family-artifact.mjs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../fly/", import.meta.url));
const dspDir = path.join(root, "../sound/src");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function walk(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

export async function verifyAudioArtifact({ dist = null } = {}) {
  const provenancePath = path.join(dspDir, "audio-dsp.provenance.json");
  if (!existsSync(provenancePath)) {
    throw new Error("Missing audio-dsp.provenance.json. Run: node scripts/build-audio-wasm.mjs");
  }
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const wasmPath = path.join(dspDir, "audio-dsp.wasm");
  if (!existsSync(wasmPath)) {
    throw new Error("Missing audio-dsp.wasm. Run: node scripts/build-audio-wasm.mjs");
  }
  const bytes = readFileSync(wasmPath);
  const actual = sha256(bytes);
  if (actual !== provenance.wasm.sha256) {
    throw new Error(`audio-dsp.wasm sha256 ${actual} does not match its provenance record `
      + `${provenance.wasm.sha256}. Rebuild, or restore the committed pair together.`);
  }

  // Source drift is the signal that matters: identical sources may still emit
  // different bytes, but changed sources with an unchanged artifact mean the
  // committed WASM no longer corresponds to the code in the tree.
  const drifted = provenance.sources.filter((entry) => {
    const file = path.join(dspDir, entry.file);
    return !existsSync(file) || sha256(readFileSync(file)) !== entry.sha256;
  }).map((entry) => entry.file);
  if (drifted.length > 0) {
    throw new Error("Audio DSP sources changed since the committed WASM was built: "
      + drifted.join(", ") + ". Run: node scripts/build-audio-wasm.mjs");
  }

  const module = await WebAssembly.compile(bytes);
  const exported = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  const missing = provenance.exports.filter((name) => !exported.has(name));
  if (missing.length > 0) throw new Error("Missing WASM exports: " + missing.join(", "));

  const families = [];
  for (const family of ["turbine-sound", "piston-sound"]) {
    const familyReport = await verifyFamily(new URL(`../../${family}/`, import.meta.url));
    const manifest = JSON.parse(readFileSync(path.join(root, "..", family, "public/0sfs-mod.json")));
    if(manifest.audioRenderer.wasm.sha256 !== familyReport.sha256) throw new Error(`${family} manifest/artifact hash mismatch`);
    families.push({...familyReport,family});
  }
  const electricRoot=path.join(root,"../electric-sound");
  const electricReceipt=JSON.parse(readFileSync(path.join(electricRoot,"wasm/build-metadata.json")));
  for(const [file,digest] of Object.entries(electricReceipt.inputs)) if(sha256(readFileSync(path.join(electricRoot,file)))!==digest)throw new Error(`Electric source drift ${file}`);
  const electricManifest=JSON.parse(readFileSync(path.join(electricRoot,"public/0sfs-mod.json")));
  const electricBytes=readFileSync(path.join(electricRoot,"public",electricManifest.audioRenderer.wasm.path));
  const electricHash=sha256(electricBytes);
  if(electricHash!==electricManifest.audioRenderer.wasm.sha256)throw new Error("Electric manifest/artifact hash mismatch");
  for(const [file,record] of Object.entries(electricReceipt.outputs)){const content=readFileSync(path.join(electricRoot,file));if(sha256(content)!==record.sha256||content.length!==record.bytes)throw new Error(`Electric artifact drift ${file}`);}
  families.push({family:"electric-sound",sha256:electricHash,bytes:electricBytes.length});
  const report = {
    artifact: "audio-dsp.wasm",
    families,
    license: provenance.license,
    bytes: bytes.length,
    sha256: actual,
    toolchain: provenance.toolchain,
    sources: provenance.sources.length,
    imports: provenance.imports,
  };

  if (dist) {
    const distRoot = path.resolve(root, dist);
    if (!existsSync(distRoot)) throw new Error(`No such dist directory: ${distRoot}`);
    const files = walk(distRoot).map((file) => path.relative(distRoot, file));
    const emittedWasm = files.filter((file) => /audio-dsp.*\.wasm$/.test(file));
    const emittedWorklet = files.filter((file) => /dspProcessor.*\.js$/.test(file));
    if (emittedWasm.length === 0) throw new Error("The production bundle emitted no audio DSP wasm.");
    if (emittedWorklet.length === 0) throw new Error("The production bundle emitted no audio worklet.");
    const emittedHashes=new Set(files.filter(file=>file.endsWith(".wasm")).map(file=>sha256(readFileSync(path.join(distRoot,file)))));
    for(const family of families)if(!emittedHashes.has(family.sha256))throw new Error(`Production bundle missing ${family.family} WASM`);
    const bundled = readFileSync(path.join(distRoot, emittedWasm[0]));
    if (sha256(bundled) !== actual) {
      throw new Error("The emitted wasm differs from the committed artifact.");
    }
    // A root-absolute reference breaks every non-root deployment, which is how
    // this project is actually published (GitHub Pages under /<repo>/).
    const index = readFileSync(path.join(distRoot, "index.html"), "utf8");
    const base = index.match(/(?:src|href)="([^"]*?)assets\//)?.[1] ?? "/";
    const worklet = readFileSync(path.join(distRoot, emittedWorklet[0]), "utf8");
    if (/["'`]\/audio\//.test(worklet)) {
      throw new Error("The worklet contains a root-absolute /audio/ URL; it cannot deploy under a base path.");
    }
    report.dist = { base, wasm: emittedWasm, worklet: emittedWorklet };
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const distArgument = process.argv.find((value) => value.startsWith("--dist"));
  const dist = distArgument ? (distArgument.split("=")[1] ?? "dist") : null;
  console.log(JSON.stringify(await verifyAudioArtifact({ dist }), null, 2));
}
