# ContextLens AI — Evidence-First Verification Agent

## Pipeline

1. **Claim parser** extracts a subject, predicate, object and negation when possible.
2. **Search agent** generates multiple evidence queries instead of relying on one exact phrase.
3. **Google Fact Check** retrieves published fact-check reviews and their ratings.
4. **Google Search** (when Custom Search credentials are configured) retrieves fresh web evidence.
5. **Knowledge layer** checks Wikipedia and high-authority domain evidence.
6. **Source ranking** scores relevance separately from source quality.
7. **Stance analysis** classifies each evidence item as supporting, contradicting or neutral.
8. **Verdict engine** aggregates only claim-specific supporting/contradicting evidence.
9. **Explanation layer** surfaces the strongest sentence that supports or contradicts the submitted claim.

## Source hierarchy

- Government / institutional / scientific sources: highest weight.
- Published fact-checks: high weight, with the publisher's rating preserved.
- Google Search results and knowledge sources: medium weight unless the domain is authoritative.
- News: context only; it should not independently prove a claim.

## Important confidence rule

`confidence` is **evidence confidence**, not a mathematical probability that the world is true.

When there is no claim-specific supporting or contradicting evidence, ContextLens returns `UNVERIFIED` rather than inventing a 90–100% verdict. This is intentional: absence of evidence is not evidence of falsity.

## Why the previous MVP failed on claims like “the moon is made of cheese”

The previous pipeline was heavily dependent on exact Google Fact Check matches. Google Fact Check is a discovery index of published fact-checks; it is not a universal truth database. Novel or scientific propositions often have no matching fact-check record.

The new pipeline therefore searches for **evidence about the proposition**, not only a pre-existing fact-check of the exact sentence.
