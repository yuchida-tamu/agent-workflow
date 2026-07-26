// Who is this issue's parent, and what are this parent's children — answered in
// one place.
//
// Parentage was a prose convention read by two consumers that each parsed it
// differently: the ledger audit matched `^Child of #N`, parent-close scraped
// `#N` out of a parent's body. Neither knew about the other. GitHub's sub-issue
// relation makes the fact structural; this module owns choosing between the two
// and is pure, so the choice is testable without a network.
//
// The fallback rule is the whole point. `source` is always reported, so a repo
// silently running on the text convention is visible rather than assumed.

export const SOURCE = { api: "api", text: "text" };

// A child declares its parent as `Child of #N` on the first line of its body.
// Anchored deliberately: a mid-body "#12" is a reference, not a declaration, and
// treating one as the other is how an ordinary issue would acquire a parent.
const CHILD_OF = /^Child of #(\d+)/m;

export function parentFromText(body) {
  const match = (body ?? "").match(CHILD_OF);
  return match ? Number(match[1]) : null;
}

// Children are derived by asking each candidate who *its* parent is — never by
// scraping `#N` out of the parent's body.
//
// That scrape is what `parent-close` does today and it is wrong: #18's body
// mentions #3, #1 and #2 as references while its actual children are #24–#27.
// It has only ever appeared to work because the "is the parent verified" check
// short-circuits before children are examined.
//
// `Child of #N` is anchored to the start of a line and written by the architect,
// so the child→parent direction is authoritative in a way the reverse never was.
// Inverting the question makes the fallback as trustworthy as the relation.
export function childrenFromCandidates(candidates, parentNumber) {
  return (candidates ?? [])
    .filter((c) => parentFromText(c.body) === parentNumber)
    .map((c) => ({ number: c.number, closed: c.state === "CLOSED" || c.state === "closed", title: c.title ?? null }));
}

// `api` is the sub_issues payload, or null when the endpoint is unavailable.
//
// An *empty* payload is deliberately not authoritative. Migration is
// forward-only: parents created before sub-issues existed have real children
// declared only in prose, and on this repo #18 has four. Treating [] as "no
// children" made every pre-existing parent read as childless — which would stop
// parent-close from ever closing one, a regression on the behaviour being
// replaced.
//
// So: a non-empty relation wins outright; an empty one falls through to the text
// convention and reports `text`, because it cannot distinguish "no children"
// from "not linked yet". Once a backlog is fully linked this accommodation can
// be dropped, and the reported source is how you would know it is safe to.
export function resolveChildren({ api, candidates = [], parentNumber = null }) {
  if (api?.length) {
    return {
      source: SOURCE.api,
      children: api.map((i) => ({ number: i.number, closed: i.state === "closed", title: i.title })),
    };
  }
  return { source: SOURCE.text, children: childrenFromCandidates(candidates, parentNumber) };
}

export function resolveParent({ api, body }) {
  if (api !== null && api !== undefined) {
    return { source: SOURCE.api, parent: api?.number ?? null };
  }
  return { source: SOURCE.text, parent: parentFromText(body) };
}

// Absence of the feature is a fallback; a broken call is a bug. 404/410 mean the
// endpoint does not exist here — anything else means the call failed and must
// surface, because silently degrading would hide a real fault as a config quirk.
export function isUnavailable(status) {
  return status === 404 || status === 410;
}
