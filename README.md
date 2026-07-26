# agent-workflow

A platform-agnostic agentic development loop that runs on GitHub. Ideas
arrive as issues and leave as shipped, tested, released features, with
humans present only at deliberate approval gates. Everything a script can
decide, a script decides — agents spend tokens only on judgment.

📐 **Architecture:** [`agent-loop-architecture.html`](agent-loop-architecture.html)
(the authoritative design, with an interactive wiring graph). 🚧 **Build
status:** [`STATUS.md`](STATUS.md). Repo: `yuchida-tamu/agent-workflow`.

## Ground rules

1. **Determinism-first.** Anything a script can decide is a script, zero
   tokens. Agents run only for judgment, after deterministic checks.
2. **Model routing.** Haiku for closed-set classification, Sonnet for
   rubric-bound work, Opus for open-ended judgment — never a higher tier for
   mechanical work.
3. **GitHub is the record, not the conversation.** Humans are interviewed
   in-session; issues and PRs receive the artifacts. Gate approvals are
   posted with the human's own `gh` account.
4. **Agents never** transition state labels, mint gate approvals, or file
   issues directly.
5. **Autonomy between gates.** Human decisions live only at gates
   (G1 brief, G2 plan, G3 merge, G4 release) and exhausted bounded retries —
   everything between runs without asking.
6. **Review is independent and Opus-tier.** `code-reviewer` and
   `ux-reviewer` run as freshly spawned, cold subagents — never inline in
   the context that wrote the code.

## Which entry path is yours?

| you are... | do this |
|---|---|
| starting a brand-new project | run the `project-genesis` agent (Opus) — it interviews you, scaffolds the repo, and seeds the milestone-1 backlog |
| bringing the loop to an existing repo | `node init/cli.js adopt --target <path-to-your-repo> --repo owner/name` from a clone of this repo (see quickstart below) |
| already adopted, want to keep the backlog moving | `node scripts/next/cli.js --repo owner/name` — tells you who acts next |

Full walkthrough for the "existing repo" path: **[docs/getting-started.md](docs/getting-started.md)**.

## Adopt quickstart

```sh
git clone https://github.com/yuchida-tamu/agent-workflow
cd agent-workflow && npm install
node init/cli.js adopt --target /path/to/your-repo --repo <owner>/<name>
# creates the 18 state:*/priority:* labels, scaffolds config + domains.yml
# + business policy pack, and prints the repo settings it can't apply for you
node init/cli.js adopt --verify --target /path/to/your-repo --repo <owner>/<name>
# re-reads what actually landed, including your G3 mode (native-review | solo-comment)
```

Then paste the printed `gh api` settings commands (Actions access, branch
protection, the G4 release Environment) — those are yours to run, on
purpose. Full detail: [docs/getting-started.md](docs/getting-started.md).

## Command reference

Every `agentflow-*` CLI; run any of them with `--help` (or read the usage
comment at the top of its `cli.js`) for full flags.

| command | purpose |
|---|---|
| `agentflow-init` | bootstrap a repo: `labels` · `project` · `adopt` (`--verify` · `--coverage`) |
| `agentflow-next` | crawl-phase dispatcher — who should act next, and why |
| `agentflow-state` | work-item state machine: `status` · `plan` · `apply` (labels ↔ `state:*`) |
| `agentflow-gate` | validate a `/approve` comment against a gate and its approvers |
| `agentflow-policy` | risk policy engine: `evaluate` · `test` · `validate` against policy packs |
| `agentflow-facts` | extract diff/domain/drift facts from a git range for the policy engine |
| `agentflow-verdict` | read a recorded risk verdict and ask whether it authorises a gate unattended |
| `agentflow-identity` | act as the agentflow GitHub App: `token` · `exec` · `whoami` · `doctor` |
| `agentflow-log` | run ledger: `start` · `end` · `audit` (model-tier compliance) |
| `agentflow-release` | G4: tag + GitHub release, `verified → released` (`--verify` checks the invariant) |
| `agentflow-e2e` | replay Gherkin scenarios from compiled traces: `run` · `smoke` |

## Level up

- **[docs/getting-started.md](docs/getting-started.md)** — existing-repo
  walkthrough: install through your first merged, verified issue.
- **[docs/github-app-runbook.md](docs/github-app-runbook.md)** — give
  agentflow its own GitHub identity, so G3 becomes a real review
  (`native-review`) instead of a `/approve` comment (`solo-comment`).
- **[docs/headless-runbook.md](docs/headless-runbook.md)** — run agents on a
  GitHub-hosted runner instead of your own session, billed to a Claude
  subscription.
- **[STATUS.md](STATUS.md)** — what's actually built, phase by phase.

```sh
npm install
npm test   # engine + machine tests
```
