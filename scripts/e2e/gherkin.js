// Minimal Gherkin parser for the subset in scenarios/SPEC.md:
// Feature, Scenario, Given/When/Then/And/But, @tags, # comments.

const STEP_KEYWORDS = { given: "given", when: "when", then: "then" };

export function parseFeature(text, sourceName = "<input>") {
  const feature = { name: null, tags: [], scenarios: [] };
  let pendingTags = [];
  let scenario = null;
  let lastKeyword = null;

  const fail = (lineNo, msg) => {
    throw new Error(`${sourceName}:${lineNo}: ${msg}`);
  };

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    const lineNo = i + 1;
    if (!line || line.startsWith("#")) return;

    if (line.startsWith("@")) {
      pendingTags.push(...line.split(/\s+/).filter((t) => t.startsWith("@")));
      return;
    }
    if (line.startsWith("Feature:")) {
      if (feature.name) fail(lineNo, "multiple Feature declarations");
      feature.name = line.slice("Feature:".length).trim();
      feature.tags = pendingTags;
      pendingTags = [];
      return;
    }
    if (line.startsWith("Scenario:")) {
      if (!feature.name) fail(lineNo, "Scenario before Feature");
      scenario = {
        name: line.slice("Scenario:".length).trim(),
        tags: [...feature.tags, ...pendingTags],
        steps: [],
      };
      pendingTags = [];
      lastKeyword = null;
      feature.scenarios.push(scenario);
      return;
    }

    const match = line.match(/^(Given|When|Then|And|But)\s+(.+)$/);
    if (!match) fail(lineNo, `unrecognized line: "${line}"`);
    if (!scenario) fail(lineNo, "step before any Scenario");
    let keyword = STEP_KEYWORDS[match[1].toLowerCase()];
    if (!keyword) {
      if (!lastKeyword) fail(lineNo, `"${match[1]}" cannot start a scenario`);
      keyword = lastKeyword; // And / But inherit
    }
    lastKeyword = keyword;
    scenario.steps.push({ keyword, text: match[2].trim() });
  });

  if (!feature.name) fail(1, "no Feature declaration");
  return feature;
}

// A scenario is selected when it carries every tag in `tags` (empty = all).
export function selectScenarios(features, tags = []) {
  const selected = [];
  for (const feature of features) {
    for (const scenario of feature.scenarios) {
      if (tags.every((t) => scenario.tags.includes(t))) {
        selected.push({ feature: feature.name, ...scenario });
      }
    }
  }
  return selected;
}

export function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
