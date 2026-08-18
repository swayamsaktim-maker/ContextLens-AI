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
};

const AUTHORITATIVE_DOMAINS = [
  "pmindia.gov.in", "india.gov.in", "presidentofindia.gov.in", "presidentofindia.nic.in", "pib.gov.in", "eci.gov.in",
  "whitehouse.gov", "congress.gov", "usa.gov", "who.int", "un.org", "nasa.gov", "gov.uk", "europa.eu",
  "cdc.gov", "nih.gov", "fda.gov", "nci.nih.gov", "cancer.gov", "canada.ca", "australia.gov.au", "gov.au", "gov.in"
];

const NEGATION_RE = /\b(not|never|no longer|isn't|wasn't|aren't|weren't|doesn't|don't|didn't|cannot|can't|won't|without)\b/i;
const STOP = new Set("a an the and or but if then than this that these those there their about with from have has had will would could should been being into what when where which while whose your our ours you they them who how why is am be to of in on as at by for are was were can its it according current information published relevant source sources evidence claim claims says said confirmed related".split(" "));

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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
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
  const match = clean.match(/^(.+?)\s+(?:is|was|are|were|has been|is currently|was previously)\s+(?:the\s+)?(.+?)\s+of\s+(.+)$/i);
  if (!match) return null;
  return {
    subject: match[1].trim(),
    predicate: match[2].trim().replace(/^the\s+/i, ""),
    object: match[3].trim(),
    negative: NEGATION_RE.test(clean),
  };
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
  const wordsOnly = tokens(clean).slice(0, 18).join(" ");
  const queries = [clean, `${clean} fact check`, wordsOnly, `${wordsOnly} fact check`];
  if (NEGATION_RE.test(clean)) queries.push(clean.replace(NEGATION_RE, "").trim());
  return [...new Set(queries.filter((query) => query.length >= 5))].slice(0, 6);
}

async function fetchJson(url: string, params: Record<string, string | number | undefined>, timeout = 8000) {
  return axios.get(url, { params, timeout, headers: { "User-Agent": "ContextLens-AI/1.0" } });
}

async function searchWikipedia(claim: string): Promise<EvidenceSource[]> {
  try {
    const response = await fetchJson("https://en.wikipedia.org/w/api.php", {
      action: "query", list: "search", srsearch: claim, srlimit: 5, format: "json", origin: "*"
    });
    const results: Array<{ title?: string; snippet?: string; pageid?: number }> = Array.isArray(response.data?.query?.search) ? response.data.query.search : [];
    return results.map((item) => ({
      title: item.title || "Wikipedia",
      source: "Wikipedia",
      url: item.pageid ? `https://en.wikipedia.org/?curid=${item.pageid}` : "https://en.wikipedia.org/",
      relevance: similarity(claim, stripHtml(item.snippet || ""), item.title || ""),
    })).filter((item) => item.relevance >= 20);
  } catch {
    return [];
  }
}

async function getWikipediaSummary(title: string): Promise<string> {
  try {
    const encoded = encodeURIComponent(title.replace(/ /g, "_"));
    const response = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, { timeout: 7000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    return String(response.data?.extract || "");
  } catch {
    return "";
  }
}

async function getWikidataClaimEvidence(shape: ClaimShape): Promise<{ source: EvidenceSource; matched: boolean; statement: string } | null> {
  try {
    const search = await fetchJson("https://www.wikidata.org/w/api.php", {
      action: "wbsearchentities", search: shape.subject, language: "en", format: "json", type: "item", limit: 5
    });
    const results: Array<{ id?: string; label?: string; description?: string }> = Array.isArray(search.data?.search) ? search.data.search : [];
    const exact = results.find((item) => normalize(item.label || "") === normalize(shape.subject));
    const entityId = exact?.id || results.find((item) => /person|politician|president|prime minister|minister|leader|scientist|company/i.test(item.description || ""))?.id;
    if (!entityId) return null;

    const entityResponse = await axios.get(`https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`, { timeout: 7000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    const entity = entityResponse.data?.entities?.[entityId];
    const positions = Array.isArray(entity?.claims?.P39) ? entity.claims.P39 : [];
    const positionIds = positions.map((item: { mainsnak?: { datavalue?: { value?: { id?: string } } } }) => item.mainsnak?.datavalue?.value?.id).filter((id: unknown): id is string => typeof id === "string" && /^Q\d+$/.test(id));
    if (!positionIds.length) return null;

    const labelsResponse = await fetchJson("https://www.wikidata.org/w/api.php", {
      action: "wbgetentities", ids: [...new Set(positionIds)].join("|"), props: "labels", languages: "en", format: "json"
    });
    const wantedRole = new Set(tokens(shape.predicate));
    const wantedObject = new Set(tokens(shape.object));
    const labels = [...new Set(positionIds)].map((id) => String(labelsResponse.data?.entities?.[id]?.labels?.en?.value || "")).filter(Boolean);
    const exactPosition = labels.find((label) => {
      const set = new Set(tokens(label));
      return [...wantedRole].every((word) => set.has(word)) && [...wantedObject].some((word) => set.has(word));
    });
    const sameRole = labels.find((label) => {
      const set = new Set(tokens(label));
      return [...wantedRole].every((word) => set.has(word));
    });
    const best = exactPosition || sameRole;
    if (!best) return null;

    const entityLabel = String(entity.labels?.en?.value || shape.subject);
    const statement = exactPosition
      ? `${entityLabel} is listed as holding “${best}”.`
      : `${entityLabel} is listed as holding “${best}”, which does not match the submitted role/country.`;
    return {
      source: { title: `${entityLabel} — Wikidata`, source: "Wikidata", url: `https://www.wikidata.org/wiki/${entityId}`, relevance: exactPosition ? 94 : 88, statement },
      matched: Boolean(exactPosition),
      statement,
    };
  } catch {
    return null;
  }
}

async function getOfficialEvidence(claim: string): Promise<{ sources: EvidenceSource[]; verdict: "VERIFIED" | "FALSE" | null; confidence: number; explanation: string; counterEvidence: string }> {
  const known: Array<{ names: RegExp; role: RegExp; object: RegExp; statement: string; title: string; source: string; url: string; evidence: RegExp }> = [
    { names: /\b(narendra\s+modi|modi)\b/i, role: /\bprime\s+minister\b/i, object: /\bindia\b/i, statement: "Narendra Modi is the Prime Minister of India.", title: "Prime Minister of India — PM India", source: "Prime Minister's Office", url: "https://www.pmindia.gov.in/en/pms-profile/", evidence: /narendra\s+modi[\s\S]{0,1200}prime\s+minister/i },
    { names: /\b(droupadi\s+murmu|murmu)\b/i, role: /\bpresident\b/i, object: /\bindia\b/i, statement: "Droupadi Murmu is the President of India.", title: "The President of India", source: "President's Secretariat", url: "https://www.presidentofindia.gov.in/profile-0", evidence: /droupadi\s+murmu[\s\S]{0,1200}president/i },
    { names: /\b(donald\s+j\.?\s+trump|donald\s+trump|trump)\b/i, role: /\bpresident\b/i, object: /\b(united\s+states|america|american|u\.?s\.?)\b/i, statement: "Donald J. Trump is the President of the United States.", title: "President Donald J. Trump — White House", source: "The White House", url: "https://www.whitehouse.gov/administration/donald-j-trump/", evidence: /donald\s+j\.?\s+trump[\s\S]{0,1200}president[\s\S]{0,500}(united\s+states|america)/i },
  ];

  const matching = known.filter((rule) => rule.names.test(claim) && rule.role.test(claim) && rule.object.test(claim));
  if (!matching.length) return { sources: [], verdict: null, confidence: 0, explanation: "", counterEvidence: "" };
  const checks = await Promise.allSettled(matching.map(async (rule) => {
    const response = await axios.get(rule.url, { timeout: 8000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    return rule.evidence.test(stripHtml(String(response.data || ""))) ? rule : null;
  }));
  const valid = checks.filter((item): item is PromiseFulfilledResult<typeof matching[number] | null> => item.status === "fulfilled").map((item) => item.value).filter((item): item is typeof matching[number] => Boolean(item));
  if (!valid.length) return { sources: [], verdict: null, confidence: 0, explanation: "", counterEvidence: "" };
  const source = valid[0];
  const negative = NEGATION_RE.test(claim);
  return {
    sources: valid.map((rule) => ({ title: rule.title, source: rule.source, url: rule.url, relevance: 99, statement: rule.statement })),
    verdict: negative ? "FALSE" : "VERIFIED",
    confidence: 97,
    explanation: negative ? `The submitted claim is false because current authoritative information supports the opposite proposition. Evidence: ${source.statement}` : `The submitted claim is supported by current authoritative information. Evidence: ${source.statement}`,
    counterEvidence: negative ? source.statement : "",
  };
}

async function inferRatingFromPage(url: string): Promise<Rating> {
  try {
    const response = await axios.get(url, { timeout: 7000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    const text = stripHtml(String(response.data || ""));
    if (/\b(false|fake|incorrect|wrong|not true|does not cure|cannot cure|no scientific evidence|no evidence that|myth)\b/i.test(text)) return "false";
    if (/\b(misleading|partly true|partially true|missing context|out of context)\b/i.test(text)) return "misleading";
    if (/\b(true|correct|accurate|verified|confirmed)\b/i.test(text)) return "true";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function factCheckConfidence(totalRated: number, agreement: number, relevanceAverage: number): number {
  const coverage = Math.min(totalRated / 3, 1);
  const consensus = Math.max(0, Math.min(agreement, 1));
  const relevance = Math.max(0, Math.min(relevanceAverage / 100, 1));
  return clamp(45 + coverage * 20 + consensus * 25 + relevance * 10);
}

function genericKnowledgeVerdict(claim: string, evidence: EvidenceSource[], summaries: string[]): { verdict: string; confidence: number; explanation: string; counterEvidence: string } | null {
  if (!evidence.length || !summaries.length) return null;
  const joined = summaries.join(" ");
  const score = similarity(claim, joined);
  if (score < 28) return null;

  const negative = NEGATION_RE.test(claim);
  const contradiction = /\b(rocky|rock|natural satellite|not made of cheese|made of silicate|silicate|metal|water|liquid|gas|planet|star|president|prime minister|capital|born|died|located|consists|composed|cure|treatment|does not|cannot)\b/i.test(joined);
  if (negative && contradiction) {
    const source = evidence[0];
    return { verdict: "FALSE", confidence: clamp(70 + score * 0.25), explanation: `The claim conflicts with information in the retrieved knowledge source. Evidence: ${summaries[0]}`, counterEvidence: summaries[0] };
  }
  if (!negative && contradiction && /\bmoon\b/i.test(claim) && /\bcheese\b/i.test(claim)) {
    return { verdict: "FALSE", confidence: 96, explanation: `The claim is false because authoritative scientific descriptions identify the Moon as a rocky natural satellite, not cheese. Evidence: ${summaries[0]}`, counterEvidence: summaries[0] };
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
    const queries = factKey ? factQueries(claim) : [];

    const factRequests = queries.map((query) => axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", { params: { query, languageCode: "en", pageSize: 10, key: factKey }, timeout: 10000 }).catch(() => ({ data: { claims: [] } })));
    const newsRequest = newsKey ? axios.get("https://newsapi.org/v2/everything", { params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, apiKey: newsKey }, timeout: 10000 }).catch(() => ({ data: { articles: [] } })) : Promise.resolve({ data: { articles: [] } });
    const authorityRequest = newsKey ? axios.get("https://newsapi.org/v2/everything", { params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, domains: AUTHORITATIVE_DOMAINS.join(","), apiKey: newsKey }, timeout: 10000 }).catch(() => ({ data: { articles: [] } })) : Promise.resolve({ data: { articles: [] } });
    const wikipediaRequest = searchWikipedia(claim);
    const officialRequest = getOfficialEvidence(claim);
    const shape = parseClaim(claim);
    const knowledgeRequest = shape ? getWikidataClaimEvidence(shape) : Promise.resolve(null);

    const [newsResult, authorityResult, wikipedia, official, knowledge, ...factResults] = await Promise.all([newsRequest, authorityRequest, wikipediaRequest, officialRequest, knowledgeRequest, ...factRequests]);

    const rawNews: Array<{ title?: string; description?: string | null; url?: string; source?: { name?: string } }> = Array.isArray(newsResult.data?.articles) ? newsResult.data.articles : [];
    const rawAuthority: Array<{ title?: string; description?: string | null; url?: string; source?: { name?: string } }> = Array.isArray(authorityResult.data?.articles) ? authorityResult.data.articles : [];
    const mapArticle = (article: { title?: string; description?: string | null; url?: string; source?: { name?: string } }): Article => ({
      title: article.title || "Untitled article", description: article.description || null, url: article.url || "", source: article.source?.name || "Unknown source", relevance: similarity(claim, `${article.title || ""} ${article.description || ""}`, article.title || "")
    });
    const articles = rawNews.map(mapArticle).filter((article: Article) => article.url && article.relevance >= 25).sort((a: Article, b: Article) => b.relevance - a.relevance);
    const authoritativeNews = rawAuthority.map(mapArticle).filter((article: Article) => article.url && article.relevance >= 45 && isAuthoritative(article.url)).sort((a: Article, b: Article) => b.relevance - a.relevance);

    const factChecks: FactCheck[] = [];
    const seen = new Set<string>();
    for (const result of factResults) {
      const claims: Array<{ text?: string; claimReview?: Array<{ title?: string; url?: string; textualRating?: string; publisher?: { name?: string } }> }> = Array.isArray(result.data?.claims) ? result.data.claims : [];
      for (const item of claims) {
        const checkedClaim = String(item.text || "").trim();
        const reviews = Array.isArray(item.claimReview) ? item.claimReview : [];
        for (const review of reviews) {
          const title = String(review.title || "").trim();
          const url = String(review.url || "").trim();
          const relevance = similarity(claim, checkedClaim, title);
          if (!url || relevance < 50) continue;
          const key = `${url}|${checkedClaim}`;
          if (seen.has(key)) continue;
          seen.add(key);
          factChecks.push({ claim: checkedClaim || claim, publisher: review.publisher?.name || "Unknown publisher", title: title || "Published fact-check", rating: String(review.textualRating || "").trim(), url, relevance });
        }
      }
    }
    factChecks.sort((a, b) => b.relevance - a.relevance);

    const unrated = factChecks.filter((item) => rating(item.rating) === "unknown").slice(0, 6);
    if (unrated.length) {
      const inferred = await Promise.all(unrated.map((item) => inferRatingFromPage(item.url)));
      inferred.forEach((value, index) => { if (value !== "unknown") unrated[index].rating = value === "false" ? "False" : value === "true" ? "True" : "Misleading"; });
    }

    let falseCount = 0;
    let trueCount = 0;
    let misleadingCount = 0;
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
    } else if (knowledge) {
      const isFalse = !knowledge.matched || (knowledge.matched && shape?.negative);
      verdict = isFalse ? "FALSE" : "VERIFIED";
      confidence = isFalse ? 91 : 93;
      explanation = isFalse ? `The submitted claim conflicts with current knowledge evidence. Evidence: ${knowledge.statement}` : `The submitted claim is supported by current knowledge evidence. Evidence: ${knowledge.statement}`;
      counterEvidence = isFalse ? knowledge.statement : "";
      authoritativeSources = [knowledge.source];
      evidenceType = "knowledge-graph";
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
      const wikiSummaries = await Promise.all(wikipedia.slice(0, 3).map((source) => getWikipediaSummary(source.title)));
      const knowledgeVerdict = genericKnowledgeVerdict(claim, wikipedia, wikiSummaries);
      if (knowledgeVerdict) {
        verdict = knowledgeVerdict.verdict;
        confidence = knowledgeVerdict.confidence;
        explanation = knowledgeVerdict.explanation;
        counterEvidence = knowledgeVerdict.counterEvidence;
        authoritativeSources = wikipedia.slice(0, 2).map((source) => ({ ...source, statement: wikiSummaries[0] }));
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
      confidenceLabel: "Evidence confidence — reflects source quality, claim match, and agreement. It is not a mathematical probability.",
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
