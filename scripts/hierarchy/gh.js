// The two `gh` calls behind the hierarchy reader. Isolated so core.js stays
// pure and the fallback rule can be tested without a network.

import { execFileSync } from "node:child_process";
import { resolveChildren, resolveParent, isUnavailable } from "./core.js";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// The sub_issues endpoint takes the issue's numeric **id**, not its number.
// Passing the number silently addresses a different issue — the obvious first
// bug, and the reason this lookup is a named function rather than inline.
export function issueId(repo, number) {
  return JSON.parse(gh(["api", `repos/${repo}/issues/${number}`, "--jq", "{id}"])).id;
}

function trySubIssues(repo, number) {
  try {
    return JSON.parse(gh(["api", `repos/${repo}/issues/${number}/sub_issues`]));
  } catch (err) {
    const status = Number(String(err.stderr ?? err.message).match(/HTTP (\d{3})/)?.[1]);
    if (isUnavailable(status)) return null; // feature absent here — fall back
    throw err; // a real failure must surface, not degrade into a body scrape
  }
}

// The text fallback searches for issues that *declare* this parent, rather than
// reading the parent's body. GitHub's in:body search is the cheap way to ask
// that question without listing the whole backlog.
export function childrenOf(repo, number) {
  const api = trySubIssues(repo, number);
  if (api?.length) return resolveChildren({ api });
  const candidates = JSON.parse(
    gh(["issue", "list", "--repo", repo, "--state", "all", "--limit", "200",
        "--search", `"Child of #${number}" in:body`, "--json", "number,title,body,state"])
  );
  return resolveChildren({ api, candidates, parentNumber: number });
}

export function parentOf(repo, number, { body = null } = {}) {
  const text = body ?? JSON.parse(gh(["api", `repos/${repo}/issues/${number}`, "--jq", "{body}"])).body;
  // GitHub exposes the parent inline on the issue payload when one is linked.
  let api = null;
  try {
    api = JSON.parse(gh(["api", `repos/${repo}/issues/${number}`, "--jq", "{parent: .sub_issue_parent}"])).parent ?? null;
  } catch {
    api = null;
  }
  return resolveParent({ api, body: text });
}

export function linkSubIssue(repo, parentNumber, childNumber) {
  const id = issueId(repo, childNumber);
  gh(["api", "--method", "POST", `repos/${repo}/issues/${parentNumber}/sub_issues`, "-F", `sub_issue_id=${id}`]);
}
