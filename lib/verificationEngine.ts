export type Verdict = "VERIFIED" | "FALSE" | "MISLEADING" | "UNCERTAIN" | "UNVERIFIED";

const STOP_WORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "of", "to", "in", "on", "and", "or", "for", "with", "from", "that", "this", "these", "those", "have", "has", "had", "will", "would", "could", "should"]);

export function keywords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\\s]/g, " ").split(/\\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function articleRelevance(claim: string, title = "", description = ""): number {
  const claimWords = keywords(claim);
  const sourceWords = new Set(keywords(`${title} ${description}`));
  if (!claimWords.length) return 0;
  const matches = claimWords.filter((word) => sourceWords.has(word)).length;
  return Math.round((matches / claimWords.length) * 100);
}

export function ratingClass(rating = "") : "FALSE" | "TRUE" | "MISLEADING" | "UNKNOWN" {
  const r = rating.toLowerCase();
  if (["false", "fake", "incorrect", "baseless", "hoax"].some((x) => r.includes(x))) return "FALSE";
  if (["misleading", "partly false", "partly true", "mixed", "out of context"].some((x) => r.includes(x))) return "MISLEADING";
  if (["true", "correct", "accurate"].some((x) => r === x || r.includes(` ${x}`))) return "TRUE";
  return "UNKNOWN";
}

export function evaluateFactChecks(items: Array<{ rating?: string }>) {
  const classes = items.map((x) => ratingClass(x.rating));
  const falseCount = classes.filter((x) => x === "FALSE").length;
  const trueCount = classes.filter((x) => x === "TRUE").length;
  const misleadingCount = classes.filter((x) => x === "MISLEADING").length;
  const rated = falseCount + trueCount + misleadingCount;
  const strongest = Math.max(falseCount, trueCount, misleadingCount);
  return {
    falseCount,
    trueCount,
    misleadingCount,
    rated,
    agreement: rated ? strongest / rated : 0,
  };
}

export function compositionContradiction(claim: string, sourceText: string) {
  const match = claim.toLowerCase().match(/(?:is|are|was|were) made of ([a-z0-9 ]+)/);
  if (!match) return false;
  const claimedMaterial = match[1].trim().split(/\\s+/)[0];
  const source = sourceText.toLowerCase();
  const establishedMaterials = ["rock", "rocks", "metal", "iron", "silicate", "silicates", "water", "ice", "gas", "hydrogen", "helium"];
  return !source.includes(claimedMaterial) && establishedMaterials.some((x) => source.includes(x));
}

export function finalVerdict(input: {
  falseCount: number;
  trueCount: number;
  misleadingCount: number;
  contradiction: boolean;
  authoritative: boolean;
  relevantArticles: number;
}) : { verdict: Verdict; confidence: number; explanation: string } {
  const { falseCount, trueCount, misleadingCount, contradiction, authoritative, relevantArticles } = input;
  const rated = falseCount + trueCount + misleadingCount;
  const strongest = Math.max(falseCount, trueCount, misleadingCount);
  const agreement = rated ? strongest / rated : 0;

  if (falseCount > trueCount && falseCount >= misleadingCount) return { verdict: "FALSE", confidence: Math.min(95, 72 + Math.round(agreement * 20)), explanation: "Relevant published fact-checks indicate that this claim is false." };
  if (misleadingCount > trueCount && misleadingCount >= falseCount) return { verdict: "MISLEADING", confidence: Math.min(92, 68 + Math.round(agreement * 20)), explanation: "Relevant published fact-checks indicate that this claim is misleading or missing important context." };
  if (trueCount > falseCount && trueCount > misleadingCount) return { verdict: "VERIFIED", confidence: Math.min(95, 72 + Math.round(agreement * 20)), explanation: "Relevant published fact-checks support this claim." };
  if (contradiction) return { verdict: "FALSE", confidence: 88, explanation: "Independent knowledge evidence contradicts the claim." };
  if (authoritative) return { verdict: "VERIFIED", confidence: 82, explanation: "A relevant authoritative source was found during real-time analysis." };
  if (relevantArticles >= 5) return { verdict: "LIKELY TRUE", confidence: 72, explanation: "Several relevant sources were found, but direct verification was not established." };
  if (relevantArticles >= 2) return { verdict: "UNCERTAIN", confidence: 55, explanation: "Some relevant sources were found, but they are not strong enough to establish the claim." };
  return { verdict: "UNVERIFIED", confidence: 35, explanation: "No sufficiently strong evidence was found to verify or refute this claim." };
}
