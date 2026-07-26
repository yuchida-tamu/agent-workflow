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
6. **Review is independent and Opus-tier.** code-reviewer and ux-reviewer run
   as **freshly spawned subagents** (Task tool), never inline in the context
   that implemented — a reviewer that knows *why* the code was written is
   contaminated and must be re-run cold. Their inputs are the PR, the brief's
   acceptance criteria, and the codebase; nothing else. Structural enforcement
   arrives with headless auto-review (#83); until then this rule is the
   enforcement.

## Operating the loop (crawl phase)

```sh
node scripts/next/cli.js --repo yuchida-tamu/agent-workflow   # who acts next
```

Run the named agent by following its definition — they're spawnable from
`.claude/agents/` (installed copies) with source of truth in `agents/`.
If you edit `agents/*.md`, update the copy in `.claude/agents/` too.

Gates: `/approve` is an **issue** command, for G1/G2/G4 only — the
`agentflow · gate` workflow validates it and applies the transition
(it deliberately ignores PR comments). **G3 has two modes**, decided by who
authors the agent PRs — `adopt --verify` reports which one and why:

- `native-review` — `agent_identity` is set, so agent PRs are authored by the
  App and a human can submit a real approving review.
- `solo-comment` — no `agent_identity`, so agent PRs are the human's own and
  GitHub forbids self-review. The artifact is an `/approve` comment on the PR
  naming the head SHA, then merge, then transition the issue manually.

**This repo is in `solo-comment` mode today** — the plumbing exists (#82), the
App itself has not been created, and creating it is a browser action only a
human can take: `docs/github-app-runbook.md`. #18 completes the solo path
(SHA-stamped validation + merge-event transition). Manual fallback:
`node scripts/state/cli.js apply --issue N --to <state> --approved-gate G1..G4`.

**Agents may not approve gates, and this is now enforced in code** rather than
by this sentence. `validateApproval` refuses any bot-authored `/approve` before
it consults `approvers`, and `approvers` is validated as human logins only. The
single exception is G3 on a PR whose recorded verdict already authorises an
unattended merge — there the App transcribes an engine decision, it does not
mint one.

**Headless stages (Phase 3).** `headless.review` is shipped: a `pull_request`
launches the code-reviewer on a runner with no session. Dispatch launch
(`headless.dispatch.<state>`) is built but not yet enabled for any state, and
nightly QA is deferred. Every flag ships off, so a repo that sets nothing is
unchanged. Runs are billed to a Claude subscription via
`CLAUDE_CODE_OAUTH_TOKEN` — `ANTHROPIC_API_KEY` is unsupported by design and is
stripped from the child environment. Setup and token rotation:
`docs/headless-runbook.md`.

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
- Parent↔child is structural: the architect attaches children as native GitHub
  sub-issues (the endpoint takes the issue **id**, not its number). Where that
  API is unavailable the fallback is a `Child of #N` line at the top of a child's
  body — children are always derived from what *declares* the parent, never from
  what a parent mentions. `scripts/hierarchy/` owns both paths and reports which
  one answered.
- Dependent children may stack on an `integrate/<topic>` branch and merge to
  main through one integration PR (G3 on that PR; its body lists the children
  it subsumes). Independent children go one-PR-to-main. **Unwind order: children
  merge before the base, or the base branch is deleted so GitHub retargets them.
  `--delete-branch=false` suppresses that retarget and strands the rest** — it
  merged three PRs into a dead branch on 2026-07-26. A merge is not evidence of
  delivery: `git merge-base --is-ancestor <head> origin/main` is. A mid-run change to an
  approved plan is a **Plan amendment** comment linking the original plan, with
  every affected child issue edited to match — see `agents/architect.md`.
