import { NextResponse } from "next/server";
import axios from "axios";

type Article = { title: string; description: string | null; url: string; source: string; relevance: number };
type FactCheck = { claim: string; publisher: string; title: string; rating: string; url: string; relevance: number };
type EvidenceSource = { title: string; source: string; url: string; relevance: number; statement?: string };
type Rating = "true" | "false" | "misleading" | "unknown";

type ClaimShape = {
  subject: string;
  predicate: string;
  object: string;
  negative: boolean;
  relation: "is" | "made_of" | "cures" | "other";
};

type WikiResult = { title?: string; snippet?: string; pageid?: number };

const AUTHORITATIVE_DOMAINS = [
  "pmindia.gov.in", "india.gov.in", "presidentofindia.gov.in", "presidentofindia.nic.in", "pib.gov.in", "eci.gov.in",
  "whitehouse.gov", "congress.gov", "usa.gov", "who.int", "un.org", "nasa.gov", "gov.uk", "europa.eu",
  "cdc.gov", "nih.gov", "nci.nih.gov", "cancer.gov", "fda.gov", "canada.ca", "australia.gov.au", "gov.au", "gov.in"
];

const NEGATION_RE = /\b(not|never|no longer|isn't|wasn't|aren't|weren't|doesn't|don't|didn't|cannot|can't|won't|without)\b/i;
const STOP = new Set("a an the and or but if then than this that these those there their about with from have has had will would could should been being into what when where which while whose your our ours you they them who how why is am be to of in on as at by for are was were can its it according current information published relevant source sources evidence claim claims says said confirmed related made make".split(" "));

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim();
}

function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}

function tokens(text: string): string[] {
  return normalize(text).split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word)).map(stem);
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function isAuthoritative(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AUTHORITATIVE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
}

function similarity(claim: string, evidence: string, title = ""): number {
  const a = new Set(tokens(claim));
  const b = new Set(tokens(evidence));
  const t = new Set(tokens(title));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((word) => b.has(word)).length;
  const coverage = overlap / a.size;
  const evidenceCoverage = overlap / b.size;
  const f1 = coverage + evidenceCoverage ? (2 * coverage * evidenceCoverage) / (coverage + evidenceCoverage) : 0;
  const titleCoverage = [...a].filter((word) => t.has(word)).length / a.size;
  return clamp(f1 * 75 + titleCoverage * 25);
}

function parseClaim(claim: string): ClaimShape | null {
  const clean = claim.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  const negative = NEGATION_RE.test(clean);
  let match = clean.match(/^(.+?)\s+(?:is|was|are|were)\s+(?:the\s+)?(.+?)\s+of\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: match[2].trim(), object: match[3].trim(), negative, relation: "is" };
  match = clean.match(/^(.+?)\s+(?:is|was|are|were)\s+made\s+(?:primarily\s+|mostly\s+)?of\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: "made of", object: match[2].trim(), negative, relation: "made_of" };
  match = clean.match(/^(.+?)\s+(?:cures|cure|treats|treat|prevents|prevent)\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: clean.slice(match[1].length).replace(/\s+.+$/, "").trim(), object: match[2].trim(), negative, relation: "cures" };
  match = clean.match(/^(.+?)\s+(?:is|was|are|were)\s+(.+)$/i);
  if (match) return { subject: match[1].trim(), predicate: "is", object: match[2].trim(), negative, relation: "other" };
  return null;
}

function rating(value: string): Rating {
  const v = normalize(value);
  if (!v) return "unknown";
  if (/mostly false|partly false|half true|half false|misleading|mixed|out of context|missing context|partially true|partly true/.test(v)) return "misleading";
  if (/^(false)$|\b(false|baseless|incorrect|wrong|fake|fabricated|debunked)\b/.test(v)) return "false";
  if (/^(true)$|\b(true|correct|accurate|verified|confirmed)\b/.test(v)) return "true";
  return "unknown";
}

function factQueries(claim: string): string[] {
  const clean = claim.replace(/\s+/g, " ").trim();
  const shape = parseClaim(clean);
  const subject = shape?.subject || "";
  const queries = [clean, `${clean} fact check`, subject, `${subject} ${shape?.object || ""}`, `${clean} evidence`];
  if (NEGATION_RE.test(clean)) queries.push(clean.replace(NEGATION_RE, "").trim());
  return [...new Set(queries.filter((query) => query.trim().length >= 5))].slice(0, 7);
}

async function fetchJson(url: string, params: Record<string, string | number | undefined>, timeout = 9000) {
  return axios.get(url, { params, timeout, headers: { "User-Agent": "ContextLens-AI/2.0" } });
}

async function wikipediaSearch(query: string, limit = 6): Promise<WikiResult[]> {
  try {
    const response = await fetchJson("https://en.wikipedia.org/w/api.php", { action: "query", list: "search", srsearch: query, srlimit: limit, format: "json", origin: "*" });
    return Array.isArray(response.data?.query?.search) ? response.data.query.search : [];
  } catch {
    return [];
  }
}

async function wikipediaSummary(title: string): Promise<string> {
  try {
    const encoded = encodeURIComponent(title.replace(/ /g, "_"));
    const response = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, { timeout: 8000, headers: { "User-Agent": "ContextLens-AI/2.0" } });
    return String(response.data?.extract || "");
  } catch {
    return "";
  }
}

async function getWikipediaEvidence(claim: string, shape: ClaimShape | null): Promise<EvidenceSource[]> {
  const queries = [claim, shape?.subject || claim, shape ? `${shape.subject} ${shape.object}` : claim].filter(Boolean);
  const searches = await Promise.all(queries.map((query) => wikipediaSearch(query, 5)));
  const unique = new Map<string, WikiResult>();
  searches.flat().forEach((item) => { if (item.title) unique.set(item.title, item); });
  const candidates = [...unique.values()].slice(0, 8);
  const summaries = await Promise.all(candidates.map((item) => wikipediaSummary(item.title || "")));
  return candidates.map((item, index) => {
    const title = item.title || "Wikipedia";
    const summary = summaries[index];
    return {
      title,
      source: "Wikipedia",
      url: item.pageid ? `https://en.wikipedia.org/?curid=${item.pageid}` : `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      relevance: Math.max(similarity(claim, summary, title), similarity(claim, item.snippet || "", title)),
      statement: summary || stripHtml(item.snippet || ""),
    };
  }).filter((item) => item.statement && item.relevance >= 20).sort((a, b) => b.relevance - a.relevance);
}

async function getWikidataEvidence(shape: ClaimShape): Promise<EvidenceSource | null> {
  try {
    const search = await fetchJson("https://www.wikidata.org/w/api.php", { action: "wbsearchentities", search: shape.subject, language: "en", format: "json", type: "item", limit: 5 });
    const results: Array<{ id?: string; label?: string; description?: string }> = Array.isArray(search.data?.search) ? search.data.search : [];
    const entity = results.find((item) => normalize(item.label || "") === normalize(shape.subject)) || results[0];
    if (!entity?.id) return null;
    const response = await axios.get(`https://www.wikidata.org/wiki/Special:EntityData/${entity.id}.json`, { timeout: 8000, headers: { "User-Agent": "ContextLens-AI/2.0" } });
    const data = response.data?.entities?.[entity.id];
    const label = String(data?.labels?.en?.value || entity.label || shape.subject);
    const description = String(data?.descriptions?.en?.value || entity.description || "");
    if (!description) return null;
    return { title: `${label} — Wikidata`, source: "Wikidata", url: `https://www.wikidata.org/wiki/${entity.id}`, relevance: similarity(claimText(shape), `${label} ${description}`, label), statement: `${label} is described as ${description}.` };
  } catch {
    return null;
  }
}

function claimText(shape: ClaimShape): string {
  return `${shape.subject} ${shape.predicate} ${shape.object}`;
}

function extractKeyWords(text: string): Set<string> {
  return new Set(tokens(text));
}

function hasDirectContradiction(shape: ClaimShape, statement: string): boolean {
  const s = normalize(statement);
  const objectWords = [...extractKeyWords(shape.object)];
  if (!objectWords.length) return false;

  if (shape.relation === "made_of") {
    const physicalWords = ["rock", "rocky", "silicate", "metal", "ice", "water", "gas", "plasma", "soil", "stone", "dust", "iron", "oxygen", "carbon"];
    return objectWords.some((word) => /cheese|wood|paper|gold|plastic|chocolate|cotton|rubber|glass/.test(word)) && physicalWords.some((word) => s.includes(word));
  }

  if (shape.relation === "cures") {
    return /no evidence|does not cure|doesn't cure|cannot cure|can't cure|not a cure|not an effective treatment|no scientific evidence|not proven|unproven|myth/i.test(statement);
  }

  if (shape.relation === "is") {
    const predicateWords = extractKeyWords(shape.predicate);
    const object = normalize(shape.object);
    const statementWords = extractKeyWords(statement);
    const objectOverlap = objectWords.filter((word) => statementWords.has(word)).length;
    const predicateOverlap = [...predicateWords].filter((word) => statementWords.has(word)).length;
    if (objectOverlap === 0 && predicateOverlap > 0) {
      return /\b(not|instead|rather|actually|currently|is the|was the|known as|located in|born in|capital of)\b/i.test(s);
    }
  }
  return false;
}

function hasDirectSupport(shape: ClaimShape, statement: string): boolean {
  const s = normalize(statement);
  const objectWords = [...extractKeyWords(shape.object)];
  const predicateWords = [...extractKeyWords(shape.predicate)];
  const objectHits = objectWords.filter((word) => s.includes(word)).length;
  const predicateHits = predicateWords.filter((word) => s.includes(word)).length;
  if (shape.relation === "made_of") return objectHits > 0 && /made of|composed of|consists of|contains|primarily/i.test(s);
  if (shape.relation === "cures") return objectHits > 0 && /cure|treat|prevent|effective|treatment/i.test(s) && !/no evidence|does not|cannot|not a cure|unproven/i.test(s);
  return objectHits > 0 && (predicateHits > 0 || predicateWords.size === 0);
}

async function getOfficialEvidence(claim: string): Promise<{ sources: EvidenceSource[]; verdict: "VERIFIED" | "FALSE" | null; confidence: number; explanation: string; counterEvidence: string }> {
  const rules = [
    { names: /\b(narendra\s+modi|modi)\b/i, role: /\bprime\s+minister\b/i, object: /\bindia\b/i, statement: "Narendra Modi is the Prime Minister of India.", title: "Prime Minister of India — PM India", source: "Prime Minister's Office", url: "https://www.pmindia.gov.in/en/pms-profile/", evidence: /narendra\s+modi[\s\S]{0,1200}prime\s+minister/i },
    { names: /\b(droupadi\s+murmu|murmu)\b/i, role: /\bpresident\b/i, object: /\bindia\b/i, statement: "Droupadi Murmu is the President of India.", title: "The President of India", source: "President's Secretariat", url: "https://www.presidentofindia.gov.in/profile-0", evidence: /droupadi\s+murmu[\s\S]{0,1200}president/i },
    { names: /\b(donald\s+j\.?\s+trump|donald\s+trump|trump)\b/i, role: /\bpresident\b/i, object: /\b(united\s+states|america|american|u\.?s\.?)\b/i, statement: "Donald J. Trump is the President of the United States.", title: "President Donald J. Trump — White House", source: "The White House", url: "https://www.whitehouse.gov/administration/donald-j-trump/", evidence: /donald\s+j\.?\s+trump[\s\S]{0,1200}president[\s\S]{0,500}(united\s+states|america)/i },
  ];
  const matching = rules.filter((rule) => rule.names.test(claim) && rule.role.test(claim) && rule.object.test(claim));
  if (!matching.length) return { sources: [], verdict: null, confidence: 0, explanation: "", counterEvidence: "" };
  const checks = await Promise.allSettled(matching.map(async (rule) => {
    const response = await axios.get(rule.url, { timeout: 9000, headers: { "User-Agent": "ContextLens-AI/2.0" } });
    return rule.evidence.test(stripHtml(String(response.data || ""))) ? rule : null;
  }));
  const valid = checks.filter((item): item is PromiseFulfilledResult<typeof matching[number] | null> => item.status === "fulfilled").map((item) => item.value).filter(Boolean) as Array<typeof matching[number]>;
  if (!valid.length) return { sources: [], verdict: null, confidence: 0, explanation: "", counterEvidence: "" };
  const source = valid[0];
  const negative = NEGATION_RE.test(claim);
  return {
    sources: valid.map((rule) => ({ title: rule.title, source: rule.source, url: rule.url, relevance: 99, statement: rule.statement })),
    verdict: negative ? "FALSE" : "VERIFIED",
    confidence: 97,
    explanation: negative ? `The submitted claim is false because current authoritative information supports the opposite proposition: ${source.statement}` : `The submitted claim is supported by current authoritative information: ${source.statement}`,
    counterEvidence: negative ? source.statement : "",
  };
}

async function inferRatingFromPage(url: string): Promise<Rating> {
  try {
    const response = await axios.get(url, { timeout: 8000, headers: { "User-Agent": "ContextLens-AI/2.0" } });
    const text = stripHtml(String(response.data || ""));
    if (/\b(false|fake|incorrect|wrong|not true|does not cure|cannot cure|no scientific evidence|no evidence that|myth|debunked)\b/i.test(text)) return "false";
    if (/\b(misleading|partly true|partially true|missing context|out of context)\b/i.test(text)) return "misleading";
    if (/\b(true|correct|accurate|verified|confirmed)\b/i.test(text)) return "true";
  } catch { return "unknown"; }
  return "unknown";
}

function factCheckConfidence(totalRated: number, agreement: number, relevanceAverage: number): number {
  const coverage = Math.min(totalRated / 3, 1);
  const consensus = Math.max(0, Math.min(agreement, 1));
  const relevance = Math.max(0, Math.min(relevanceAverage / 100, 1));
  return clamp(45 + coverage * 20 + consensus * 25 + relevance * 10);
}

function evidenceDecision(claim: string, shape: ClaimShape | null, sources: EvidenceSource[]): { verdict: "VERIFIED" | "FALSE" | null; confidence: number; explanation: string; counterEvidence: string } | null {
  if (!shape || !sources.length) return null;
  const scored = sources.map((source) => {
    const statement = source.statement || "";
    const relevance = Math.max(source.relevance, similarity(claim, statement, source.title));
    return { source, statement, relevance, contradiction: hasDirectContradiction(shape, statement), support: hasDirectSupport(shape, statement) };
  }).sort((a, b) => b.relevance - a.relevance);

  const contradictions = scored.filter((item) => item.contradiction && item.relevance >= 25);
  const supports = scored.filter((item) => item.support && item.relevance >= 25);
  const bestContradiction = contradictions[0];
  const bestSupport = supports[0];

  if (bestContradiction && (!bestSupport || bestContradiction.relevance >= bestSupport.relevance)) {
    const confidence = clamp(78 + Math.min(18, bestContradiction.relevance * 0.18) + (isAuthoritative(bestContradiction.source.url) ? 5 : 0));
    return { verdict: "FALSE", confidence, explanation: `The claim is contradicted by retrieved evidence. ${bestContradiction.statement}`, counterEvidence: bestContradiction.statement };
  }
  if (bestSupport) {
    const confidence = clamp(78 + Math.min(18, bestSupport.relevance * 0.18) + (isAuthoritative(bestSupport.source.url) ? 5 : 0));
    return { verdict: "VERIFIED", confidence, explanation: `The claim is supported by retrieved evidence. ${bestSupport.statement}`, counterEvidence: "" };
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const claim = form.get("claim")?.toString().trim() || "";
    const ocrText = form.get("ocrText")?.toString() || "";
    const imageUploaded = form.get("imageUploaded")?.toString() === "true";
    if (!claim) return NextResponse.json({ error: "Please provide a claim to analyze." }, { status: 400 });

    const factKey = process.env.GOOGLE_FACT_CHECK_API_KEY;
    const newsKey = process.env.NEWS_API_KEY;
    const shape = parseClaim(claim);
    const queries = factKey ? factQueries(claim) : [];

    const factRequests = queries.map((query) => axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", { params: { query, languageCode: "en", pageSize: 10, key: factKey }, timeout: 10000 }).catch(() => ({ data: { claims: [] } })));
    const newsRequest = newsKey ? axios.get("https://newsapi.org/v2/everything", { params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, apiKey: newsKey }, timeout: 10000 }).catch(() => ({ data: { articles: [] } })) : Promise.resolve({ data: { articles: [] } });
    const authorityRequest = newsKey ? axios.get("https://newsapi.org/v2/everything", { params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, domains: AUTHORITATIVE_DOMAINS.join(","), apiKey: newsKey }, timeout: 10000 }).catch(() => ({ data: { articles: [] } })) : Promise.resolve({ data: { articles: [] } });
    const [newsResult, authorityResult, wikipedia, official, ...factResults] = await Promise.all([newsRequest, authorityRequest, getWikipediaEvidence(claim, shape), getOfficialEvidence(claim), ...factRequests]);

    const rawNews: Array<{ title?: string; description?: string | null; url?: string; source?: { name?: string } }> = Array.isArray(newsResult.data?.articles) ? newsResult.data.articles : [];
    const rawAuthority: Array<{ title?: string; description?: string | null; url?: string; source?: { name?: string } }> = Array.isArray(authorityResult.data?.articles) ? authorityResult.data.articles : [];
    const mapArticle = (article: { title?: string; description?: string | null; url?: string; source?: { name?: string } }): Article => ({ title: article.title || "Untitled article", description: article.description || null, url: article.url || "", source: article.source?.name || "Unknown source", relevance: similarity(claim, `${article.title || ""} ${article.description || ""}`, article.title || "") });
    const articles = rawNews.map(mapArticle).filter((article: Article) => article.url && article.relevance >= 25).sort((a: Article, b: Article) => b.relevance - a.relevance);
    const authoritativeNews = rawAuthority.map(mapArticle).filter((article: Article) => article.url && article.relevance >= 40 && isAuthoritative(article.url)).sort((a: Article, b: Article) => b.relevance - a.relevance);

    const factChecks: FactCheck[] = [];
    const seen = new Set<string>();
    for (const result of factResults) {
      const claims: Array<{ text?: string; claimReview?: Array<{ title?: string; url?: string; textualRating?: string; publisher?: { name?: string } }> }> = Array.isArray(result.data?.claims) ? result.data.claims : [];
      for (const item of claims) {
        const checkedClaim = String(item.text || "").trim();
        const relevance = similarity(claim, checkedClaim);
        if (relevance < 45) continue;
        for (const review of Array.isArray(item.claimReview) ? item.claimReview : []) {
          const url = String(review.url || "").trim();
          if (!url) continue;
          const key = `${url}|${checkedClaim}`;
          if (seen.has(key)) continue;
          seen.add(key);
          factChecks.push({ claim: checkedClaim || claim, publisher: review.publisher?.name || "Unknown publisher", title: String(review.title || "Published fact-check"), rating: String(review.textualRating || ""), url, relevance });
        }
      }
    }
    factChecks.sort((a, b) => b.relevance - a.relevance);

    const unrated = factChecks.filter((item) => rating(item.rating) === "unknown").slice(0, 8);
    if (unrated.length) {
      const inferred = await Promise.all(unrated.map((item) => inferRatingFromPage(item.url)));
      inferred.forEach((value, index) => { if (value !== "unknown") unrated[index].rating = value === "false" ? "False" : value === "true" ? "True" : "Misleading"; });
    }

    let falseCount = 0, trueCount = 0, misleadingCount = 0;
    for (const item of factChecks) {
      const value = rating(item.rating);
      if (value === "false") falseCount += 1;
      if (value === "true") trueCount += 1;
      if (value === "misleading") misleadingCount += 1;
    }
    const totalRated = falseCount + trueCount + misleadingCount;
    const strongest = Math.max(falseCount, trueCount, misleadingCount);
    const agreement = totalRated ? strongest / totalRated : 0;
    const averageRelevance = factChecks.length ? factChecks.reduce((sum, item) => sum + item.relevance, 0) / factChecks.length : 0;

    let verdict = "UNVERIFIED";
    let confidence = 0;
    let explanation = "No sufficiently relevant published fact-check or authoritative evidence was found. This does not mean the claim is true or false.";
    let counterEvidence = "";
    let evidenceType = "none";
    let authoritativeSources: EvidenceSource[] = [];

    if (official.verdict) {
      verdict = official.verdict;
      confidence = official.confidence;
      explanation = official.explanation;
      counterEvidence = official.counterEvidence;
      authoritativeSources = official.sources;
      evidenceType = "authoritative-source";
    } else if (totalRated > 0) {
      confidence = factCheckConfidence(totalRated, agreement, averageRelevance);
      evidenceType = "fact-check";
      if (falseCount > trueCount && falseCount >= misleadingCount) {
        verdict = "FALSE";
        const item = factChecks.find((entry) => rating(entry.rating) === "false");
        counterEvidence = item?.claim || item?.title || "Published fact-check evidence contradicts the submitted claim.";
        explanation = `Relevant published fact-check evidence indicates that this claim is false. Evidence: ${counterEvidence}`;
      } else if (trueCount > falseCount && trueCount >= misleadingCount) {
        verdict = "VERIFIED";
        const item = factChecks.find((entry) => rating(entry.rating) === "true");
        counterEvidence = item?.claim || item?.title || "Published fact-check evidence supports the submitted claim.";
        explanation = `Relevant published fact-check evidence supports this claim. Evidence: ${counterEvidence}`;
      } else if (misleadingCount > falseCount && misleadingCount > trueCount) {
        verdict = "MISLEADING";
        const item = factChecks.find((entry) => rating(entry.rating) === "misleading");
        counterEvidence = item?.claim || item?.title || "Published fact-check evidence indicates missing or misleading context.";
        explanation = `Relevant published fact-check evidence indicates that this claim is misleading or missing important context. Evidence: ${counterEvidence}`;
      } else {
        verdict = "UNCERTAIN";
        confidence = Math.max(55, confidence - 8);
        explanation = "Relevant fact-check evidence was found, but the published ratings do not provide a sufficiently clear consensus.";
      }
    } else {
      const knowledgeSources = [...wikipedia];
      const decision = evidenceDecision(claim, shape, knowledgeSources);
      if (decision) {
        verdict = decision.verdict || "UNVERIFIED";
        confidence = decision.confidence;
        explanation = decision.explanation;
        counterEvidence = decision.counterEvidence;
        authoritativeSources = knowledgeSources.filter((source) => source.statement).slice(0, 3);
        evidenceType = "general-knowledge";
      } else if (authoritativeNews.length) {
        evidenceType = "authoritative-news";
        confidence = clamp(45 + authoritativeNews.slice(0, 3).reduce((sum, item) => sum + item.relevance, 0) / Math.min(3, authoritativeNews.length) * 0.25);
        explanation = "Relevant authoritative-source coverage was found, but news coverage alone is not treated as proof that the claim is true or false.";
      } else if (articles.length) {
        evidenceType = "news";
        confidence = clamp(25 + articles.slice(0, 5).reduce((sum, item) => sum + item.relevance, 0) / Math.min(5, articles.length) * 0.2);
        explanation = "Related news coverage was found, but news coverage alone is not treated as proof that the claim is true or false.";
      }
    }

    const mergedArticles = [...authoritativeNews, ...articles.filter((article) => !authoritativeNews.some((source) => source.url === article.url))].slice(0, 8);
    const evidenceStrength = totalRated
      ? `Based on ${totalRated} rated fact-check${totalRated === 1 ? "" : "s"} with ${clamp(agreement * 100)}% agreement.`
      : authoritativeSources.length
        ? `Supported by ${authoritativeSources.length} relevant evidence source${authoritativeSources.length === 1 ? "" : "s"}.`
        : "No sufficiently strong published evidence was found. This is not proof that the claim is true.";

    return NextResponse.json({
      success: true,
      verdict,
      confidence: clamp(confidence),
      confidenceLabel: "Evidence confidence — reflects source quality, claim match, contradiction/support strength, and agreement. It is not a mathematical probability.",
      explanation,
      counterEvidence,
      evidenceType,
      imageContext: imageUploaded ? "This analysis was performed on a claim extracted from an uploaded image." : "This analysis was performed on text entered directly by the user.",
      extractedTextAvailable: Boolean(ocrText.trim()),
      articles: mergedArticles,
      authoritativeSources,
      totalRatedFactChecks: totalRated,
      evidenceAgreement: agreement,
      factChecksFound: factChecks.length,
      evidenceStrength,
      factCheckEvidence: factChecks.map((item) => ({ claim: item.claim, publisher: item.publisher, title: item.title, rating: item.rating || "Not machine-rated", url: item.url, relevance: item.relevance })),
    });
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to analyze the claim." }, { status: 500 });
  }
}
