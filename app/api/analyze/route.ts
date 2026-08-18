import { NextResponse } from "next/server";
import axios from "axios";

type Article = {
  title: string;
  description: string | null;
  url: string;
  source: string;
  relevance: number;
};

type FactCheck = {
  claim: string;
  publisher: string;
  title: string;
  rating: string;
  url: string;
  relevance: number;
};

type AuthoritySource = {
  title: string;
  source: string;
  url: string;
  relevance: number;
};

type RatingType = "false" | "true" | "misleading" | "unknown";

type OfficialRule = {
  names: RegExp;
  expectedRole: RegExp;
  expectedCountry: RegExp;
  title: string;
  source: string;
  url: string;
  evidencePattern: RegExp;
};

const STOP = new Set(
  "this that these those there their about with from have will would could should been being into than then they them what when where which while whose your ours ourselves the and for are was were has had can its our you but who how why is am be to of in on as at by an or a confirmed relevant published related source sources evidence claim claims"
    .split(" ")
);

const NEGATIONS = new Set([
  "not", "never", "isnt", "isn't", "arent", "aren't", "wasnt", "wasn't",
  "wont", "won't", "cannot", "can't", "doesnt", "doesn't", "no",
]);

const AUTHORITATIVE_DOMAINS = [
  "pmindia.gov.in",
  "india.gov.in",
  "presidentofindia.gov.in",
  "presidentofindia.nic.in",
  "pib.gov.in",
  "eci.gov.in",
  "whitehouse.gov",
  "who.int",
  "un.org",
  "nasa.gov",
];

const OFFICIAL_RULES: OfficialRule[] = [
  {
    names: /\b(narendra\s+modi|modi)\b/i,
    expectedRole: /\b(prime\s+minister|pm)\b/i,
    expectedCountry: /\b(india|indian)\b/i,
    title: "Prime Minister of India — PM India",
    source: "Prime Minister's Office",
    url: "https://www.pmindia.gov.in/en/pms-profile/",
    evidencePattern: /\b(narendra\s+modi|shri\s+narendra\s+modi)\b[\s\S]{0,500}\bprime\s+minister\s+of\s+india\b/i,
  },
  {
    names: /\b(droupadi\s+murmu|murmu)\b/i,
    expectedRole: /\bpresident\b/i,
    expectedCountry: /\b(india|indian)\b/i,
    title: "The President of India — President of India",
    source: "President's Secretariat",
    url: "https://www.presidentofindia.gov.in/profile-0",
    evidencePattern: /\b(droupadi\s+murmu|sm?t\.?\s+droupadi\s+murmu)\b[\s\S]{0,500}\bpresident\s+of\s+india\b/i,
  },
  {
    names: /\b(donald\s+j\.?\s+trump|donald\s+trump|trump)\b/i,
    expectedRole: /\bpresident\b/i,
    expectedCountry: /\b(united\s+states|u\.?s\.?a?\.?|america|american)\b/i,
    title: "President Donald J. Trump — White House",
    source: "The White House",
    url: "https://www.whitehouse.gov/administration/donald-j-trump/",
    evidencePattern: /\bdonald\s+j\.?\s+trump\b[\s\S]{0,500}\bpresident\s+of\s+the\s+united\s+states\b/i,
  },
];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word))
    .map((word) => {
      if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
      if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
      if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
      if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
      return word;
    });
}

function hasNegation(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^\w']+/g, " ");
  return normalized.split(/\s+/).some((word) => NEGATIONS.has(word));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function relevance(claim: string, text: string, title = ""): number {
  const claimWords = words(claim);
  const evidenceWords = new Set(words(text));
  const titleWords = new Set(words(title));
  if (!claimWords.length) return 0;

  const bodyMatches = claimWords.filter((word) => evidenceWords.has(word)).length;
  const titleMatches = claimWords.filter((word) => titleWords.has(word)).length;

  return Math.min(
    100,
    Math.round((bodyMatches / claimWords.length) * 70 + (titleMatches / claimWords.length) * 30)
  );
}

function factCheckRelevance(claim: string, checkedClaim: string, title: string): number {
  const claimWords = new Set(words(claim));
  const checkedWords = new Set(words(checkedClaim));
  const titleWords = new Set(words(title));
  if (!claimWords.size || !checkedWords.size) return 0;

  const overlap = [...claimWords].filter((word) => checkedWords.has(word)).length;
  const claimCoverage = overlap / claimWords.size;
  const evidenceCoverage = overlap / checkedWords.size;
  const f1 = claimCoverage + evidenceCoverage > 0
    ? (2 * claimCoverage * evidenceCoverage) / (claimCoverage + evidenceCoverage)
    : 0;
  const titleCoverage = [...claimWords].filter((word) => titleWords.has(word)).length / claimWords.size;

  let score = f1 * 70 + titleCoverage * 30;
  const extras = [...checkedWords].filter((word) => !claimWords.has(word));
  if (extras.length / checkedWords.size > 0.3 && claimCoverage < 1) score -= 15;

  const scopeModifiers = new Set([
    "first", "second", "only", "former", "future", "candidate", "minister",
    "president", "chief", "obc", "sc", "st", "caste", "election", "elected",
    "resigned", "arrested", "convicted", "born", "died", "wife", "son", "daughter",
  ]);
  if (extras.some((word) => scopeModifiers.has(word))) score -= 25;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function rating(value: string): RatingType {
  const normalized = value.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown";

  if ([
    "mostly false", "partly false", "half true", "half false", "misleading",
    "mixed", "out of context", "missing context", "partially true", "partly true",
  ].some((item) => normalized.includes(item))) return "misleading";

  if (
    normalized === "false" || normalized.includes("false") || normalized.includes("baseless") ||
    normalized.includes("incorrect") || normalized.includes("wrong") || normalized.includes("fake")
  ) return "false";

  if (
    normalized === "true" || normalized.includes("true") || normalized.includes("correct") ||
    normalized.includes("accurate")
  ) return "true";

  return "unknown";
}

function isAuthoritativeUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return AUTHORITATIVE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
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

function calculateFactCheckConfidence(totalRated: number, agreement: number, averageRelevance: number): number {
  if (!totalRated) return 0;
  const coverage = Math.min(totalRated / 3, 1);
  const consensus = Math.max(0, Math.min(agreement, 1));
  const relevanceScore = Math.max(0, Math.min(averageRelevance / 100, 1));
  return clampPercent(45 + coverage * 20 + consensus * 25 + relevanceScore * 10);
}

async function inferRatingFromPage(url: string): Promise<RatingType> {
  try {
    const response = await axios.get(url, {
      timeout: 7000,
      headers: { "User-Agent": "ContextLens-AI/1.0" },
    });
    const text = stripHtml(String(response.data || ""));

    if (/\b(?:false|fake|incorrect|wrong|not true|does not cure|cannot cure|no scientific evidence|no evidence that)\b/i.test(text)) return "false";
    if (/\b(?:misleading|partly true|partially true|missing context|out of context)\b/i.test(text)) return "misleading";
    if (/\b(?:true|correct|accurate|verified)\b/i.test(text)) return "true";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function buildFactCheckQueries(claim: string): string[] {
  const normalized = claim.replace(/\s+/g, " ").trim();
  const compact = words(claim).slice(0, 16).join(" ");
  const queries = [normalized, compact];

  if (/\blemon\b/i.test(claim) && /\bcancer\b/i.test(claim)) {
    queries.push("lemon water cancer cure fact check");
    queries.push("lemons cure cancer fact check");
  }

  return Array.from(new Set(queries.filter(Boolean))).slice(0, 4);
}

async function getOfficialEvidence(claim: string): Promise<{
  sources: AuthoritySource[];
  verdict: "VERIFIED" | "FALSE" | null;
  confidence: number;
  explanation: string;
}> {
  const matchingRules = OFFICIAL_RULES.filter((rule) => rule.names.test(claim));
  if (!matchingRules.length) return { sources: [], verdict: null, confidence: 0, explanation: "" };

  const results = await Promise.allSettled(
    matchingRules.map(async (rule) => {
      const response = await axios.get(rule.url, {
        timeout: 7000,
        headers: { "User-Agent": "ContextLens-AI/1.0" },
      });
      const pageText = stripHtml(String(response.data || ""));
      return { rule, pageText, evidenceMatch: rule.evidencePattern.test(pageText) };
    })
  );

  const sources = results
    .filter((item): item is PromiseFulfilledResult<{ rule: OfficialRule; pageText: string; evidenceMatch: boolean }> => item.status === "fulfilled" && item.value.evidenceMatch)
    .map((item) => ({
      title: item.value.rule.title,
      source: item.value.rule.source,
      url: item.value.rule.url,
      relevance: 95,
    }));

  if (!sources.length) return { sources: [], verdict: null, confidence: 0, explanation: "" };

  const negative = hasNegation(claim);
  const roleClaim = matchingRules.some((rule) => rule.expectedRole.test(claim));
  const countryClaim = matchingRules.some((rule) => rule.expectedCountry.test(claim));

  // A role/country statement is only treated as authoritative when the
  // claim names the person and the relevant office/country. This prevents
  // an unrelated official page from becoming proof for an arbitrary claim.
  if (roleClaim && countryClaim) {
    const matchedRule = matchingRules.find((rule) => rule.expectedRole.test(claim) && rule.expectedCountry.test(claim));
    if (matchedRule) {
      const expectedCountryIsPresent = matchedRule.expectedCountry.test(claim);
      const expectedRoleIsPresent = matchedRule.expectedRole.test(claim);
      if (expectedCountryIsPresent && expectedRoleIsPresent) {
        return {
          sources,
          verdict: negative ? "FALSE" : "VERIFIED",
          confidence: 94,
          explanation: negative
            ? "Current authoritative government information supports the opposite proposition, so the submitted claim is contradicted by an official source."
            : "Current authoritative government information directly supports this claim.",
        };
      }
    }
  }

  // Catch obvious role mismatches such as “Trump is the president of India”.
  const subjectRule = matchingRules[0];
  const mentionsWrongCountry = /\b(india|indian)\b/i.test(claim) && !subjectRule.expectedCountry.test(claim);
  const mentionsWrongRole = /\b(prime\s+minister|president|chancellor|king|queen|chief\s+minister)\b/i.test(claim) && !subjectRule.expectedRole.test(claim);

  if (mentionsWrongCountry || mentionsWrongRole || negative) {
    return {
      sources,
      verdict: "FALSE",
      confidence: 94,
      explanation: "The submitted claim conflicts with current authoritative information from an official government source.",
    };
  }

  return { sources, verdict: null, confidence: 0, explanation: "" };
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const claim = form.get("claim")?.toString().trim() || "";
    const ocrText = form.get("ocrText")?.toString() || "";
    const imageUploaded = form.get("imageUploaded")?.toString() === "true";

    if (!claim) {
      return NextResponse.json({ error: "Please provide a claim to analyze." }, { status: 400 });
    }

    const factCheckApiKey = process.env.GOOGLE_FACT_CHECK_API_KEY;
    const newsApiKey = process.env.NEWS_API_KEY;
    const factCheckQueries = factCheckApiKey ? buildFactCheckQueries(claim) : [];

    const newsRequest = newsApiKey
      ? axios.get("https://newsapi.org/v2/everything", {
          params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, apiKey: newsApiKey },
          timeout: 10000,
        }).catch(() => ({ data: { articles: [] } }))
      : Promise.resolve({ data: { articles: [] } });

    const authorityNewsRequest = newsApiKey
      ? axios.get("https://newsapi.org/v2/everything", {
          params: {
            q: claim,
            language: "en",
            sortBy: "relevancy",
            pageSize: 10,
            domains: AUTHORITATIVE_DOMAINS.join(","),
            apiKey: newsApiKey,
          },
          timeout: 10000,
        }).catch(() => ({ data: { articles: [] } }))
      : Promise.resolve({ data: { articles: [] } });

    const factCheckRequests = factCheckQueries.map((query) =>
      axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", {
        params: { query, languageCode: "en", pageSize: 10, key: factCheckApiKey },
        timeout: 10000,
      }).catch(() => ({ data: { claims: [] } }))
    );

    const [newsResult, authorityNewsResult, officialResult, ...factCheckResults] = await Promise.all([
      newsRequest,
      authorityNewsRequest,
      getOfficialEvidence(claim),
      ...factCheckRequests,
    ]);

    const news = Array.isArray(newsResult.data?.articles) ? newsResult.data.articles : [];
    const authorityNews = Array.isArray(authorityNewsResult.data?.articles) ? authorityNewsResult.data.articles : [];

    const mapArticle = (article: {
      title?: string;
      description?: string | null;
      url?: string;
      source?: { name?: string };
    }): Article => ({
      title: article.title || "Untitled article",
      description: article.description || null,
      url: article.url || "",
      source: article.source?.name || "Unknown source",
      relevance: relevance(claim, `${article.title || ""} ${article.description || ""}`, article.title || ""),
    });

    const articles: Article[] = news
      .map(mapArticle)
      .filter((article: Article) => article.relevance >= 35 && Boolean(article.url))
      .sort((a: Article, b: Article) => b.relevance - a.relevance);

    const authoritativeNews: Article[] = authorityNews
      .map(mapArticle)
      .filter((article: Article) => article.relevance >= 55 && isAuthoritativeUrl(article.url))
      .sort((a: Article, b: Article) => b.relevance - a.relevance);

    const factChecks: FactCheck[] = [];
    const seenFactChecks = new Set<string>();

    for (const result of factCheckResults) {
      const rawChecks = Array.isArray(result.data?.claims) ? result.data.claims : [];
      for (const factCheck of rawChecks) {
        const review = factCheck.claimReview?.[0];
        if (!review) continue;

        const checkedClaim = String(factCheck.text || "").trim();
        const title = String(review.title || "").trim();
        const url = String(review.url || "").trim();
        const score = factCheckRelevance(claim, checkedClaim, title);
        if (score < 65 || !url) continue;

        const key = `${url}|${checkedClaim}`;
        if (seenFactChecks.has(key)) continue;
        seenFactChecks.add(key);

        factChecks.push({
          claim: checkedClaim || claim,
          publisher: review.publisher?.name || "Unknown publisher",
          title: title || "No title available",
          rating: String(review.textualRating || "").trim(),
          url,
          relevance: score,
        });
      }
    }

    factChecks.sort((a, b) => b.relevance - a.relevance);

    const unrated = factChecks.filter((factCheck) => rating(factCheck.rating) === "unknown");
    if (unrated.length) {
      const inferred = await Promise.all(unrated.slice(0, 6).map((factCheck) => inferRatingFromPage(factCheck.url)));
      inferred.forEach((value, index) => {
        if (value === "false") unrated[index].rating = "False";
        if (value === "true") unrated[index].rating = "True";
        if (value === "misleading") unrated[index].rating = "Misleading";
      });
    }

    let falseCount = 0;
    let trueCount = 0;
    let misleadingCount = 0;

    for (const factCheck of factChecks) {
      const type = rating(factCheck.rating);
      if (type === "false") falseCount += 1;
      if (type === "true") trueCount += 1;
      if (type === "misleading") misleadingCount += 1;
    }

    const totalRated = falseCount + trueCount + misleadingCount;
    const strongest = Math.max(falseCount, trueCount, misleadingCount);
    const agreement = totalRated ? strongest / totalRated : 0;
    const averageRelevance = factChecks.length
      ? factChecks.reduce((sum, factCheck) => sum + factCheck.relevance, 0) / factChecks.length
      : 0;

    let verdict = "UNVERIFIED";
    let confidence = 15;
    let explanation = "No sufficiently relevant published fact-check or authoritative evidence was found. This does not mean the claim is true or false.";
    let evidenceType = "none";

    if (totalRated > 0) {
      evidenceType = "fact-check";
      confidence = calculateFactCheckConfidence(totalRated, agreement, averageRelevance);

      if (falseCount > trueCount && falseCount >= misleadingCount) {
        verdict = "FALSE";
        explanation = "Relevant published fact-checks indicate that this claim is false.";
      } else if (trueCount > falseCount && trueCount >= misleadingCount) {
        verdict = "VERIFIED";
        explanation = "Relevant published fact-checks support this claim.";
      } else if (misleadingCount > falseCount && misleadingCount > trueCount) {
        verdict = "MISLEADING";
        explanation = "Relevant published fact-checks indicate that the claim is misleading or missing important context.";
      } else {
        verdict = "UNCERTAIN";
        confidence = Math.max(40, confidence - 10);
        explanation = "Relevant fact-check evidence was found, but the published ratings do not provide a sufficiently clear consensus.";
      }
    } else if (officialResult.verdict) {
      evidenceType = "authoritative-source";
      verdict = officialResult.verdict;
      confidence = clampPercent(officialResult.confidence);
      explanation = officialResult.explanation;
    } else if (authoritativeNews.length) {
      evidenceType = "authoritative-news";
      verdict = "UNVERIFIED";
      const topAuthority = authoritativeNews.slice(0, 3);
      const averageAuthorityRelevance = topAuthority.reduce((sum, article) => sum + article.relevance, 0) / Math.max(1, topAuthority.length);
      confidence = clampPercent(35 + averageAuthorityRelevance * 0.25);
      explanation = "Relevant authoritative-source coverage was found, but it does not directly establish the claim as true or false.";
    } else if (factChecks.length) {
      evidenceType = "fact-check-unrated";
      confidence = clampPercent(30 + averageRelevance * 0.35);
      explanation = "Relevant published fact-check pages were found, but their ratings could not be confirmed automatically. The claim is not treated as proven.";
    } else if (articles.length) {
      evidenceType = "news";
      const topArticles = articles.slice(0, 5);
      const averageNewsRelevance = topArticles.reduce((sum, article) => sum + article.relevance, 0) / Math.max(1, topArticles.length);
      confidence = clampPercent(20 + averageNewsRelevance * 0.25);
      explanation = "Related news coverage was found, but news coverage alone is not treated as proof that the claim is true or false.";
    }

    const mergedArticles = [
      ...authoritativeNews,
      ...articles.filter((article) => !authoritativeNews.some((authoritative) => authoritative.url === article.url)),
    ].slice(0, 8);

    return NextResponse.json({
      success: true,
      verdict,
      confidence: clampPercent(confidence),
      confidenceLabel: "Evidence confidence — reflects the strength and agreement of retrieved evidence, not the mathematical probability that the claim is true.",
      explanation,
      evidenceType,
      imageContext: imageUploaded
        ? "This analysis was performed on a claim extracted from an uploaded image."
        : "This analysis was performed on text entered directly by the user.",
      extractedTextAvailable: Boolean(ocrText.trim()),
      articles: mergedArticles,
      authoritativeSources: officialResult.sources.length
        ? officialResult.sources
        : authoritativeNews.map((article) => ({
            title: article.title,
            source: article.source,
            url: article.url,
            relevance: article.relevance,
          })),
      totalRatedFactChecks: totalRated,
      evidenceAgreement: agreement,
      factChecksFound: factChecks.length,
      factCheckEvidence: factChecks.map((factCheck) => ({
        claim: factCheck.claim,
        publisher: factCheck.publisher,
        title: factCheck.title,
        rating: factCheck.rating || "Not machine-rated",
        url: factCheck.url,
        relevance: factCheck.relevance,
      })),
    });
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to analyze the claim." },
      { status: 500 }
    );
  }
}
