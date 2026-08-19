import axios from "axios";

type Verdict = "VERIFIED" | "FALSE" | "MISLEADING" | "UNVERIFIED";

type EvidenceSource = {
  title: string;
  source: string;
  url: string;
  relevance: number;
  statement?: string;
};

type FactCheckEvidence = {
  claim: string;
  publisher: string;
  title: string;
  rating: "true" | "false" | "misleading" | "unknown";
  url: string;
  relevance: number;
};

type AnalysisResult = {
  verdict: Verdict;
  confidence: number;
  confidenceLabel: string;
  explanation: string;
  counterEvidence: string;
  evidenceType: string;
  imageContext: string;
  extractedTextAvailable: boolean;
  totalRatedFactChecks: number;
  evidenceAgreement: number;
  factChecksFound: number;
  authoritativeSources: EvidenceSource[];
  factCheckEvidence: FactCheckEvidence[];
  articles: EvidenceSource[];
  evidenceStrength: string;
  searchQueries: string[];
  searchAgentReport: string;
  searchAgentSourceCount: number;
};

type Interaction = {
  steps?: unknown[];
  outputs?: unknown[];
  status?: string;
  error?: { message?: string };
};

const AUTHORITATIVE_DOMAINS = [
  "nasa.gov", "jpl.nasa.gov", "isro.gov.in", "esa.int", "noaa.gov", "usgs.gov",
  "nih.gov", "nci.nih.gov", "cancer.gov", "who.int", "cdc.gov", "fda.gov",
  "pubmed.ncbi.nlm.nih.gov", "nature.com", "science.org", "nationalacademies.org",
  "un.org", "gov.in", "india.gov.in", "pmindia.gov.in", "pib.gov.in", "eci.gov.in",
  "presidentofindia.gov.in", "whitehouse.gov", "usa.gov", "congress.gov", "gov.uk",
  "europa.eu", "canada.ca", "australia.gov.au"
];

function clamp(value: unknown): number {
  const n = Number(value);
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));
}

function host(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function isAuthoritative(url: string): boolean {
  const h = host(url);
  return AUTHORITATIVE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

function sourceWeight(url: string, title = ""): number {
  const h = host(url);
  if (isAuthoritative(url)) return 96;
  if (/reuters\.com$|apnews\.com$|bbc\.com$|bbc\.co\.uk$|afp\.com$/.test(h)) return 84;
  if (/wikipedia\.org$/.test(h)) return 78;
  if (/fact.?check|snopes|politifact|fullfact/.test(`${h} ${title}`.toLowerCase())) return 88;
  return 62;
}

function parseJson(text: string): Record<string, unknown> | null {
  const clean = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(clean) as Record<string, unknown>; } catch { /* continue */ }
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { return null; }
}

function verdict(value: unknown): Verdict {
  const v = String(value || "").toUpperCase();
  return v === "VERIFIED" || v === "FALSE" || v === "MISLEADING" || v === "UNVERIFIED" ? v : "UNVERIFIED";
}

function textFromInteraction(data: Interaction): string {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") out.push(obj.text);
    if (obj.type === "model_output" && Array.isArray(obj.content)) walk(obj.content);
    if (Array.isArray(obj.steps)) walk(obj.steps);
    if (Array.isArray(obj.outputs)) walk(obj.outputs);
  };
  walk(data.steps);
  walk(data.outputs);
  return out.join("\n\n").trim();
}

function extractSearchQueries(data: Interaction): string[] {
  const queries: string[] = [];
  const walk = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.type === "google_search_call") {
      const args = obj.arguments as Record<string, unknown> | undefined;
      if (Array.isArray(args?.queries)) for (const q of args.queries) if (typeof q === "string" && !queries.includes(q)) queries.push(q);
    }
    if (Array.isArray(obj.steps)) walk(obj.steps);
    if (Array.isArray(obj.outputs)) walk(obj.outputs);
  };
  walk(data.steps);
  walk(data.outputs);
  return queries;
}

function collectUrls(data: unknown): Array<{ url: string; title?: string; statement?: string }> {
  const found = new Map<string, { url: string; title?: string; statement?: string }>();
  const urlPattern = /^https?:\/\//i;
  const walk = (value: unknown, nearbyText = ""): void => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach((v) => walk(v, nearbyText)); return; }
    if (typeof value === "string") {
      const matches = value.match(/https?:\/\/[^\s\]\)<>"']+/g) || [];
      for (const raw of matches) {
        const url = raw.replace(/[.,;]+$/, "");
        if (urlPattern.test(url) && !found.has(url)) found.set(url, { url, statement: nearbyText.slice(0, 1400) });
      }
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const directUrl = typeof obj.url === "string" ? obj.url : "";
    const title = typeof obj.title === "string" ? obj.title : undefined;
    if (directUrl && urlPattern.test(directUrl)) {
      found.set(directUrl, { url: directUrl, title, statement: nearbyText.slice(0, 1400) });
    }
    const type = typeof obj.type === "string" ? obj.type : "";
    const nextText = typeof obj.text === "string" ? obj.text : nearbyText;
    if (type === "url_citation" && directUrl) found.set(directUrl, { url: directUrl, title, statement: nextText.slice(0, 1400) });
    for (const [key, child] of Object.entries(obj)) {
      if (key === "signature") continue;
      walk(child, nextText);
    }
  };
  walk(data);
  return [...found.values()];
}

function buildSources(data: Interaction, report: string): EvidenceSource[] {
  const urls = collectUrls(data);
  const unique = new Map<string, EvidenceSource>();
  for (const item of urls) {
    const url = item.url.trim();
    const title = item.title || host(url) || "Google Search source";
    const statement = item.statement || report.slice(0, 1400);
    const source: EvidenceSource = { title, source: host(url) || title, url, relevance: sourceWeight(url, title), statement };
    const previous = unique.get(url);
    if (!previous || source.relevance > previous.relevance || source.statement!.length > (previous.statement || "").length) unique.set(url, source);
  }
  return [...unique.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 20);
}

async function createInteraction(apiKey: string, model: string, input: string, useSearch: boolean): Promise<Interaction> {
  const response = await axios.post<Interaction>(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      model,
      input,
      ...(useSearch ? { tools: [{ type: "google_search" }] } : {}),
      generation_config: { thinking_level: "low" },
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: 60000,
    },
  );
  return response.data;
}

async function searchAgent(claim: string): Promise<{ sources: EvidenceSource[]; queries: string[]; report: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const prompt = `You are ContextLens AI's live evidence-search agent.

CLAIM: "${claim}"

Use Google Search now. Do not answer from memory. Search for both SUPPORTING and CONTRADICTING evidence for the exact proposition.

Search multiple angles. For science, medicine and space use primary sources such as NASA, ISRO, ESA, NOAA, USGS, NIH, WHO, PubMed, universities and peer-reviewed literature. For government and political claims use official government or institutional sources. Use reputable independent reporting and published fact-checks when useful.

A source that merely mentions the same person, place or topic is NOT evidence. Identify what each source actually establishes.

Return a concise evidence report. Include the URLs of the strongest sources in a final SOURCES section. Do not give a final verdict and do not invent sources.`;

  const response = await createInteraction(key, model, prompt, true);
  const report = textFromInteraction(response);
  const sources = buildSources(response, report);
  const queries = extractSearchQueries(response);

  if (!sources.length) {
    const error = response.error?.message || "Google Search returned no usable URL citations.";
    throw new Error(`Google evidence search failed: ${error}`);
  }
  return { sources, queries, report };
}

async function factCheckSearch(claim: string): Promise<FactCheckEvidence[]> {
  const key = process.env.GOOGLE_FACT_CHECK_API_KEY;
  if (!key) return [];
  try {
    const response = await axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", {
      params: { query: claim, languageCode: "en", pageSize: 10, key },
      timeout: 12000,
    });
    const claims = Array.isArray(response.data?.claims) ? response.data.claims : [];
    const results: FactCheckEvidence[] = [];
    for (const item of claims) {
      const checkedClaim = String(item.text || "").trim();
      if (!checkedClaim) continue;
      for (const review of Array.isArray(item.claimReview) ? item.claimReview : []) {
        const url = String(review.url || "").trim();
        if (!url) continue;
        const ratingText = String(review.textualRating || "").toLowerCase();
        const rating: FactCheckEvidence["rating"] = /false|wrong|fake|incorrect|baseless|debunked/.test(ratingText)
          ? "false"
          : /true|correct|accurate|verified|confirmed/.test(ratingText)
            ? "true"
            : /misleading|mixed|partly|half|out of context/.test(ratingText)
              ? "misleading"
              : "unknown";
        results.push({
          claim: checkedClaim,
          publisher: String(review.publisher?.name || review.publisher?.site || "Fact-check publisher"),
          title: String(review.title || "Published fact-check"),
          rating,
          url,
          relevance: 85,
        });
      }
    }
    return results.slice(0, 12);
  } catch (error) {
    console.error("ContextLens Fact Check API error:", error);
    return [];
  }
}

async function verify(claim: string, sources: EvidenceSource[], factChecks: FactCheckEvidence[]): Promise<{
  verdict: Verdict; confidence: number; explanation: string; counterEvidence: string; evidenceSummary: string;
}> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const dossier = {
    claim,
    webEvidence: sources.map((s, i) => ({ id: `WEB-${i + 1}`, title: s.title, source: s.source, url: s.url, authority: s.relevance, evidence: s.statement || "" })),
    factChecks: factChecks.map((f, i) => ({ id: `FACT-${i + 1}`, publisher: f.publisher, checkedClaim: f.claim, rating: f.rating, title: f.title, url: f.url })),
  };

  const prompt = `You are ContextLens AI's verification judge. Decide ONLY from the evidence dossier below. Do not browse and do not use outside knowledge.

${JSON.stringify(dossier, null, 2)}

Rules:
- Verify the exact proposition, not keyword overlap.
- A source must actually establish support or contradiction.
- Primary/official/scientific sources get the strongest weight.
- Multiple independent sources increase confidence.
- A direct authoritative contradiction can make the claim FALSE even if no fact-check article exists.
- If evidence supports the exact claim, use VERIFIED.
- If evidence contradicts the exact claim, use FALSE.
- If evidence shows partial truth, distortion or missing context, use MISLEADING.
- If the retrieved evidence genuinely cannot decide, use UNVERIFIED.
- Never invent facts, sources or quotations.
- For FALSE, counterEvidence MUST explain what the evidence says instead in one short factual sentence.
- Confidence is confidence in the evidence-backed verdict, not probability. Use 85-99 when multiple strong sources agree, 75-89 when one strong source or several good sources establish it, 50-74 for weaker/conflicting evidence, and 0-49 when genuinely unresolved.

Return ONLY JSON:
{"verdict":"VERIFIED|FALSE|MISLEADING|UNVERIFIED","confidence":0,"explanation":"...","counterEvidence":"...","evidenceSummary":"..."}`;

  const response = await createInteraction(key, model, prompt, false);
  const parsed = parseJson(textFromInteraction(response));
  if (!parsed) throw new Error("Verification agent returned invalid JSON.");
  return {
    verdict: verdict(parsed.verdict),
    confidence: clamp(parsed.confidence),
    explanation: String(parsed.explanation || "The evidence was evaluated.").slice(0, 1200),
    counterEvidence: String(parsed.counterEvidence || "").slice(0, 1200),
    evidenceSummary: String(parsed.evidenceSummary || "Evidence was evaluated from retrieved sources.").slice(0, 1200),
  };
}

function deterministicFallback(claim: string, sources: EvidenceSource[], factChecks: FactCheckEvidence[]): {
  verdict: Verdict; confidence: number; explanation: string; counterEvidence: string; evidenceSummary: string;
} {
  const falseChecks = factChecks.filter((f) => f.rating === "false");
  const trueChecks = factChecks.filter((f) => f.rating === "true");
  if (falseChecks.length > trueChecks.length && falseChecks.length) {
    return { verdict: "FALSE", confidence: clamp(88 + falseChecks.length * 3), explanation: `Published fact-check evidence contradicts the claim. ${falseChecks[0].title}`, counterEvidence: falseChecks[0].claim, evidenceSummary: `Based on ${falseChecks.length} published false-rated fact-check${falseChecks.length === 1 ? "" : "s"}.` };
  }
  if (trueChecks.length > falseChecks.length && trueChecks.length) {
    return { verdict: "VERIFIED", confidence: clamp(88 + trueChecks.length * 3), explanation: `Published fact-check evidence supports the claim. ${trueChecks[0].title}`, counterEvidence: "", evidenceSummary: `Based on ${trueChecks.length} published true-rated fact-check${trueChecks.length === 1 ? "" : "s"}.` };
  }
  const authoritative = sources.filter((s) => isAuthoritative(s.url));
  if (authoritative.length >= 2) {
    return { verdict: "UNVERIFIED", confidence: 60, explanation: "Strong authoritative sources were retrieved, but the verifier could not safely establish the exact proposition.", counterEvidence: "", evidenceSummary: `${authoritative.length} authoritative sources were retrieved; proposition-level verification remained inconclusive.` };
  }
  return { verdict: "UNVERIFIED", confidence: sources.length ? 35 : 0, explanation: "Relevant sources were retrieved, but they did not establish a defensible proposition-level verdict.", counterEvidence: "", evidenceSummary: `${sources.length} web source${sources.length === 1 ? "" : "s"} were retrieved.` };
}

export async function analyzeClaimWithAgents(claim: string): Promise<AnalysisResult> {
  let search: { sources: EvidenceSource[]; queries: string[]; report: string };
  try {
    search = await searchAgent(claim);
  } catch (error) {
    console.error("ContextLens evidence search error:", error);
    throw new Error(error instanceof Error ? error.message : "The Google evidence search failed.");
  }

  const factChecks = await factCheckSearch(claim);
  let result: { verdict: Verdict; confidence: number; explanation: string; counterEvidence: string; evidenceSummary: string };
  try {
    result = await verify(claim, search.sources, factChecks);
  } catch (error) {
    console.error("ContextLens verifier error:", error);
    result = deterministicFallback(claim, search.sources, factChecks);
  }

  const rated = factChecks.filter((f) => f.rating !== "unknown");
  const agreement = rated.length ? Math.max(...["true", "false", "misleading"].map((r) => rated.filter((f) => f.rating === r).length)) / rated.length : 0;
  const authoritative = search.sources.filter((s) => isAuthoritative(s.url));

  return {
    verdict: result.verdict,
    confidence: clamp(result.confidence),
    confidenceLabel: "Evidence confidence — based on source authority, claim-level relevance, independent agreement, and support/contradiction strength.",
    explanation: result.explanation,
    counterEvidence: result.counterEvidence,
    evidenceType: "google-search-grounded-agent",
    imageContext: "",
    extractedTextAvailable: false,
    totalRatedFactChecks: rated.length,
    evidenceAgreement: agreement,
    factChecksFound: factChecks.length,
    authoritativeSources: authoritative.slice(0, 10),
    factCheckEvidence: factChecks.slice(0, 8),
    articles: search.sources.filter((s) => !isAuthoritative(s.url)).slice(0, 10),
    evidenceStrength: result.evidenceSummary,
    searchQueries: search.queries,
    searchAgentReport: search.report,
    searchAgentSourceCount: search.sources.length,
  };
}
