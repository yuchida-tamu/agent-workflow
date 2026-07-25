// E2E replay runner core: deterministic, adapter-agnostic.
//
// `invoke(interfaceName, payload)` is injected (the CLI spawns pack adapter
// executables; tests inject fakes). `loadTrace(scenario)` returns the compiled
// trace or null. The runner never derives traces itself — derivation is an
// agent task; the runner *emits* `needs-derivation` so the dispatch layer can
// schedule it. That boundary is what keeps this module on rung L0.

export async function runScenario(scenario, { invoke, loadTrace }) {
  const trace = await loadTrace(scenario);
  const traceSteps = new Map(
    (trace?.steps ?? []).map((s) => [`${s.keyword} ${s.text}`, s.trace])
  );

  const session = await invoke("run", { op: "start" });
  const steps = [];
  let status = "passed";
  try {
    for (const step of scenario.steps) {
      if (status !== "passed") {
        // Once a step couldn't run, the app state is unknown — don't execute
        // the rest. Derivation re-runs the scenario from the top anyway.
        steps.push({ ...step, status: "skipped" });
        continue;
      }
      const stepTrace = traceSteps.get(`${step.keyword} ${step.text}`);
      if (!stepTrace) {
        steps.push({ ...step, status: "needs-derivation" });
        status = "needs-derivation";
        continue;
      }
      const result = await invoke("execute-step", {
        op: "execute",
        session_id: session.session_id,
        step: { keyword: step.keyword, text: step.text },
        trace: stepTrace,
      });
      steps.push({ ...step, status: result.status, duration_ms: result.duration_ms, failure: result.failure });
      if (result.status !== "passed") {
        status = "failed";
      }
    }
  } finally {
    await invoke("run", { op: "stop", session_id: session.session_id });
  }
  return { scenario: scenario.name, feature: scenario.feature, tags: scenario.tags, status, steps };
}

export async function runScenarios(scenarios, deps) {
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, deps));
  }
  const summary = { passed: 0, failed: 0, "needs-derivation": 0 };
  for (const r of results) summary[r.status] = (summary[r.status] ?? 0) + 1;
  return { summary, results };
}
