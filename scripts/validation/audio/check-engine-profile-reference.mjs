#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Short deterministic output comparison, not a timing/device benchmark.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newOutputDirectory } from "../../../../fly/scripts/outputDirectory.mjs";
import { REFERENCE_CASES, renderReference } from "./engineProfileReference.mjs";

const root = fileURLToPath(new URL("../../../../fly/", import.meta.url));

async function main(args) {
  const option = name => args.find(arg => arg.startsWith(name + "="))?.slice(name.length + 1);
  const referenceWasm = option("--reference-wasm");
  const referenceHeader = option("--reference-header");
  if (!referenceWasm || !referenceHeader) throw new Error("Provide --reference-wasm=... and --reference-header=...");
  const out = option("--output") ?? newOutputDirectory("validation", "audio-engine-reference");
  mkdirSync(out, { recursive: true });
  const cases = [];
  for (const configuration of REFERENCE_CASES) {
    const reference = await renderReference(referenceWasm, referenceHeader, configuration);
    const current = await renderReference(path.join(root, "../sound/src/audio-dsp.wasm"),
      path.join(root, "../sound/src/snapshot.h"), configuration);
    let differences = 0;
    let maxAbsoluteDifference = 0;
    for (const channel of ["left", "right"]) {
      for (let i = 0; i < reference[channel].length; i++) {
        const difference = Math.abs(current[channel][i] - reference[channel][i]);
        if (difference !== 0) differences++;
        maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
      }
    }
    cases.push({ ...configuration, frames: current.left.length,
      referenceWasmSha256: reference.wasmSha256, currentWasmSha256: current.wasmSha256,
      referenceOutputSha256: reference.outputSha256, currentOutputSha256: current.outputSha256,
      differences, maxAbsoluteDifference });
  }
  const report = { schema: "0sfs-engine-profile-reference/1", scope: "Short offline WASM output identity; no device/timing/acoustic qualification",
    passed: cases.every(item => item.differences === 0), cases };
  writeFileSync(path.join(out, "sf50-reference.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ outputDirectory: out, passed: report.passed, cases: cases.length }));
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
