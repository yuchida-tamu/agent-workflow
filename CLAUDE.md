# agent-workflow

Platform-agnostic agentic development loop on GitHub. This repo is the
toolkit **and its own first consumer** — the loop manages this backlog.

Architecture: `agent-loop-architecture.html` (the authoritative design).
Build status: `README.md`. Repo: `yuchida-tamu/agent-workflow`.

## Ground rules (non-negotiable)

1. **Determinism-first.** Anything a script can decide is a script (zero
   tokens). Agents only for judgment. Deterministic checks run before any
   agent spend.
2. **Model routing:** Haiku for closed-set classification, Sonnet for
   rubric-bound work, Opus for open-ended judgment. Never a higher tier for
   mechanical work.
3. **GitHub is the record, not the conversation.** Interview humans
   in-session with multi-choice (AskUserQuestion); issues/PRs receive
   artifacts. Gate approvals: collect the decision in-session, then post
   `/approve` via the human's own `gh` account.
4. **Agents never**: transition state labels, mint gate approvals, or file
   issues directly (structured reports go through the filer scripts).
5. **Autonomy between gates.** Human decisions live *only* at gates (G1–G4)
   and at exhausted bounded retries. Between them, proceed without asking —
   chain shape → G1 → plan → G2-if-demanded → implement → review → G3 in one
   run. Stop only at: a gate, an exhausted bounded retry, or a genuine scope
   change beyond the approved brief. Uncertainty that doesn't block you is not
   a reason to ask: proceed under a stated assumption and record it in the
   artifact. **Asking permission mid-stage is a defect, not politeness.**
   When several items wait at the same gate, batch them into one approval
   round rather than prompting per item.

## Operating the loop (crawl phase)

```sh
node scripts/next/cli.js --repo yuchida-tamu/agent-workflow   # who acts next
```

Run the named agent by following its definition — they're spawnable from
`.claude/agents/` (installed copies) with source of truth in `agents/`.
If you edit `agents/*.md`, update the copy in `.claude/agents/` too.

Gates: the `agentflow · gate` workflow validates `/approve` comments and
applies transitions automatically. Manual fallback:
`node scripts/state/cli.js apply --issue N --to <state> --approved-gate G1..G4`.

Work-item states: `idea → spec → planned → ready → in-progress → in-review
→ merged → verified → released`; gates G1 (brief) G2 (plan, risk-based)
G3 (merge) G4 (release). `domains.yml` here maps the toolkit's own code;
PRs get risk verdicts from baseline + `policies/business.yml`.

## Conventions

- Node ESM, zero deps except `yaml`. Tests: `npm test` (node:test, `test/`).
- Pure logic in modules (`engine.js`, `machine.js`, `core.js`); I/O only in
  `cli.js` / `scripts/actions/*.js`. New logic gets tests.
- Policy packs carry embedded fixture `tests:` — run
  `node scripts/policy/cli.js test policies/baseline.yaml packs/expo/policies/expo.yaml`.
- Commit style: imperative subject, body explains why; every commit leaves
  `npm test` green.
