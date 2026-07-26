# Giving agentflow its own identity

Everything the loop does — branches, commits, PRs, review comments, `/approve` —
runs on somebody's GitHub credentials. By default those are **yours**, and three
frictions follow from that one fact:

- You cannot approve your own agent's PR. GitHub forbids self-review, so G3
  degrades from a real review to a comment naming a SHA.
- Agent review feedback is indistinguishable from your own notes.
- Gate integrity is discipline. An agent-minted `/approve` looks byte-identical
  to one you typed.

Giving agentflow a GitHub App identity resolves all three: agents author **work**
as the App, you keep your own identity for **decisions**, and the gate validator
can then refuse bot-authored approvals mechanically.

**This is optional.** Every part of the loop keeps a working unconfigured path.
A repo that never creates an App is correctly configured — it simply takes its G3
by comment rather than by review, and `agentflow-init adopt --verify` says so.

---

## Why a human has to do this part

Creating and installing a GitHub App is a browser action, available only to a
human account. No script in this toolkit can perform it, and none pretends to.
The steps below are yours; everything after them is automated.

Budget about ten minutes, once per organisation.

---

## 1. Create the App

<https://github.com/settings/apps/new> (or your org's *Settings → Developer
settings → GitHub Apps → New GitHub App*).

| field | value |
|---|---|
| **name** | `agentflow-bot` (any name; it becomes the `[bot]` login) |
| **homepage URL** | your repo's URL — required, unused |
| **webhook** | **uncheck "Active"**. The loop is driven by Actions, not webhooks. |

**Repository permissions** — exactly four, and no more:

| permission | access | what needs it |
|---|---|---|
| Issues | Read and write | state labels, gate comments, the run ledger |
| Pull requests | Read and write | opening PRs, verdict comments, reviews |
| Contents | Read and write | branches and commits |
| Checks | Read | reading CI status before an auto-merge |

Leave **"Where can this GitHub App be installed?"** as *Only on this account*
unless you are sharing it across organisations.

Click **Create GitHub App**.

## 2. Note the App ID, and generate a private key

On the App's settings page:

- **App ID** — a number near the top. Not secret.
- **Private keys → Generate a private key.** A `.pem` downloads. **This is the
  credential.** Anyone holding it can act as your App.

## 3. Install it on the repo

*Install App* in the left sidebar → choose the account → *Only select
repositories* → pick the repo → **Install**.

## 4. Tell the repo the App exists

In `agentflow.config.json`:

```json
{
  "agent_identity": "agentflow-bot"
}
```

Or, to keep the App ID alongside it:

```json
{
  "agent_identity": { "slug": "agentflow-bot", "app_id": 123456 }
}
```

**`approvers` stays human logins only.** Config validation now enforces this: a
bot-shaped login, or the `agent_identity` slug in either spelling, fails with the
offending login named. The two lists exist so that *work* and *decisions* can
never be confused — putting the App in `approvers` would hand it the authority
this whole change exists to take away.

## 5. Put the key where a session can reach it — never in the repo

Pick one. The keychain is the least likely to leak:

```sh
# macOS keychain (recommended)
security add-generic-password -s "agentflow-app-private-key" -a "$USER" \
  -w "$(cat ~/Downloads/agentflow-bot.private-key.pem)"

# or an environment variable, from your shell profile
export AGENTFLOW_APP_ID=123456
export AGENTFLOW_APP_PRIVATE_KEY="$(cat ~/.config/agentflow/key.pem)"

# or a path to the PEM
export AGENTFLOW_APP_PRIVATE_KEY_FILE=~/.config/agentflow/key.pem
```

Then delete the download.

**The key must never live inside the repository.** `agentflow-identity` refuses
to read a key whose path resolves inside the working tree, before it reads the
file — a key in a repo is one `git add` away from being published, and no
diagnostic afterwards calls it back. That refusal is a safety net, not a
permission: do not keep a key in the repo and rely on the check.

Confirm:

```sh
agentflow-identity doctor
```

It names every source it tried and exits non-zero until all of them resolve.

## 6. Give Actions the same identity

Add two **repository secrets** (*Settings → Secrets and variables → Actions*):

| secret | value |
|---|---|
| `AGENTFLOW_APP_ID` | the App ID from step 2 |
| `AGENTFLOW_APP_PRIVATE_KEY` | the full contents of the `.pem`, including the BEGIN/END lines |

The shipped workflow stubs already pass these through. Unset secrets evaluate to
empty strings, which is why a repo that skips this step keeps working — and why
every run prints which identity it is acting as, so a silent fallback to
`GITHUB_TOKEN` can never be mistaken for the App.

---

## What changes once it is configured

**G3 becomes a real review.** Agent PRs are authored by `agentflow-bot[bot]`, so
you can submit a native approving review — GitHub no longer sees it as your own
PR. `adopt --verify` reports the repo as `native-review` instead of
`solo-comment`, and says whether branch protection *requires* that review or
merely allows it.

**Agent feedback is visibly the agent's.** Review comments arrive from the bot,
not from you.

**Gate integrity stops depending on discipline.** `validateApproval` refuses any
bot-authored approval, checked before the approvers list. There is exactly one
exception, and the authority in it is not the bot's:

> **G3, on a pull request, whose recorded risk verdict carries no `human-merge`,
> no `auto-merge` block, and demonstrably describes the head being merged.**

That is precisely the condition under which `auto-merge` already merges the PR
unattended with no `/approve` at all. The App is not granted anything new — it
transcribes an engine decision into a reviewable artifact. Every other gate, and
every issue comment, refuses a bot outright.

---

## The G3 review-artifact guard

**Planned:** identity and headless review (above, and `docs/headless-runbook.md`) exist so that
every PR gets reviewed automatically. The guard is what makes that fact
*mechanically checked* rather than a habit: G3 refuses to authorise a merge —
whether by `/approve G3`, or by `auto-merge` acting unattended — unless a fresh
`mergeable` review of the exact head commit exists. No review, a stale review
(a new commit landed after the one reviewed), or a `not-mergeable` verdict all
refuse the same way a missing risk verdict refuses G2 today: absence is
refusal, not silent pass. (Tracked as #111–#113 off the #81 plan; this section
describes the contract those issues implement.)

The guard reads review state one of two ways, matching whichever G3 mode
`g3Mode()` (`scripts/identity/identity.js`) reports for the repo:

- **`native-review`** (an `agent_identity` is configured, as set up above): the
  guard reads the **native, bot-authored GitHub review object** directly —
  `APPROVED` means `mergeable`, `CHANGES_REQUESTED` means `not-mergeable`, and
  the reviewed SHA is the review's own `commit_id`. This is authoritative
  wherever it exists, because it is the review GitHub itself recorded.
- **`solo-comment`** (no App configured): GitHub forbids a native bot review on
  a PR authored by your own account, so the guard falls back to the
  `<!-- agentflow-review -->` marker comment described in
  `docs/headless-runbook.md` — the same comment a headless or in-session
  reviewer already posts.

Every pass or refusal names which of the two sources answered, so "why did G3
refuse" never requires guessing which mode the repo is in.

This is a **presence** check, not a quality bar: the guard confirms a fresh
verdict exists, not that the review was good. It also does not touch the
approval inbox — G3 is deliberately excluded from that path — so the two
enforcement points are `auto-merge.js` and the G3 branch of
`scripts/gate/validator.js`, the same two places that already read the risk
verdict.

---

## Rotating or revoking the key

Generate a new private key on the App's settings page, update the keychain entry
and the `AGENTFLOW_APP_PRIVATE_KEY` secret, then delete the old key from the App.
Old keys stop working immediately, so update both places before deleting.

To stop using the App entirely, remove `agent_identity` from
`agentflow.config.json`. The loop falls back to your own `gh` auth and
solo-comment G3 — the unconfigured path is supported, not deprecated.
