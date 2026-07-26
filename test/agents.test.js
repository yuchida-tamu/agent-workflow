import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

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

// Slice one `## ` section, stopping at the next heading rather than at the end
// of the file — definitions carry several standard sections, and a comparison
// that swallowed the ones below would pass for the wrong reason.
function section(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return (heading + (next === -1 ? rest : rest.slice(0, next))).trim();
}

const autonomySection = (text) => section(text, AUTONOMY_HEADING);

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

// --- frontmatter validation ---------------------------------------------------
//
// PR #9 fixed malformed `tools:` frontmatter that this toolkit had shipped in
// two of its own definitions. Policy packs validate themselves as part of the
// suite; the roster is just as load-bearing and now gets the same treatment.

const TIERS = ["opus", "sonnet", "haiku"];

function frontmatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${file} has no frontmatter block`);
  let parsed;
  try {
    parsed = parseYaml(match[1]);
  } catch (err) {
    assert.fail(`${file} frontmatter does not parse: ${err.message}`);
  }
  assert.ok(parsed && typeof parsed === "object", `${file} frontmatter is not a mapping`);
  return parsed;
}

test("every definition has parseable frontmatter with the required keys", () => {
  for (const file of definitionFiles(SOURCE)) {
    const meta = frontmatter(read(SOURCE, file), file);
    for (const key of ["name", "description", "model"]) {
      assert.ok(
        typeof meta[key] === "string" && meta[key].trim() !== "",
        `${file} is missing a non-empty "${key}"`
      );
    }
  }
});

test("each definition's name matches its filename", () => {
  for (const file of definitionFiles(SOURCE)) {
    const meta = frontmatter(read(SOURCE, file), file);
    assert.equal(meta.name, file.replace(/\.md$/, ""), `${file} declares name "${meta.name}"`);
  }
});

test("every model is one of the sanctioned tiers", () => {
  for (const file of definitionFiles(SOURCE)) {
    const meta = frontmatter(read(SOURCE, file), file);
    assert.ok(TIERS.includes(meta.model), `${file} declares model "${meta.model}", not one of ${TIERS.join("/")}`);
  }
});

test("tools is optional, but well-formed when present", () => {
  // Absence is legal and deliberate: it grants the full toolset, which
  // implementer, project-genesis and adoption-auditor rely on. Do not "fix" a
  // definition by adding `tools: All tools` — that parses as two tool names
  // that do not exist, leaving the agent with none. That was the PR #9 bug.
  for (const file of definitionFiles(SOURCE)) {
    const meta = frontmatter(read(SOURCE, file), file);
    if (!Object.hasOwn(meta, "tools")) continue;
    assert.equal(typeof meta.tools, "string", `${file} tools must be a comma-separated string`);
    const names = meta.tools.split(",").map((t) => t.trim());
    assert.ok(names.length > 0, `${file} declares an empty tools list`);
    for (const name of names) {
      assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/, `${file} declares a malformed tool name "${name}"`);
    }
  }
});

test("at least one definition omits tools, and the suite tolerates it", () => {
  const withoutTools = definitionFiles(SOURCE).filter(
    (file) => !Object.hasOwn(frontmatter(read(SOURCE, file), file), "tools")
  );
  assert.ok(withoutTools.length > 0, "expected some definitions to grant the full toolset by omission");
});

test("the roster covers all three tiers — routing is real, not aspirational", () => {
  const models = new Set(definitionFiles(SOURCE).map((f) => frontmatter(read(SOURCE, f), f).model));
  assert.deepEqual([...models].sort(), [...TIERS].sort());
});

// --- the run ledger contract --------------------------------------------------

const LEDGER_HEADING = "## Run ledger";

test("every agent definition instructs the agent to open and close a ledger row", () => {
  for (const file of definitionFiles(SOURCE)) {
    const ledger = section(read(SOURCE, file), LEDGER_HEADING);
    assert.ok(ledger, `${file} has no ${LEDGER_HEADING} section`);
    assert.match(ledger, /agentflow-log start/, `${file} never opens a row`);
    assert.match(ledger, /agentflow-log end/, `${file} never closes a row`);
  }
});

test("the ledger instruction is identical across the roster", () => {
  const files = definitionFiles(SOURCE);
  const reference = flatten(section(read(SOURCE, files[0]), LEDGER_HEADING));
  for (const file of files) {
    assert.equal(
      flatten(section(read(SOURCE, file), LEDGER_HEADING)),
      reference,
      `${file}'s ledger section has drifted — reword it everywhere or nowhere`
    );
  }
});

test("the contract covers failure, so an abandoned run is recorded not left open", () => {
  const ledger = section(read(SOURCE, definitionFiles(SOURCE)[0]), LEDGER_HEADING);
  assert.match(ledger, /abandoned/);
  assert.match(flatten(ledger), /including when you fail/);
});

test("the autonomy section is compared in isolation from the sections below it", () => {
  // Guards the extraction itself: if `section` ever swallowed the ledger block,
  // these two would no longer be distinguishable and both comparisons would
  // pass for the wrong reason.
  const text = read(SOURCE, definitionFiles(SOURCE)[0]);
  const autonomy = section(text, AUTONOMY_HEADING);
  assert.ok(!autonomy.includes(LEDGER_HEADING), "autonomy section must stop at the next heading");
  assert.ok(!section(text, LEDGER_HEADING).includes(AUTONOMY_HEADING));
});
