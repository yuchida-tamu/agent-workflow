import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The roster is as load-bearing as the policy packs, and gets the same rigor:
// its own definitions are validated by the suite that validates everything else.
const SOURCE = "agents";
const INSTALLED = ".claude/agents";

const definitionFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const read = (dir, file) => readFileSync(join(dir, file), "utf8");

// The one paragraph that must be present in every definition, byte-identical.
// Duplication is deliberate: a spawned subagent reads only its own definition,
// so a link to a shared document would not be in its context. The test is what
// keeps the copies from drifting.
const AUTONOMY_HEADING = "## Autonomy";
const AUTONOMY_SENTENCES = [
  "Between gates you proceed without asking.",
  "Asking permission mid-stage is a defect, not politeness.",
];

function autonomySection(text) {
  const index = text.indexOf(AUTONOMY_HEADING);
  return index === -1 ? null : text.slice(index).trim();
}

// The paragraph is hard-wrapped, so its sentences straddle newlines. Compare on
// normalised whitespace: rewrapping a line is not drift, changing a word is.
const flatten = (text) => text.replace(/\s+/g, " ").trim();

test("every agent definition carries the autonomy contract", () => {
  for (const file of definitionFiles(SOURCE)) {
    const section = autonomySection(read(SOURCE, file));
    assert.ok(section, `${file} has no ${AUTONOMY_HEADING} section`);
    for (const sentence of AUTONOMY_SENTENCES) {
      assert.ok(flatten(section).includes(sentence), `${file} is missing: "${sentence}"`);
    }
  }
});

test("the autonomy contract is byte-identical across the roster", () => {
  const files = definitionFiles(SOURCE);
  const reference = flatten(autonomySection(read(SOURCE, files[0])));
  for (const file of files) {
    assert.equal(
      flatten(autonomySection(read(SOURCE, file))),
      reference,
      `${file}'s autonomy section has drifted from ${files[0]}'s — it must be reworded everywhere or nowhere`
    );
  }
});

test("the contract names all three legitimate stop conditions", () => {
  const section = autonomySection(read(SOURCE, definitionFiles(SOURCE)[0]));
  for (const condition of ["a gate", "bounded retry", "scope change"]) {
    assert.match(section, new RegExp(condition), `stop condition "${condition}" is not named`);
  }
});

test("CLAUDE.md carries the autonomy contract as a ground rule", () => {
  const manual = readFileSync("CLAUDE.md", "utf8");
  assert.match(manual, /Autonomy between gates/);
  assert.ok(manual.includes("Asking permission mid-stage is a defect, not politeness."));
});

// --- source and installed copies must not drift ------------------------------

test("both directories hold the same set of definitions", () => {
  assert.deepEqual(
    definitionFiles(SOURCE),
    definitionFiles(INSTALLED),
    "a definition exists in one directory but not the other"
  );
});

test("every installed copy is byte-identical to its source", () => {
  for (const file of definitionFiles(SOURCE)) {
    assert.equal(
      read(INSTALLED, file),
      read(SOURCE, file),
      `${INSTALLED}/${file} has drifted from ${SOURCE}/${file} — edit both, or run the installer`
    );
  }
});
