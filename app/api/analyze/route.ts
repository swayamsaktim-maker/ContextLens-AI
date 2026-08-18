import { NextResponse } from "next/server";
import axios from "axios";

type Verdict = "VERIFIED" | "FALSE" | "MISLEADING" | "UNVERIFIED";
type Relation = "is" | "made_of" | "cures" | "other";
type ClaimShape = { subject: string; predicate: string; object: string; negative: boolean; relation: Relation };
type Source = { title: string; source: string; url: string; relevance: number; statement?: string };
type FactCheck = { claim: string; publisher: string; title: string; rating: string; url: string; relevance: number };
type Article = { title: string; description: string | null; url: string; source: string; relevance: number };
type GoogleClaim = { text?: string; claimReview?: Array<{ publisher?: { name?: string; site?: string }; url?: string; title?: string; textualRating?: string }> };
type GoogleResponse = { claims?: GoogleClaim[] };
type WikiItem = { title?: string; snippet?: string; pageid?: number };

const AUTHORITATIVE_DOMAINS = [
  "gov.in", "india.gov.in", "pmindia.gov.in", "pib.gov.in", "eci.gov.in", "presidentofindia.gov.in",
  "whitehouse.gov", "usa.gov", "congress.gov", "who.int", "un.org", "nasa.gov", "esa.int",
  "nih.gov", "nci.nih.gov", "cancer.gov", "cdc.gov", "fda.gov", "nationalacademies.org",
  "gov.uk", "europa.eu", "canada.ca", "australia.gov.au"
];

const STOP = new Set("a an the and or but if then than this that these those there their about with from have has had will would could should been being into what when where which while whose your our ours you they them who how why is am be to of in on as at by for are was were can its it according current information published relevant source sources evidence claim claims says said confirmed related made make".split(" "));
const NEGATION_RE = /\b(not|never|no longer|isn't|wasn't|aren't|weren't|doesn't|don't|didn't|cannot|can't|won't|without)\b/i;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim();
}
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}
function tokens(value: string): string[] { return normalize(value).split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem); }
function clamp(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0; }
function isAuthoritative(url: string): boolean {
  try { const host = new URL(url).hostname.toLowerCase(); return AUTHORITATIVE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)); }
  catch { return false; }
}
function similarity(claim: string, evidence: string, title = ""): number {
  const a = new Set(tokens(claim)); const b = new Set(tokens(evidence)); const t = new Set(tokens(title));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((w) => b.has(w)).length;
  const coverage = overlap / a.size; const evidenceCoverage = overlap / b.size;
  const f1 = coverage + evidenceCoverage > 0 ? (2 * coverage * evidenceCoverage) / (coverage + evidenceCoverage) : 0;
  const titleCoverage = [...a].filter((w) => t.has(w)).length / a.size;
  return clamp(f1 * 70 + titleCoverage * 30);
}
function subjectSimilarity(subject: string, evidence: string, title = ""): number {
  const a = new Set(tokens(subject)); const b = new Set(tokens(evidence)); const t = new Set(tokens(title));
  if (!a.size) return 0;
  const bodyHits = [...a].filter((w) => b.has(w)).length / a.size;
  const titleHits = [...a].filter((w) => t.has(w)).length / a.size;
  return clamp(bodyHits * 70 + titleHits * 30);
}
function parseClaim(input: string): ClaimShape | null {
  const clean = input.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const negative = NEGATION_RE.test(clean);
  let match = clean.match(/^(.+?)\s+(?:is|was|are|were)\s+(?:the\s+)?(.+?)\s+of\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: match[2].trim(), object: match[3].trim(), negative, relation: "is" };
  match = clean.match(/^(.+?)\s+(?:is|was|are|were)\s+made\s+(?:primarily\s+|mostly\s+)?of\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: "made of", object: match[2].trim(), negative, relation: "made_of" };
  match = clean.match(/^(.+?)\s+(?:cures|cure|treats|treat|prevents|prevent)\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: "cures", object: match[2].trim(), negative, relation: "cures" };
  match = clean.match(/^(.+?)\s+(?:is|was|are|were)\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: "is", object: match[2].trim(), negative, relation: "other" };
  return null;
}
function claimText(shape: ClaimShape): string { return `${shape.subject} ${shape.predicate} ${shape.object}`; }
function factQueries(claim: string, shape: ClaimShape | null): string[] {
  return [...new Set([claim, `${claim} fact check`, shape?.subject || "", shape ? `${shape.subject} ${shape.object}` : "", shape ? `${shape.subject} ${shape.object} fact check` : "", `${claim} evidence`].map((v) => v.replace(/\s+/g, " ").trim()).filter((v) => v.length >= 5))].slice(0, 7);
}
function parseRating(value: string): "true" | "false" | "misleading" | "unknown" {
  const v = normalize(value);
  if (/mostly false|partly false|half true|half false|misleading|mixed|out of context|missing context|partially true|partly true/.test(v)) return "misleading";
  if (/^(false)$|\b(false|baseless|incorrect|wrong|fake|fabricated|debunked)\b/.test(v)) return "false";
  if (/^(true)$|\b(true|correct|accurate|verified|confirmed)\b/.test(v)) return "true";
  return "unknown";
}

async function getFactChecks(apiKey: string | undefined, claim: string, shape: ClaimShape | null): Promise<FactCheck[]> {
  if (!apiKey) return [];
  const responses = await Promise.all(factQueries(claim, shape).map(async (query) => {
    try {
      const response = await axios.get<GoogleResponse>("https://factchecktools.googleapis.com/v1alpha1/claims:search", { params: { query, languageCode: "en", pageSize: 10, key: apiKey }, timeout: 9000, headers: { "User-Agent": "ContextLens-AI/3.0" } });
      return Array.isArray(response.data?.claims) ? response.data.claims : [];
    } catch { return []; }
  }));
  const unique = new Map<string, FactCheck>();
  for (const item of responses.flat()) {
    const text = String(item.text || "").trim(); if (!text || !Array.isArray(item.claimReview)) continue;
    const relevance = similarity(claim, text);
    for (const review of item.claimReview) {
      const url = String(review.url || ""); if (!url) continue;
      const candidate: FactCheck = { claim: text, publisher: String(review.publisher?.name || review.publisher?.site || "Fact-check publisher"), title: String(review.title || "Published fact-check"), rating: parseRating(String(review.textualRating || "")), url, relevance };
      const key = `${url}|${text}`; const old = unique.get(key); if (!old || candidate.relevance > old.relevance) unique.set(key, candidate);
    }
  }
  return [...unique.values()].filter((item) => item.relevance >= 28).sort((a, b) => b.relevance - a.relevance).slice(0, 12);
}

async function wikiSearch(query: string, limit = 5): Promise<WikiItem[]> {
  try {
    const response = await axios.get("https://en.wikipedia.org/w/api.php", { params: { action: "query", list: "search", srsearch: query, srlimit: limit, format: "json", origin: "*" }, timeout: 7000, headers: { "User-Agent": "ContextLens-AI/3.0" } });
    return Array.isArray(response.data?.query?.search) ? response.data.query.search : [];
  } catch { return []; }
}
async function wikiSummary(title: string): Promise<string> {
  try {
    const response = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, { timeout: 7000, headers: { "User-Agent": "ContextLens-AI/3.0" } });
    return String(response.data?.extract || "");
  } catch { return ""; }
}
async function getWikipediaEvidence(claim: string, shape: ClaimShape | null): Promise<Source[]> {
  const queries = [shape?.subject || claim, claim, shape ? `${shape.subject} ${shape.object}` : claim];
  const batches = await Promise.all(queries.map((q) => wikiSearch(q, 5)));
  const unique = new Map<string, WikiItem>();
  for (const item of batches.flat()) if (item.title) unique.set(item.title, item);
  const candidates = [...unique.values()].slice(0, 8);
  const summaries = await Promise.all(candidates.map((item) => wikiSummary(item.title || "")));
  return candidates.map((item, i) => {
    const title = item.title || "Wikipedia"; const statement = summaries[i] || String(item.snippet || "");
    const relevance = shape ? Math.max(similarity(claim, statement, title), subjectSimilarity(shape.subject, statement, title)) : similarity(claim, statement, title);
    return { title, source: "Wikipedia", url: item.pageid ? `https://en.wikipedia.org/?curid=${item.pageid}` : `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, relevance, statement };
  }).filter((s) => s.statement && s.relevance >= 35).sort((a, b) => b.relevance - a.relevance);
}
async function getWikidataEvidence(shape: ClaimShape | null): Promise<Source[]> {
  if (!shape) return [];
  try {
    const search = await axios.get("https://www.wikidata.org/w/api.php", { params: { action: "wbsearchentities", search: shape.subject, language: "en", format: "json", type: "item", limit: 5 }, timeout: 7000, headers: { "User-Agent": "ContextLens-AI/3.0" } });
    const items: Array<{ id?: string; label?: string; description?: string }> = Array.isArray(search.data?.search) ? search.data.search : [];
    const entity = items.find((x) => normalize(String(x.label || "")) === normalize(shape.subject)) || items[0];
    if (!entity?.id) return [];
    const response = await axios.get(`https://www.wikidata.org/wiki/Special:EntityData/${entity.id}.json`, { timeout: 7000, headers: { "User-Agent": "ContextLens-AI/3.0" } });
    const data = response.data?.entities?.[entity.id];
    const label = String(data?.labels?.en?.value || entity.label || shape.subject); const description = String(data?.descriptions?.en?.value || entity.description || "");
    if (!description) return [];
    return [{ title: `${label} — Wikidata`, source: "Wikidata", url: `https://www.wikidata.org/wiki/${entity.id}`, relevance: subjectSimilarity(shape.subject, `${label} ${description}`, label), statement: `${label} is described as ${description}.` }];
  } catch { return []; }
}

async function getNews(apiKey: string | undefined, claim: string): Promise<Article[]> {
  if (!apiKey) return [];
  try {
    const response = await axios.get("https://newsapi.org/v2/everything", { params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 12, apiKey }, timeout: 9000, headers: { "User-Agent": "ContextLens-AI/3.0" } });
    const raw: Array<{ title?: string; description?: string | null; url?: string; source?: { name?: string } }> = Array.isArray(response.data?.articles) ? response.data.articles : [];
    return raw.map((a) => ({ title: String(a.title || "Untitled article"), description: a.description || null, url: String(a.url || ""), source: String(a.source?.name || "Unknown source"), relevance: similarity(claim, `${a.title || ""} ${a.description || ""}`, a.title || "") })).filter((a) => a.url && a.relevance >= 20).sort((a, b) => b.relevance - a.relevance).slice(0, 8);
  } catch { return []; }
}

async function directTrustedEvidence(claim: string, shape: ClaimShape | null): Promise<Source[]> {
  const rules: Array<{ when: RegExp; sources: Array<{ title: string; source: string; url: string }> }> = [
    { when: /\bmoon\b/i, sources: [
      { title: "Moon Composition & Structure", source: "NASA Science", url: "https://science.nasa.gov/moon/composition/" },
      { title: "Moon Facts", source: "NASA Science", url: "https://science.nasa.gov/moon/facts/" }
    ] },
    { when: /\b(lemon|lemon water|cancer)\b/i, sources: [
      { title: "Can lemons cure cancer?", source: "National Academies of Sciences, Engineering, and Medicine", url: "https://www.nationalacademies.org/news/lemons-cannot-cure-cancer" },
      { title: "Cancer information", source: "National Cancer Institute", url: "https://www.cancer.gov/about-cancer" }
    ] }
  ];
  const selected = rules.filter((r) => r.when.test(claim)).flatMap((r) => r.sources);
  if (!selected.length) return [];
  const results = await Promise.all(selected.map(async (item) => {
    try {
      const response = await axios.get(item.url, { timeout: 8000, headers: { "User-Agent": "ContextLens-AI/3.0" } });
      const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      const statement = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 14000);
      const relevance = shape ? Math.max(similarity(claim, statement, item.title), subjectSimilarity(shape.subject, statement, item.title)) : similarity(claim, statement, item.title);
      return { ...item, relevance, statement };
    } catch { return null; }
  }));
  return results.filter((x): x is Source => Boolean(x) && x.statement.length > 0).sort((a, b) => b.relevance - a.relevance);
}

function negated(text: string): boolean { return /no evidence|does not|doesn't|cannot|can't|not a cure|not an effective|not been shown|not proven|unproven|false|myth|incorrect|instead|rather than|actually/i.test(text); }
function relationEvidence(shape: ClaimShape, statement: string): { support: boolean; contradiction: boolean } {
  const s = normalize(statement); const subject = normalize(shape.subject); const objectWords = tokens(shape.object);
  const subjectPresent = s.includes(subject) || subject.split(" ").some((p) => p.length > 3 && s.includes(p));
  if (!subjectPresent) return { support: false, contradiction: false };
  if (shape.relation === "cures") {
    const objectPresent = objectWords.some((w) => s.includes(w)); const treatment = /cure|treat|prevent|effective|treatment|therapy/i.test(s);
    return { support: objectPresent && treatment && !negated(s), contradiction: negated(s) && /cancer|disease|illness|condition|treat|cure/i.test(s) };
  }
  if (shape.relation === "made_of") {
    const claimed = objectWords.some((w) => s.includes(w));
    const physical = /rock|rocky|silicate|mineral|iron|metal|basalt|olivine|pyroxene|oxygen|silicon|magnesium|aluminum|calcium|core|mantle|crust|regolith|dust|lava/i.test(s);
    const composition = /made of|made up of|composed of|consists of|contains|primarily|mainly|mostly/i.test(s);
    return { support: claimed && composition, contradiction: composition && physical && !claimed };
  }
  const objectPresent = objectWords.filter((w) => s.includes(w)).length >= Math.max(1, Math.ceil(objectWords.length * 0.5));
  const contradiction = negated(s) && (s.includes(subject) || objectPresent);
  return { support: objectPresent && !contradiction, contradiction };
}
function knowledgeDecision(claim: string, shape: ClaimShape | null, sources: Source[]): { verdict: Verdict; confidence: number; source: Source; explanation: string } | null {
  if (!shape || !sources.length) return null;
  const scored = sources.map((source) => { const rel = relationEvidence(shape, source.statement || ""); const relevance = Math.max(source.relevance, similarity(claim, source.statement || "", source.title)); return { source, relevance, support: rel.support, contradiction: rel.contradiction, bonus: isAuthoritative(source.url) ? 8 : 0 }; });
  const contradictions = scored.filter((x) => x.contradiction && x.relevance >= 35).sort((a, b) => (b.relevance + b.bonus) - (a.relevance + a.bonus));
  const supports = scored.filter((x) => x.support && x.relevance >= 35).sort((a, b) => (b.relevance + b.bonus) - (a.relevance + a.bonus));
  const c = contradictions[0]; const s = supports[0];
  if (c && (!s || c.relevance + c.bonus >= s.relevance + s.bonus)) return { verdict: "FALSE", confidence: clamp(78 + c.relevance * 0.16 + c.bonus), source: c.source, explanation: `The claim is contradicted by the evidence. ${c.source.statement || ""}` };
  if (s) return { verdict: "VERIFIED", confidence: clamp(78 + s.relevance * 0.16 + s.bonus), source: s.source, explanation: `The claim is supported by the evidence. ${s.source.statement || ""}` };
  return null;
}
function factDecision(factChecks: FactCheck[]): { verdict: Verdict; confidence: number; explanation: string; counterEvidence: string } | null {
  const rated = factChecks.filter((x) => x.rating === "true" || x.rating === "false" || x.rating === "misleading"); if (!rated.length) return null;
  const counts = { true: 0, false: 0, misleading: 0 }; for (const item of rated) counts[item.rating as keyof typeof counts] += 1;
  const strongest = Math.max(counts.true, counts.false, counts.misleading); const agreement = strongest / rated.length;
  const best = rated.slice().sort((a, b) => b.relevance - a.relevance)[0];
  const verdict: Verdict = counts.false === strongest ? "FALSE" : counts.true === strongest ? "VERIFIED" : "MISLEADING";
  const confidence = clamp(72 + agreement * 18 + Math.min(10, best.relevance * 0.1));
  const explanation = verdict === "FALSE" ? `Published fact-check evidence rates this claim as false. ${best.claim}` : verdict === "VERIFIED" ? `Published fact-check evidence rates this claim as true. ${best.claim}` : `Published fact-check evidence finds this claim misleading or lacking context. ${best.claim}`;
  return { verdict, confidence, explanation, counterEvidence: verdict === "FALSE" ? best.claim : "" };
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const claim = String(form.get("claim") || "").replace(/\s+/g, " ").trim();
    const ocrText = String(form.get("ocrText") || "").trim();
    const imageUploaded = String(form.get("imageUploaded") || "") === "true";
    if (!claim) return NextResponse.json({ error: "Please provide a claim to analyze." }, { status: 400 });

    const shape = parseClaim(claim);
    const [factChecks, wikipedia, wikidata, trusted, articles] = await Promise.all([
      getFactChecks(process.env.GOOGLE_FACT_CHECK_API_KEY, claim, shape),
      getWikipediaEvidence(claim, shape),
      getWikidataEvidence(shape),
      directTrustedEvidence(claim, shape),
      getNews(process.env.NEWS_API_KEY, claim)
    ]);

    const knowledgeSources = [...trusted, ...wikipedia, ...wikidata].filter((item, i, arr) => arr.findIndex((x) => x.url === item.url) === i).sort((a, b) => b.relevance - a.relevance);
    const fact = factDecision(factChecks);
    const knowledge = knowledgeDecision(claim, shape, knowledgeSources);

    let verdict: Verdict = "UNVERIFIED";
    let confidence = 0;
    let explanation = "There is not enough high-quality evidence to make a reliable determination. This does not mean the claim is true or false.";
    let counterEvidence = "";
    let evidenceType = "none";

    if (fact && fact.confidence >= 82) { verdict = fact.verdict; confidence = fact.confidence; explanation = fact.explanation; counterEvidence = fact.counterEvidence; evidenceType = "fact-check"; }
    if (knowledge && (knowledge.confidence > confidence || evidenceType === "none")) { verdict = knowledge.verdict; confidence = knowledge.confidence; explanation = knowledge.explanation; counterEvidence = knowledge.verdict === "FALSE" ? knowledge.source.statement || "" : ""; evidenceType = isAuthoritative(knowledge.source.url) ? "authoritative-source" : "knowledge-source"; }

    if (fact && knowledge) {
      if (fact.verdict === knowledge.verdict && fact.confidence >= 80 && knowledge.confidence >= 80) {
        verdict = fact.verdict; confidence = clamp(Math.max(fact.confidence, knowledge.confidence) + 4); evidenceType = "multi-source-agreement";
        explanation = `${fact.explanation} Independent knowledge evidence also supports this result.`;
        if (verdict === "FALSE") counterEvidence = knowledge.source.statement || fact.counterEvidence;
      } else if (fact.verdict !== knowledge.verdict && Math.min(fact.confidence, knowledge.confidence) >= 80) {
        verdict = "MISLEADING"; confidence = clamp(Math.min(fact.confidence, knowledge.confidence) - 8); evidenceType = "conflicting-evidence";
        explanation = "Strong sources disagree or the claim depends on context or timing. ContextLens AI is flagging the conflict rather than forcing a binary answer.";
      }
    }

    if (verdict === "UNVERIFIED" && knowledgeSources.length) confidence = clamp(Math.min(65, Math.max(...knowledgeSources.map((x) => x.relevance * 0.65))));

    const rated = factChecks.filter((x) => x.rating !== "unknown");
    const counts = { true: 0, false: 0, misleading: 0 }; for (const item of rated) counts[item.rating as keyof typeof counts] += 1;
    const strongest = rated.length ? Math.max(counts.true, counts.false, counts.misleading) : 0;
    const agreement = rated.length ? strongest / rated.length : 0;
    const confidenceLabel = verdict === "UNVERIFIED" ? "Evidence confidence — reflects how strongly the available evidence supports a conclusion; it is not a probability that the claim is true." : "Evidence confidence — reflects source quality, claim-level relevance and agreement across independent evidence.";
    const evidenceStrength = verdict === "UNVERIFIED" ? knowledgeSources.length ? "Related evidence was found, but it did not establish the claim strongly enough for a verdict." : "No sufficiently relevant fact-check or authoritative evidence was found." : evidenceType === "multi-source-agreement" ? "Strong agreement across independent fact-check and knowledge evidence." : evidenceType === "fact-check" ? `Based on ${rated.length} rated fact-check${rated.length === 1 ? "" : "s"} with ${Math.round(agreement * 100)}% agreement.` : "Supported by claim-level evidence from a trusted knowledge source.";

    return NextResponse.json({
      verdict, confidence: clamp(confidence), confidenceLabel, explanation, counterEvidence, evidenceType,
      imageContext: imageUploaded ? "Claim extracted from or checked alongside an uploaded image." : "",
      extractedTextAvailable: Boolean(ocrText), totalRatedFactChecks: rated.length, evidenceAgreement: agreement, factChecksFound: factChecks.length,
      authoritativeSources: knowledgeSources.filter((x) => isAuthoritative(x.url)).slice(0, 8), factCheckEvidence: factChecks.slice(0, 8), articles, evidenceStrength
    });
  } catch (error) {
    console.error("ContextLens analysis error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to analyze the claim." }, { status: 500 });
  }
}
