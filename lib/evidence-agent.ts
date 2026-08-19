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

type Interaction = {
  steps?: Array<{
    type?: string;
    arguments?: { queries?: string[] };
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        title?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
  }>;
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
  "australia.gov.au", "nationalacademies.org", "nature.com", "science.org", "pubmed.ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov", "usgs.gov", "jpl.nasa.gov"
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

function buildEvidenceFromInteractions(response: Interaction): { sources: EvidenceSource[]; searchQueries: string[]; searchReport: string } {
  const sources = new Map<string, EvidenceSource>();
  const queries: string[] = [];
  const reports: string[] = [];

  for (const step of response.steps || []) {
    if (step.type === "google_search_call") {
      for (const query of step.arguments?.queries || []) {
        if (query && !queries.includes(query)) queries.push(query);
      }
    }

    if (step.type !== "model_output") continue;

    for (const block of step.content || []) {
      if (block.type !== "text") continue;
      const text = String(block.text || "").trim();
      if (text) reports.push(text);

      for (const annotation of block.annotations || []) {
        if (annotation.type !== "url_citation" || !annotation.url) continue;
        const url = cleanSourceUrl(annotation.url);
        if (!url) continue;
        const start = Number(annotation.start_index ?? 0);
        const end = Number(annotation.end_index ?? text.length);
        const statement = text.slice(Math.max(0, start), Math.max(0, end)).trim() || text.slice(0, 1400);
        const title = String(annotation.title || hostname(url) || "Google Search source");
        const candidate: EvidenceSource = {
          title,
          source: hostname(url) || title,
          url,
          relevance: sourceWeight(url, title),
          statement: statement.slice(0, 1400),
        };
        const existing = sources.get(url);
        if (!existing || candidate.relevance > existing.relevance || (candidate.statement || "").length > (existing.statement || "").length) {
          sources.set(url, candidate);
        }
      }
    }
  }

  return {
    sources: [...sources.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 16),
    searchQueries: queries,
    searchReport: reports.join("\n\n").slice(0, 7000),
  };
}

function buildEvidenceFromLegacyGrounding(response: GeminiResponse): { sources: EvidenceSource[]; searchQueries: string[]; searchReport: string } {
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
  return { sources: [...unique.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 16), searchQueries, searchReport: report };
}

async function geminiInteraction(apiKey: string, model: string, prompt: string, googleSearch = false): Promise<Interaction> {
  const response = await axios.post<Interaction>(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      model,
      input: prompt,
      ...(googleSearch ? { tools: [{ type: "google_search" }] } : {}),
    },
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      timeout: 45000,
    },
  );
  return response.data;
}

async function geminiLegacy(apiKey: string, model: string, prompt: string, googleSearch = false): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1800 },
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
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured. Add a Gemini API key in .env.local.");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const prompt = `You are the ContextLens Evidence Search Agent. You are a retrieval agent, not the final judge.

CLAIM TO VERIFY:
"${claim}"

MANDATORY: Use Google Search for this task. Search the live web and retrieve evidence about the exact proposition. Do not answer from memory.

Search strategy:
- Generate multiple focused queries when useful.
- Search for evidence that SUPPORTS the claim and evidence that CONTRADICTS the claim.
- For scientific/medical/space claims, prioritize NASA, ISRO, ESA, NOAA, NIH, CDC, FDA, WHO, universities, peer-reviewed journals, PubMed and other primary scientific sources.
- For government, political, legal, election and public-office claims, prioritize official government pages and primary records.
- For historical or general factual claims, prioritize museums, universities, encyclopedias, primary documents and strong independent reporting.
- Use published fact-checks when they exist, but do not require an exact fact-check to exist.

For every useful source, identify the concrete fact it establishes. A page merely mentioning the subject is NOT evidence for the proposition.

Do not give a final TRUE/FALSE verdict. Return a factual evidence report grounded in the sources you found. Do not invent URLs, quotations or facts.`;

  try {
    const response = await geminiInteraction(apiKey, model, prompt, true);
    const result = buildEvidenceFromInteractions(response);
    if (result.sources.length > 0) return result;

    // Compatibility fallback for accounts/models where the legacy endpoint is the available path.
    const legacy = await geminiLegacy(apiKey, model, prompt, true);
    return buildEvidenceFromLegacyGrounding(legacy);
  } catch (error) {
    console.error("ContextLens Google Search agent error:", error);
    try {
      const legacy = await geminiLegacy(apiKey, model, prompt, true);
      const result = buildEvidenceFromLegacyGrounding(legacy);
      if (result.sources.length > 0) return result;
      return result;
    } catch (legacyError) {
      console.error("ContextLens legacy Google Search fallback error:", legacyError);
      return { sources: [], searchQueries: [], searchReport: "The evidence search service did not return usable web sources." };
    }
  }
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
  } catch (error) {
    console.error("ContextLens Fact Check API error:", error);
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
      explanation: "The evidence search did not return usable sources for this claim.",
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

  const prompt = `You are the ContextLens Verification Agent. You are a second-stage evidence judge. You MUST decide from the supplied evidence, not from memory.

CLAIM:
${claim}

WEB EVIDENCE RETRIEVED BY GOOGLE SEARCH:
${JSON.stringify(evidenceDossier, null, 2)}

PUBLISHED FACT-CHECK EVIDENCE:
${JSON.stringify(factDossier, null, 2)}

SEARCH REPORT:
${searchReport.slice(0, 7000)}

Decision rules:
1. Evaluate the exact proposition and its important qualifiers: who, what, where, when and under what conditions.
2. A source mentioning the same person/topic is NOT evidence for the claim.
3. Strong primary, official and scientific sources get more weight than generic pages.
4. Multiple independent sources that agree strengthen confidence.
5. A direct authoritative contradiction can establish FALSE even when no published fact-check exists.
6. Return VERIFIED when the retrieved evidence directly supports the proposition.
7. Return FALSE when the retrieved evidence directly contradicts the proposition.
8. Return MISLEADING when the core statement has some truth but is materially distorted, incomplete or out of context.
9. Return UNVERIFIED only when the retrieved evidence is genuinely insufficient or irreconcilably conflicting.
10. Confidence measures the strength of the evidence-backed decision, not the mathematical probability that the claim is true.
11. Never turn absence of a fact-check into proof of falsehood.
12. For FALSE, counterEvidence MUST state the relevant fact that contradicts the claim. Example: if the claim says “Trump is President of India,” the counter-evidence should say that the White House identifies Donald Trump as President of the United States.
13. For scientific claims, explain the scientific fact that contradicts the claim. Example: for “the moon is made of cheese,” use the retrieved scientific evidence describing the Moon's rocky/metallic composition.
14. Do not invent any source, URL, quotation or fact.

Return ONLY JSON:
{
  "verdict": "VERIFIED" | "FALSE" | "MISLEADING" | "UNVERIFIED",
  "confidence": 0-100,
  "explanation": "one or two concise sentences explaining the decision",
  "counterEvidence": "the key factual evidence that supports the FALSE/MISLEADING decision, or empty string",
  "evidenceSummary": "one sentence describing source quality, relevance and agreement"
}`;

  try {
    const response = await geminiInteraction(apiKey, model, prompt, false);
    const text = (response.steps || [])
      .filter((step) => step.type === "model_output")
      .flatMap((step) => step.content || [])
      .filter((block) => block.type === "text")
      .map((block) => String(block.text || ""))
      .join("\n")
      .trim();
    const parsed = extractJson(text);
    if (!parsed) throw new Error("Verifier returned invalid JSON.");
    return {
      verdict: parseVerdict(parsed.verdict),
      confidence: clamp(Number(parsed.confidence)),
      explanation: String(parsed.explanation || "The evidence was evaluated, but no concise explanation was returned."),
      counterEvidence: String(parsed.counterEvidence || ""),
      evidenceSummary: String(parsed.evidenceSummary || "Evidence was evaluated from the retrieved sources."),
    };
  } catch (error) {
    console.error("ContextLens verifier error:", error);
    return deterministicFallback(claim, sources, factChecks);
  }
}

function deterministicFallback(_claim: string, sources: EvidenceSource[], factChecks: FactCheckEvidence[]): VerifierResult {
  const falseChecks = factChecks.filter((item) => item.rating === "false");
  const trueChecks = factChecks.filter((item) => item.rating === "true");
  if (falseChecks.length > trueChecks.length && falseChecks.length > 0) {
    return {
      verdict: "FALSE",
      confidence: clamp(82 + Math.min(14, falseChecks.length * 5)),
      explanation: `Published fact-check evidence contradicts this claim. ${falseChecks[0].claim}`,
      counterEvidence: falseChecks[0].claim,
      evidenceSummary: `Based on ${falseChecks.length} published false rating${falseChecks.length === 1 ? "" : "s"}.`,
    };
  }
  if (trueChecks.length > falseChecks.length && trueChecks.length > 0) {
    return {
      verdict: "VERIFIED",
      confidence: clamp(82 + Math.min(14, trueChecks.length * 5)),
      explanation: `Published fact-check evidence supports this claim. ${trueChecks[0].claim}`,
      counterEvidence: "",
      evidenceSummary: `Based on ${trueChecks.length} published true rating${trueChecks.length === 1 ? "" : "s"}.`,
    };
  }

  // Never infer VERIFIED merely because authoritative pages were found.
  // They must be proposition-level evidence, which is the verifier's job.
  return {
    verdict: "UNVERIFIED",
    confidence: sources.length ? 35 : 0,
    explanation: sources.length
      ? `The evidence search returned ${sources.length} source${sources.length === 1 ? "" : "s"}, but the structured verifier could not establish a defensible proposition-level decision.`
      : "The evidence search did not return usable sources for this claim.",
    counterEvidence: "",
    evidenceSummary: sources.length
      ? "Evidence was retrieved, but it did not establish a clear proposition-level verdict."
      : "No usable evidence was retrieved.",
  };
}

export async function analyzeClaimWithAgents(claim: string) {
  const [searchResult, factChecks] = await Promise.all([searchAgent(claim), factCheckSearch(claim)]);
  const verification = await verifierAgent(claim, searchResult.sources, factChecks, searchResult.searchReport);
  const authoritativeSources = searchResult.sources.filter((source) => isAuthoritative(source.url));
  const evidenceStrength = verification.verdict === "UNVERIFIED"
    ? (searchResult.sources.length
      ? "Evidence was retrieved, but the verifier found no defensible support or contradiction for the exact claim."
      : "No sufficiently relevant evidence was retrieved.")
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
    articles: searchResult.sources.filter((source) => !isAuthoritative(source.url)).slice(0, 10).map((source) => ({
      title: source.title,
      description: source.statement || null,
      url: source.url,
      source: source.source,
      relevance: source.relevance,
    })),
    evidenceStrength,
    searchQueries: searchResult.searchQueries,
    searchAgentReport: searchResult.searchReport,
    searchAgentSourceCount: searchResult.sources.length,
  };
}
