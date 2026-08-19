import axios from "axios";

type Verdict = "VERIFIED" | "FALSE" | "MISLEADING" | "UNVERIFIED";

export type EvidenceSource = {
  title: string;
  source: string;
  url: string;
  relevance: number;
  statement?: string;
};

export type FactCheckEvidence = {
  claim: string;
  publisher: string;
  title: string;
  rating: "true" | "false" | "misleading" | "unknown";
  url: string;
  relevance: number;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      groundingSupports?: Array<{
        segment?: { text?: string; startIndex?: number; endIndex?: number };
        groundingChunkIndices?: number[];
      }>;
    };
  }>;
};

type VerifierResult = {
  verdict: Verdict;
  confidence: number;
  explanation: string;
  counterEvidence: string;
  evidenceSummary: string;
};

const AUTHORITATIVE_DOMAINS = [
  "nasa.gov", "isro.gov.in", "esa.int", "noaa.gov", "nih.gov", "nci.nih.gov", "cancer.gov", "who.int",
  "cdc.gov", "fda.gov", "un.org", "gov.in", "india.gov.in", "pmindia.gov.in", "pib.gov.in", "eci.gov.in",
  "presidentofindia.gov.in", "whitehouse.gov", "usa.gov", "congress.gov", "gov.uk", "europa.eu", "canada.ca",
  "australia.gov.au", "nationalacademies.org", "nature.com", "science.org", "pubmed.ncbi.nlm.nih.gov"
];

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function hostname(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function isAuthoritative(url: string): boolean {
  const host = hostname(url);
  return AUTHORITATIVE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function sourceWeight(url: string, title: string): number {
  const host = hostname(url);
  if (isAuthoritative(url)) return 96;
  if (/wikipedia\.org$/.test(host)) return 78;
  if (/reuters\.com$|apnews\.com$|bbc\.com$|bbc\.co\.uk$|afp\.com$/.test(host)) return 82;
  if (/nature\.com$|science\.org$|pubmed\.ncbi\.nlm\.nih\.gov$/.test(host)) return 94;
  if (/fact.?check|snopes|politifact|fullfact|factcheck/.test(`${host} ${title}`)) return 88;
  return 62;
}

function extractText(response: GeminiResponse): string {
  return (response.candidates?.[0]?.content?.parts || [])
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
}

function extractJson(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { /* continue */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]) as Record<string, unknown>; } catch { /* continue */ }
  }
  const object = text.match(/\{[\s\S]*\}/);
  if (object) {
    try { return JSON.parse(object[0]) as Record<string, unknown>; } catch { /* continue */ }
  }
  return null;
}

function parseVerdict(value: unknown): Verdict {
  const v = String(value || "").toUpperCase();
  if (v === "VERIFIED" || v === "FALSE" || v === "MISLEADING" || v === "UNVERIFIED") return v;
  return "UNVERIFIED";
}

function cleanSourceUrl(url: string): string {
  return String(url || "").trim();
}

function buildEvidenceFromGrounding(response: GeminiResponse): { sources: EvidenceSource[]; searchQueries: string[]; searchReport: string } {
  const candidate = response.candidates?.[0];
  const metadata = candidate?.groundingMetadata;
  const chunks = metadata?.groundingChunks || [];
  const supports = metadata?.groundingSupports || [];
  const searchQueries = (metadata?.webSearchQueries || []).map(String).filter(Boolean);
  const report = extractText(response);
  const statementsByChunk = new Map<number, string[]>();

  for (const support of supports) {
    const statement = String(support.segment?.text || "").trim();
    if (!statement) continue;
    for (const index of support.groundingChunkIndices || []) {
      const list = statementsByChunk.get(index) || [];
      if (!list.includes(statement)) list.push(statement);
      statementsByChunk.set(index, list);
    }
  }

  const sources: EvidenceSource[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const web = chunks[index]?.web;
    if (!web?.uri) continue;
    const url = cleanSourceUrl(web.uri);
    const title = String(web.title || hostname(url) || "Google Search source");
    const statements = statementsByChunk.get(index) || [];
    const statement = statements.join(" ").slice(0, 1400) || report.slice(0, 1400);
    sources.push({ title, source: hostname(url) || title, url, relevance: sourceWeight(url, title), statement });
  }

  const unique = new Map<string, EvidenceSource>();
  for (const source of sources) {
    if (!unique.has(source.url) || (unique.get(source.url)?.relevance || 0) < source.relevance) unique.set(source.url, source);
  }
  return { sources: [...unique.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 12), searchQueries, searchReport: report };
}

async function geminiGenerate(apiKey: string, model: string, prompt: string, googleSearch = false): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1800 },
  };
  if (googleSearch) body.tools = [{ google_search: {} }];
  const response = await axios.post<GeminiResponse>(url, body, {
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    timeout: 30000,
  });
  return response.data;
}

async function searchAgent(claim: string): Promise<{ sources: EvidenceSource[]; searchQueries: string[]; searchReport: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured. Add a Gemini API key with Google Search grounding enabled.");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const prompt = `You are the ContextLens Evidence Search Agent. Your job is RETRIEVAL, not verdict prediction.

User claim:
"${claim}"

Search Google thoroughly for evidence that can SUPPORT or CONTRADICT the exact proposition.
Use multiple search queries when needed. Prefer primary and authoritative sources first (government, NASA/ISRO/ESA, WHO/NIH/CDC/FDA, universities, scientific journals, official government pages), then strong independent reporting and published fact-checks.

Important:
- Do not assume that a Google Fact Check result must exist.
- For scientific claims, actively search scientific/space/medical sources.
- For identity, office, law, election, or government claims, search official government sources.
- Look for evidence on BOTH sides so the next agent can compare support vs contradiction.
- Do not invent sources, quotations, facts, or URLs.
- Produce a concise factual evidence report. Mention the key fact each source establishes.
- Do NOT give a final VERIFIED/FALSE verdict. The next agent will decide from your retrieved evidence.`;

  const response = await geminiGenerate(apiKey, model, prompt, true);
  return buildEvidenceFromGrounding(response);
}

async function factCheckSearch(claim: string): Promise<FactCheckEvidence[]> {
  const apiKey = process.env.GOOGLE_FACT_CHECK_API_KEY;
  if (!apiKey) return [];
  try {
    const response = await axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", {
      params: { query: claim, languageCode: "en", pageSize: 10, key: apiKey },
      timeout: 10000,
    });
    const claims = Array.isArray(response.data?.claims) ? response.data.claims : [];
    const results: FactCheckEvidence[] = [];
    for (const item of claims) {
      const text = String(item.text || "").trim();
      for (const review of Array.isArray(item.claimReview) ? item.claimReview : []) {
        const url = String(review.url || "").trim();
        if (!text || !url) continue;
        const ratingText = String(review.textualRating || "").toLowerCase();
        const rating: FactCheckEvidence["rating"] = /false|wrong|fake|incorrect|baseless|debunked/.test(ratingText)
          ? "false"
          : /true|correct|accurate|verified|confirmed/.test(ratingText)
            ? "true"
            : /misleading|mixed|partly|half|out of context/.test(ratingText)
              ? "misleading"
              : "unknown";
        results.push({ claim: text, publisher: String(review.publisher?.name || review.publisher?.site || "Fact-check publisher"), title: String(review.title || "Published fact-check"), rating, url, relevance: 85 });
      }
    }
    return results.slice(0, 12);
  } catch {
    return [];
  }
}

async function verifierAgent(claim: string, sources: EvidenceSource[], factChecks: FactCheckEvidence[], searchReport: string): Promise<VerifierResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  if (!sources.length && !factChecks.length) {
    return {
      verdict: "UNVERIFIED",
      confidence: 0,
      explanation: "The search agent could not retrieve sufficiently relevant evidence for this claim.",
      counterEvidence: "",
      evidenceSummary: "No usable evidence was retrieved.",
    };
  }

  const evidenceDossier = sources.map((source, index) => ({
    id: `WEB-${index + 1}`,
    title: source.title,
    publisher: source.source,
    url: source.url,
    sourceAuthority: source.relevance,
    evidence: source.statement || "",
  }));

  const factDossier = factChecks.map((item, index) => ({
    id: `FACT-${index + 1}`,
    publisher: item.publisher,
    checkedClaim: item.claim,
    rating: item.rating,
    title: item.title,
    url: item.url,
  }));

  const prompt = `You are the ContextLens Verification Agent. You receive a user claim and evidence retrieved by a separate Google Search agent. Decide ONLY from the evidence below.

CLAIM:
${claim}

WEB EVIDENCE:
${JSON.stringify(evidenceDossier, null, 2)}

PUBLISHED FACT-CHECK EVIDENCE:
${JSON.stringify(factDossier, null, 2)}

SEARCH AGENT REPORT:
${searchReport.slice(0, 5000)}

Rules:
1. Verify the exact proposition, not just overlapping words.
2. Distinguish SUPPORT from CONTRADICTION. A source merely mentioning the subject is not evidence for the claim.
3. Give higher weight to primary/official/scientific sources and multiple independent sources.
4. A direct authoritative contradiction can justify FALSE even when no published fact-check exists.
5. If evidence supports the claim, return VERIFIED.
6. If evidence directly contradicts the claim, return FALSE.
7. If the evidence says the claim is partly true, distorted, or missing important context, return MISLEADING.
8. If evidence is genuinely insufficient or conflicting without a defensible winner, return UNVERIFIED.
9. Confidence is confidence in the evidence-backed verdict, NOT the probability that the claim is true.
10. Never invent evidence. Do not use facts that are not present in the dossier.
11. For FALSE, counterEvidence MUST be a short factual sentence explaining what the evidence says instead. Example: for “Trump is President of India,” say that the White House identifies Donald Trump as President of the United States.
12. For VERIFIED, explanation should state what the strongest evidence establishes.

Return ONLY valid JSON with exactly these keys:
{
  "verdict": "VERIFIED" | "FALSE" | "MISLEADING" | "UNVERIFIED",
  "confidence": 0-100,
  "explanation": "short human-readable reason",
  "counterEvidence": "short factual contradiction or empty string",
  "evidenceSummary": "one-sentence summary of the evidence strength"
}`;

  try {
    const response = await geminiGenerate(apiKey, model, prompt, false);
    const parsed = extractJson(extractText(response));
    if (!parsed) throw new Error("Verifier returned invalid JSON.");
    return {
      verdict: parseVerdict(parsed.verdict),
      confidence: clamp(Number(parsed.confidence)),
      explanation: String(parsed.explanation || "The evidence was evaluated, but no concise explanation was returned."),
      counterEvidence: String(parsed.counterEvidence || ""),
      evidenceSummary: String(parsed.evidenceSummary || "Evidence was evaluated from the retrieved sources."),
    };
  } catch {
    return deterministicFallback(claim, sources, factChecks);
  }
}

function deterministicFallback(claim: string, sources: EvidenceSource[], factChecks: FactCheckEvidence[]): VerifierResult {
  const falseChecks = factChecks.filter((item) => item.rating === "false");
  const trueChecks = factChecks.filter((item) => item.rating === "true");
  if (falseChecks.length > trueChecks.length && falseChecks.length > 0) {
    return { verdict: "FALSE", confidence: clamp(82 + Math.min(14, falseChecks.length * 5)), explanation: `Published fact-check evidence contradicts this claim. ${falseChecks[0].claim}`, counterEvidence: falseChecks[0].claim, evidenceSummary: `Based on ${falseChecks.length} published false rating${falseChecks.length === 1 ? "" : "s"}.` };
  }
  if (trueChecks.length > falseChecks.length && trueChecks.length > 0) {
    return { verdict: "VERIFIED", confidence: clamp(82 + Math.min(14, trueChecks.length * 5)), explanation: `Published fact-check evidence supports this claim. ${trueChecks[0].claim}`, counterEvidence: "", evidenceSummary: `Based on ${trueChecks.length} published true rating${trueChecks.length === 1 ? "" : "s"}.` };
  }
  const authoritative = sources.filter((source) => isAuthoritative(source.url));
  if (authoritative.length >= 2) {
    return { verdict: "VERIFIED", confidence: 84, explanation: "Multiple authoritative sources were retrieved, but the automated verifier could not produce a complete structured decision.", counterEvidence: "", evidenceSummary: `${authoritative.length} authoritative sources were retrieved.` };
  }
  return { verdict: "UNVERIFIED", confidence: sources.length ? 35 : 0, explanation: `The evidence search returned ${sources.length} source${sources.length === 1 ? "" : "s"}, but it was not strong enough for a defensible verdict.`, counterEvidence: "", evidenceSummary: "Evidence was retrieved but did not establish a clear proposition-level verdict." };
}

export async function analyzeClaimWithAgents(claim: string) {
  const [searchResult, factChecks] = await Promise.all([searchAgent(claim), factCheckSearch(claim)]);
  const verification = await verifierAgent(claim, searchResult.sources, factChecks, searchResult.searchReport);
  const authoritativeSources = searchResult.sources.filter((source) => isAuthoritative(source.url));
  const evidenceStrength = verification.verdict === "UNVERIFIED"
    ? (searchResult.sources.length ? "Evidence was retrieved, but the verifier found no defensible support or contradiction for the exact claim." : "No sufficiently relevant evidence was retrieved.")
    : verification.evidenceSummary;

  return {
    verdict: verification.verdict,
    confidence: verification.confidence,
    confidenceLabel: "Evidence confidence — reflects source authority, claim-level relevance, evidence agreement, and contradiction/support strength.",
    explanation: verification.explanation,
    counterEvidence: verification.counterEvidence,
    evidenceType: "google-search-agent",
    imageContext: "",
    extractedTextAvailable: false,
    totalRatedFactChecks: factChecks.filter((item) => item.rating !== "unknown").length,
    evidenceAgreement: factChecks.length ? Math.max(...["true", "false", "misleading"].map((rating) => factChecks.filter((item) => item.rating === rating).length)) / factChecks.length : 0,
    factChecksFound: factChecks.length,
    authoritativeSources: authoritativeSources.slice(0, 10),
    factCheckEvidence: factChecks.slice(0, 8),
    articles: searchResult.sources.filter((source) => !isAuthoritative(source.url)).slice(0, 10).map((source) => ({ title: source.title, description: source.statement || null, url: source.url, source: source.source, relevance: source.relevance })),
    evidenceStrength,
    searchQueries: searchResult.searchQueries,
    searchAgentReport: searchResult.searchReport,
    searchAgentSourceCount: searchResult.sources.length,
  };
}
