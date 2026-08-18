import { NextResponse } from "next/server";
import axios from "axios";

type Article = { title: string; description: string | null; url: string; source: string; relevance: number };
type FactCheck = { claim: string; publisher: string; title: string; rating: string; url: string; relevance: number };
type AuthoritySource = { title: string; source: string; url: string; relevance: number };
type RatingType = "false" | "true" | "misleading" | "unknown";
type RelationalClaim = { subject: string; role: string; country: string; negative: boolean };
type KnowledgeEvidence = { source: AuthoritySource; matched: boolean; contradicted: boolean; statement: string };

type OfficialRule = {
  names: RegExp;
  role: RegExp;
  country: RegExp;
  person: string;
  roleLabel: string;
  countryLabel: string;
  title: string;
  source: string;
  url: string;
  evidence: RegExp;
};

const STOP = new Set("this that these those there their about with from have will would could should been being into than then they them what when where which while whose your ours ourselves the and for are was were has had can its our you but who how why is am be to of in on as at by an or a confirmed relevant published related source sources evidence claim claims says said according current information".split(" "));
const NEGATIONS = new Set(["not", "never", "isnt", "isn't", "arent", "aren't", "wasnt", "wasn't", "wont", "won't", "cannot", "can't", "doesnt", "doesn't", "no", "without"]);

const AUTHORITATIVE_DOMAINS = [
  "pmindia.gov.in", "india.gov.in", "presidentofindia.gov.in", "presidentofindia.nic.in", "pib.gov.in", "eci.gov.in",
  "whitehouse.gov", "congress.gov", "usa.gov", "who.int", "un.org", "nasa.gov", "gov.uk", "europa.eu",
  "cdc.gov", "nih.gov", "fda.gov", "nci.nih.gov", "canada.ca", "australia.gov.au", "gov.au", "gov.in"
];

const OFFICIAL_RULES: OfficialRule[] = [
  { names: /\b(narendra\s+modi|modi)\b/i, role: /\b(prime\s+minister|pm)\b/i, country: /\b(india|indian)\b/i, person: "Narendra Modi", roleLabel: "Prime Minister", countryLabel: "India", title: "Prime Minister of India — PM India", source: "Prime Minister's Office", url: "https://www.pmindia.gov.in/en/pms-profile/", evidence: /\b(narendra\s+modi|shri\s+narendra\s+modi)\b[\s\S]{0,1200}\bprime\s+minister\b/i },
  { names: /\b(droupadi\s+murmu|murmu)\b/i, role: /\bpresident\b/i, country: /\b(india|indian)\b/i, person: "Droupadi Murmu", roleLabel: "President", countryLabel: "India", title: "The President of India — President of India", source: "President's Secretariat", url: "https://www.presidentofindia.gov.in/profile-0", evidence: /\b(droupadi\s+murmu|sm?t\.?\s+droupadi\s+murmu)\b[\s\S]{0,1200}\bpresident\b/i },
  { names: /\b(donald\s+j\.?\s+trump|donald\s+trump|trump)\b/i, role: /\bpresident\b/i, country: /\b(united\s+states|u\.?s\.?a?\.?|america|american)\b/i, person: "Donald J. Trump", roleLabel: "President", countryLabel: "the United States", title: "President Donald J. Trump — White House", source: "The White House", url: "https://www.whitehouse.gov/administration/donald-j-trump/", evidence: /\bdonald\s+j\.?\s+trump\b[\s\S]{0,1200}\bpresident\b[\s\S]{0,400}\b(united\s+states|america)\b/i }
];

function normalize(text: string): string { return text.toLowerCase().replace(/[’']/g, "'").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim(); }
function stem(word: string): string { if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`; if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3); if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2); if (word.endsWith("s") && word.length > 4) return word.slice(0, -1); return word; }
function words(text: string): string[] { return normalize(text).split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(stem); }
function clamp(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0; }
function hasNegation(text: string): boolean { return normalize(text).split(/\s+/).some(w => NEGATIONS.has(w)); }
function isAuthoritativeUrl(url: string): boolean { try { const host = new URL(url).hostname.toLowerCase(); return AUTHORITATIVE_DOMAINS.some(d => host === d || host.endsWith(`.${d}`)); } catch { return false; } }
function stripHtml(html: string): string { return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim(); }

function overlapScore(a: string, b: string, title = ""): number {
  const aw = new Set(words(a)); const bw = new Set(words(b)); const tw = new Set(words(title));
  if (!aw.size || !bw.size) return 0;
  const overlap = [...aw].filter(w => bw.has(w)).length;
  const coverage = overlap / aw.size;
  const evidenceCoverage = overlap / bw.size;
  const f1 = coverage + evidenceCoverage ? (2 * coverage * evidenceCoverage) / (coverage + evidenceCoverage) : 0;
  const titleCoverage = [...aw].filter(w => tw.has(w)).length / aw.size;
  return clamp(f1 * 75 + titleCoverage * 25);
}

function relevance(claim: string, text: string, title = ""): number { return overlapScore(claim, text, title); }
function rating(value: string): RatingType {
  const v = normalize(value);
  if (!v) return "unknown";
  if (/(mostly false|partly false|half true|half false|misleading|mixed|out of context|missing context|partially true|partly true)/.test(v)) return "misleading";
  if (/^(false)$|\b(false|baseless|incorrect|wrong|fake|fabricated)\b/.test(v)) return "false";
  if (/^(true)$|\b(true|correct|accurate|verified)\b/.test(v)) return "true";
  return "unknown";
}

function parseRelationalClaim(claim: string): RelationalClaim | null {
  const cleaned = claim.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(.+?)\s+(?:is|was|has been|is currently|was previously)\s+(?:the\s+)?(.+?)\s+of\s+(.+)$/i);
  if (!match) return null;
  const subject = match[1].trim(); const role = match[2].trim().replace(/^the\s+/i, ""); const country = match[3].trim();
  if (subject.length < 2 || role.length < 2 || country.length < 2) return null;
  return { subject, role, country, negative: hasNegation(cleaned) };
}

function extractNegation(claim: string): boolean { return /\b(?:is|was|has been|are|were)\s+(?:not|never|no longer)\b/i.test(claim) || hasNegation(claim); }

function buildFactCheckQueries(claim: string): string[] {
  const clean = claim.replace(/\s+/g, " ").trim();
  const tokens = words(clean);
  const compact = tokens.slice(0, 20).join(" ");
  const subject = tokens.slice(0, Math.min(6, tokens.length)).join(" ");
  const predicate = tokens.slice(Math.max(0, tokens.length - 8)).join(" ");
  const queries = [clean, `${clean} fact check`, compact, `${compact} fact check`, `${subject} ${predicate} fact check`];
  if (/\b(?:not|never|false|fake|wrong|incorrect)\b/i.test(clean)) queries.push(clean.replace(/\b(?:not|never|false|fake|wrong|incorrect)\b/gi, "").trim());
  return [...new Set(queries.filter(q => q.length >= 5))].slice(0, 8);
}

async function getOfficialEvidence(claim: string) {
  const rules = OFFICIAL_RULES.filter(r => r.names.test(claim));
  if (!rules.length) return { sources: [] as AuthoritySource[], verdict: null as "VERIFIED" | "FALSE" | null, confidence: 0, explanation: "", counterEvidence: "" };
  const results = await Promise.allSettled(rules.map(async rule => { const response = await axios.get(rule.url, { timeout: 8000, headers: { "User-Agent": "ContextLens-AI/1.0" } }); return { rule, ok: rule.evidence.test(stripHtml(String(response.data || ""))) }; }));
  const valid = results.filter((r): r is PromiseFulfilledResult<{ rule: OfficialRule; ok: boolean }> => r.status === "fulfilled" && r.value.ok).map(r => r.value.rule);
  if (!valid.length) return { sources: [], verdict: null as "VERIFIED" | "FALSE" | null, confidence: 0, explanation: "", counterEvidence: "" };
  const sources = valid.map(r => ({ title: r.title, source: r.source, url: r.url, relevance: 99 }));
  const rule = valid.find(r => r.role.test(claim) && r.country.test(claim));
  if (!rule) return { sources, verdict: null as "VERIFIED" | "FALSE" | null, confidence: 0, explanation: "", counterEvidence: "" };
  const statement = `${rule.person} is the ${rule.roleLabel} of ${rule.countryLabel}.`;
  const negative = extractNegation(claim);
  return { sources, verdict: negative ? "FALSE" as const : "VERIFIED" as const, confidence: 97, explanation: negative ? `The submitted claim is false because current authoritative information supports the opposite proposition. Evidence: ${statement}` : `The submitted claim is supported by current authoritative information. Evidence: ${statement}`, counterEvidence: negative ? statement : "" };
}

async function searchWikidata(subject: string): Promise<string | null> {
  try {
    const r = await axios.get("https://www.wikidata.org/w/api.php", { params: { action: "wbsearchentities", search: subject, language: "en", format: "json", type: "item", limit: 5 }, timeout: 7000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    const results = Array.isArray(r.data?.search) ? r.data.search : [];
    const exact = results.find((x: { label?: string }) => normalize(x.label || "") === normalize(subject));
    const person = results.find((x: { description?: string }) => /\b(person|politician|president|prime minister|minister|leader|scientist|writer|athlete|businessman|businesswoman|company)\b/i.test(x.description || ""));
    return exact?.id || person?.id || results[0]?.id || null;
  } catch { return null; }
}

async function getWikidataEvidence(claim: RelationalClaim): Promise<KnowledgeEvidence | null> {
  const id = await searchWikidata(claim.subject); if (!id) return null;
  try {
    const r = await axios.get(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, { timeout: 7000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    const entity = r.data?.entities?.[id]; const statements = Array.isArray(entity?.claims?.P39) ? entity.claims.P39 : [];
    const ids = statements.map((s: { mainsnak?: { datavalue?: { value?: { id?: string } } } }) => s.mainsnak?.datavalue?.value?.id).filter((x: unknown): x is string => typeof x === "string" && /^Q\d+$/.test(x));
    if (!ids.length) return null;
    const labels = await axios.get("https://www.wikidata.org/w/api.php", { params: { action: "wbgetentities", ids: [...new Set(ids)].join("|"), props: "labels", languages: "en", format: "json" }, timeout: 7000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    const wantedRole = new Set(words(claim.role)); const wantedCountry = new Set(words(claim.country));
    const positionLabels = [...new Set(ids)].map(id2 => String(labels.data?.entities?.[id2]?.labels?.en?.value || "")).filter(Boolean);
    const exact = positionLabels.find(label => { const w = new Set(words(label)); return [...wantedRole].every(x => w.has(x)) && [...wantedCountry].every(x => w.has(x)); });
    const sameRole = positionLabels.find(label => { const w = new Set(words(label)); return [...wantedRole].every(x => w.has(x)); });
    const best = exact || sameRole; if (!best) return null;
    const entityLabel = String(entity.labels?.en?.value || claim.subject);
    const statement = exact ? `${entityLabel} is listed as holding “${best}” in Wikidata.` : `${entityLabel} is listed as holding “${best}”, which conflicts with the submitted role/country.`;
    return { source: { title: `${entityLabel} — Wikidata`, source: "Wikidata", url: `https://www.wikidata.org/wiki/${id}`, relevance: exact ? 94 : 88 }, matched: Boolean(exact), contradicted: !exact, statement };
  } catch { return null; }
}

async function inferRatingFromPage(url: string): Promise<RatingType> {
  try {
    const r = await axios.get(url, { timeout: 7000, headers: { "User-Agent": "ContextLens-AI/1.0" } });
    const text = stripHtml(String(r.data || ""));
    if (/\b(false|fake|incorrect|wrong|not true|does not cure|cannot cure|no scientific evidence|no evidence that)\b/i.test(text)) return "false";
    if (/\b(misleading|partly true|partially true|missing context|out of context)\b/i.test(text)) return "misleading";
    if (/\b(true|correct|accurate|verified)\b/i.test(text)) return "true";
  } catch { /* ignore inaccessible publisher pages */ }
  return "unknown";
}

function factCheckConfidence(totalRated: number, agreement: number, relevanceAverage: number): number {
  const coverage = Math.min(totalRated / 3, 1); const consensus = Math.max(0, Math.min(agreement, 1)); const relevanceScore = Math.max(0, Math.min(relevanceAverage / 100, 1));
  return clamp(45 + coverage * 20 + consensus * 25 + relevanceScore * 10);
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
    const queries = factKey ? buildFactCheckQueries(claim) : [];
    const newsRequest = newsKey ? axios.get("https://newsapi.org/v2/everything", { params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, apiKey: newsKey }, timeout: 10000 }).catch(() => ({ data: { articles: [] } })) : Promise.resolve({ data: { articles: [] } });
    const authorityRequest = newsKey ? axios.get("https://newsapi.org/v2/everything", { params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, domains: AUTHORITATIVE_DOMAINS.join(","), apiKey: newsKey }, timeout: 10000 }).catch(() => ({ data: { articles: [] } })) : Promise.resolve({ data: { articles: [] } });
    const factRequests = queries.map(q => axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", { params: { query: q, languageCode: "en", pageSize: 10, key: factKey }, timeout: 10000 }).catch(() => ({ data: { claims: [] } })));
    const relational = parseRelationalClaim(claim);

    const [newsResult, authorityResult, official, knowledge, ...factResults] = await Promise.all([newsRequest, authorityRequest, getOfficialEvidence(claim), relational ? getWikidataEvidence(relational) : Promise.resolve(null), ...factRequests]);
    const rawNews = Array.isArray(newsResult.data?.articles) ? newsResult.data.articles : [];
    const rawAuthority = Array.isArray(authorityResult.data?.articles) ? authorityResult.data.articles : [];
    const mapArticle = (a: { title?: string; description?: string | null; url?: string; source?: { name?: string } }): Article => ({ title: a.title || "Untitled article", description: a.description || null, url: a.url || "", source: a.source?.name || "Unknown source", relevance: relevance(claim, `${a.title || ""} ${a.description || ""}`, a.title || "") });
    const articles: Article[] = rawNews.map(mapArticle).filter((a: Article) => a.url && a.relevance >= 30).sort((a: Article, b: Article) => b.relevance - a.relevance);
    const authoritativeNews: Article[] = rawAuthority.map(mapArticle).filter((a: Article) => a.url && a.relevance >= 50 && isAuthoritativeUrl(a.url)).sort((a: Article, b: Article) => b.relevance - a.relevance);

    const factChecks: FactCheck[] = [];
    const seen = new Set<string>();
    for (const result of factResults) {
      const claims = Array.isArray(result.data?.claims) ? result.data.claims : [];
      for (const item of claims) {
        const checkedClaim = String(item.text || "").trim();
        const reviews = Array.isArray(item.claimReview) ? item.claimReview : [];
        for (const review of reviews) {
          const title = String(review.title || "").trim(); const url = String(review.url || "").trim();
          const score = overlapScore(claim, checkedClaim, title);
          if (!url || score < 55) continue;
          const key = `${url}|${checkedClaim}`; if (seen.has(key)) continue; seen.add(key);
          factChecks.push({ claim: checkedClaim || claim, publisher: review.publisher?.name || "Unknown publisher", title: title || "No title available", rating: String(review.textualRating || "").trim(), url, relevance: score });
        }
      }
    }
    factChecks.sort((a, b) => b.relevance - a.relevance);

    const unrated = factChecks.filter(f => rating(f.rating) === "unknown");
    if (unrated.length) { const inferred = await Promise.all(unrated.slice(0, 8).map(f => inferRatingFromPage(f.url))); inferred.forEach((r, i) => { if (r === "false") unrated[i].rating = "False"; else if (r === "true") unrated[i].rating = "True"; else if (r === "misleading") unrated[i].rating = "Misleading"; }); }

    let falseCount = 0; let trueCount = 0; let misleadingCount = 0;
    for (const f of factChecks) { const r = rating(f.rating); if (r === "false") falseCount++; else if (r === "true") trueCount++; else if (r === "misleading") misleadingCount++; }
    const totalRated = falseCount + trueCount + misleadingCount;
    const strongest = Math.max(falseCount, trueCount, misleadingCount);
    const agreement = totalRated ? strongest / totalRated : 0;
    const avgRelevance = factChecks.length ? factChecks.reduce((s, f) => s + f.relevance, 0) / factChecks.length : 0;

    let verdict = "UNVERIFIED"; let confidence = 0; let explanation = "No sufficiently relevant published fact-check or authoritative evidence was found. This does not mean the claim is true or false."; let evidenceType = "none"; let counterEvidence = ""; let authoritativeSources: AuthoritySource[] = [];

    if (official.verdict) {
      verdict = official.verdict; confidence = official.confidence; explanation = official.explanation; counterEvidence = official.counterEvidence; authoritativeSources = official.sources; evidenceType = "authoritative-source";
    } else if (knowledge?.matched || knowledge?.contradicted) {
      const negative = relational?.negative ?? extractNegation(claim); const isFalse = Boolean(knowledge.contradicted || (knowledge.matched && negative));
      verdict = isFalse ? "FALSE" : "VERIFIED"; confidence = isFalse ? 92 : 94; counterEvidence = isFalse ? knowledge.statement : ""; explanation = isFalse ? `The submitted claim is false because current knowledge evidence contradicts it. Evidence: ${knowledge.statement}` : `The submitted claim is supported by current knowledge evidence. Evidence: ${knowledge.statement}`; authoritativeSources = [knowledge.source]; evidenceType = "knowledge-graph";
    } else if (totalRated > 0) {
      confidence = factCheckConfidence(totalRated, agreement, avgRelevance); evidenceType = "fact-check";
      if (falseCount > trueCount && falseCount >= misleadingCount) { verdict = "FALSE"; const f = factChecks.find(x => rating(x.rating) === "false"); counterEvidence = f?.claim || f?.title || "Published fact-check evidence contradicts the claim."; explanation = `Relevant published fact-check evidence indicates that this claim is false. Evidence: ${counterEvidence}`; }
      else if (trueCount > falseCount && trueCount >= misleadingCount) { verdict = "VERIFIED"; const f = factChecks.find(x => rating(x.rating) === "true"); explanation = `Relevant published fact-check evidence supports this claim. Evidence: ${f?.claim || f?.title || "Published fact-check evidence supports the claim."}`; }
      else if (misleadingCount > falseCount && misleadingCount > trueCount) { verdict = "MISLEADING"; const f = factChecks.find(x => rating(x.rating) === "misleading"); explanation = `Relevant published fact-check evidence indicates that this claim is misleading or missing important context. Evidence: ${f?.claim || f?.title || "Published fact-check evidence indicates missing context."}`; }
      else { verdict = "UNCERTAIN"; confidence = clamp(Math.max(50, confidence - 8)); explanation = "Relevant fact-check evidence was found, but the published ratings do not provide a sufficiently clear consensus."; }
    } else if (authoritativeNews.length) {
      evidenceType = "authoritative-news"; confidence = clamp(25 + authoritativeNews.slice(0, 3).reduce((s, a) => s + a.relevance, 0) / Math.min(3, authoritativeNews.length) * 0.2); explanation = "Related authoritative-source coverage was found, but news coverage alone is not treated as proof that the claim is true or false.";
    } else if (articles.length) {
      evidenceType = "news"; confidence = clamp(15 + articles.slice(0, 5).reduce((s, a) => s + a.relevance, 0) / Math.min(5, articles.length) * 0.2); explanation = "Related news coverage was found, but news coverage alone is not treated as proof that the claim is true or false.";
    }

    const mergedArticles = [...authoritativeNews, ...articles.filter(a => !authoritativeNews.some(x => x.url === a.url))].slice(0, 8);
    return NextResponse.json({ success: true, verdict, confidence: clamp(confidence), confidenceLabel: "Evidence confidence — reflects the strength and agreement of retrieved evidence, not the mathematical probability that the claim is true.", explanation, counterEvidence, evidenceType, imageContext: imageUploaded ? "This analysis was performed on a claim extracted from an uploaded image." : "This analysis was performed on text entered directly by the user.", extractedTextAvailable: Boolean(ocrText.trim()), articles: mergedArticles, authoritativeSources, totalRatedFactChecks: totalRated, evidenceAgreement: agreement, factChecksFound: factChecks.length, evidenceStrength: totalRated ? `Based on ${totalRated} rated fact-check${totalRated === 1 ? "" : "s"} with ${clamp(agreement * 100)}% agreement.` : authoritativeSources.length ? `Supported by ${authoritativeSources.length} relevant authoritative source${authoritativeSources.length === 1 ? "" : "s"}.` : "No published fact-check was found. Related sources are not treated as proof of truth.", factCheckEvidence: factChecks.map(f => ({ claim: f.claim, publisher: f.publisher, title: f.title, rating: f.rating || "Not machine-rated", url: f.url, relevance: f.relevance })) });
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to analyze the claim." }, { status: 500 });
  }
}
