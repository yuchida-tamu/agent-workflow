# Getting started: bringing the loop to an existing repo

This walks a repo that already exists to a first issue that goes all the way
from idea to `state:verified`, naming the gate you'll meet at each step. If
you're starting a brand-new project instead, run the `project-genesis` agent
(Opus tier) — it interviews you and does the equivalent of everything below
in one pass.

## 1. Install, labels, config, domains

From a clone of `yuchida-tamu/agent-workflow`, pointed at your project:

```sh
git clone https://github.com/yuchida-tamu/agent-workflow
cd agent-workflow && npm install

node init/cli.js adopt --target /path/to/your-repo --repo <owner>/<name>
```

`adopt` is additive and idempotent — it never overwrites a file you already
have and never forces a label. In one pass it:

- creates whichever of the 18-label set your repo is missing (states,
  priorities, risk, drift — `agentflow-init labels` under the hood);
- scaffolds `agentflow.config.json`, `domains.yml`, a starter business policy
  pack, and the `e2e/` directories, in your target repo — again, only what's
  missing;
- installs the agent definitions into `.claude/agents/`;
- reads three repo settings the loop needs — Actions access to this
  toolkit, G3 branch protection, the G4 release Environment — and **prints**
  the exact `gh api` command for whichever ones are missing. It never runs
  them; that's a policy change on your repo, so it stays a deliberate
  keystroke. Paste the printed commands yourself.

Then open `domains.yml` in your repo and map your code areas to business
criticality — even two entries is a valid starting map. `adopt --coverage`
tells you how much of your tracked source is still unmapped:

```sh
node init/cli.js adopt --coverage --target /path/to/your-repo
```

Confirm everything actually landed:

```sh
node init/cli.js adopt --verify --target /path/to/your-repo --repo <owner>/<name>
```

This also reports which **G3 mode** your repo is in — `native-review` or
`solo-comment` — and why (see step 6).

## 2. Seed the first issue

File one issue in your repo, in `state:idea`, describing the first thing you
want built. Nothing about its shape matters yet — the next stage exists to
turn a rough idea into a reviewable brief.

## 3. Shape → G1

Run the `product-shaper` agent on the issue, still in `state:idea`. It
interviews you in-session (multi-choice, per the standing UX rule) and posts
the brief as an issue comment — problem, user story, acceptance criteria,
impact domains — then asks for G1. It never edits labels itself: state
transitions are the gate workflow's job at every stage, not any agent's, so
the issue sits at `state:idea` until the gate below fires.

**Gate G1 — brief approval.** Read the brief, then post `/approve G1` as an
issue comment, from your own GitHub account. The `agentflow · gate` workflow
validates the comment (right gate, authorized approver, not bot-authored) and
transitions the issue `idea → spec` — `state:spec` means "brief approved,
awaiting plan".

```sh
node scripts/next/cli.js --repo <owner>/<name>   # confirms who acts next
```

## 4. Plan → G2 (risk-based)

Run the `architect` agent on the issue, now in `state:spec`. It maps the
terrain, writes a plan comment (approach, declared file surface, risks),
decomposes the work into one-PR-sized child issues in `state:ready`, and
runs the risk engine against the plan (`agentflow-facts --stage plan` →
`agentflow-policy evaluate`). When the plan lands, the issue moves
`spec → planned` — ungated, no approval needed.

**Gate G2 — plan approval — is conditional**, and it gates `planned →
ready`. If the risk verdict requires no human review, the transition
**auto-passes** — no comment needed, the gate workflow posts an auto-pass
note and moves on. If the verdict requires review, post `/approve G2` as an
issue comment, same as G1. Never argue a high-risk verdict down; escalating
it is the point.

## 5. Implement

Run the `implementer` agent on a child issue in `state:ready`. It works in
its own worktree, builds, self-verifies, and opens a PR — moving the issue to
`state:in-progress` then `state:in-review`.

## 6. PR / review → G3

Every PR gets an independent review — `code-reviewer` (and `ux-reviewer` for
UI surfaces) run as freshly spawned, cold subagents, never inline in the
implementer's own context.

**Gate G3 — merge — has two modes**, and `adopt --verify` (step 1) already
told you which one your repo is in:

- **`native-review`** — you've configured `agent_identity` (see
  [docs/github-app-runbook.md](github-app-runbook.md)), so agent PRs are
  authored by the App and are not "your own" PR. The approval act is a real
  **GitHub approving review** on the PR; branch protection can require it.
- **`solo-comment`** — no `agent_identity` configured, so agent PRs are
  authored by you, and GitHub forbids approving your own PR. The approval
  act is a `/approve` **comment on the PR, naming the head SHA**, then you
  merge it yourself, then transition the issue label by hand:
  `node scripts/state/cli.js apply --issue N --to merged --approved-gate G3`.

A repo with no App configured is in `solo-comment` mode by default — that's
a legitimate steady state, not an unfinished setup.

## 7. Merged → verified

Once merged, the post-merge step runs `agentflow-e2e smoke` against your
scenario suite (vacuously passing on an empty suite — that's a fact about
your repo's coverage, not a failure) and, if it passes, transitions
`merged → verified`. No gate here — G3 already covered the human judgment
call.

If your repo releases (`release_kind: tag`), `verified → released` is
**Gate G4**: post `/approve G4` on the issue, same act as G1/G2, and
`agentflow-release --repo <owner>/<name> --issue N` consumes that recorded
approval to tag and publish the release — it never mints one of its own.

## Leveling up

Two things above are the "starter" configuration; both have a runbook once
you outgrow it:

- **[docs/github-app-runbook.md](github-app-runbook.md)** — give agentflow
  its own GitHub identity, so G3 becomes `native-review` and agent feedback
  is visibly the agent's, not yours.
- **[docs/headless-runbook.md](headless-runbook.md)** — let GitHub events
  launch agents on a runner instead of your own Claude Code session, billed
  to your Claude subscription rather than metered API credits.
