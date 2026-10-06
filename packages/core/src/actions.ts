// HATEOAS action-link normalisation (SPEC §5.1).
// PayPal documents hyphenated rels ("provide-evidence"); some integrators report
// underscores ("provide_evidence") in real responses. We compare on a canonical
// form so either spelling matches.
//
// Example: normaliseAction("Provide_Evidence") === "provide-evidence"

export function normaliseAction(rel: string): string {
  return rel.trim().toLowerCase().replace(/_/g, "-");
}

export function hasAction(links: readonly { rel: string }[] | undefined, action: string): boolean {
  if (!links) return false;
  const want = normaliseAction(action);
  return links.some((l) => normaliseAction(l.rel) === want);
}
