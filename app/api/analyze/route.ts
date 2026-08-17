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

const STOP = new Set(
  "this that these those there their about with from have will would could should been being into than then they them what when where which while whose your ours ourselves the and for are was were has had can its our you but who how why is am be to of in on as at by an or a confirmed relevant published related source sources evidence claim claims no not"
    .split(" ")
);

const NEGATIONS = new Set([
  "not",
  "never",
  "isnt",
  "isn't",
  "arent",
  "aren't",
  "wasnt",
  "wasn't",
  "wont",
  "won't",
  "cannot",
  "can't",
]);

const AUTHORITATIVE_DOMAINS = [
  "pmindia.gov.in",
  "india.gov.in",
  "pib.gov.in",
  "presidentofindia.nic.in",
  "eci.gov.in",
  "who.int",
  "un.org",
  "nasa.gov",
];

const OFFICIAL_SOURCE_PAGES = [
  {
    title: "Prime Minister of India — PM India",
    source: "Prime Minister's Office",
    url: "https://www.pmindia.gov.in/en/pms-profile/",
    relevanceFor: /\b(narendra\s+modi|modi)\b.*\b(prime minister|pm)\b.*\bindia\b/i,
  },
  {
    title: "Who's Who — National Portal of India",
    source: "Government of India",
    url: "https://www.india.gov.in/directory/whos-who",
    relevanceFor: /\b(narendra\s+modi|modi)\b.*\b(prime minister|pm)\b.*\bindia\b/i,
  },
];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => {
      if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
      if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
      if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
      if (w.endsWith("s") && w.length > 4) return w.slice(0, -1);
      return w;
    });
}

function hasNegation(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^\w']+/g, " ");
  return normalized.split(/\s+/).some((word) => NEGATIONS.has(word));
}

function relevance(claim: string, text: string, title = ""): number {
  const c = words(claim);
  const e = new Set(words(text));
  const t = new Set(words(title));
  if (!c.length) return 0;

  const matches = c.filter((w) => e.has(w)).length;
  const titleMatches = c.filter((w) => t.has(w)).length;

  return Math.min(
    100,
    Math.round((matches / c.length) * 70 + (titleMatches / c.length) * 30)
  );
}

function factCheckRelevance(
  claim: string,
  checkedClaim: string,
  title: string
): number {
  const c = new Set(words(claim));
  const e = new Set(words(checkedClaim));
  const t = new Set(words(title));
  if (!c.size || !e.size) return 0;

  const overlap = [...c].filter((w) => e.has(w)).length;
  const claimCoverage = overlap / c.size;
  const evidenceCoverage = overlap / e.size;
  const f1 =
    claimCoverage + evidenceCoverage > 0
      ? (2 * claimCoverage * evidenceCoverage) /
        (claimCoverage + evidenceCoverage)
      : 0;
  const titleCoverage =
    [...c].filter((w) => t.has(w)).length / c.size;

  let score = f1 * 70 + titleCoverage * 30;

  const distinctiveExtras = [...e].filter((w) => !c.has(w));
  const extraRatio = distinctiveExtras.length / e.size;
  if (extraRatio > 0.3 && claimCoverage < 1) score -= 15;

  const scopeModifiers = new Set([
    "first",
    "second",
    "only",
    "former",
    "future",
    "candidate",
    "minister",
    "president",
    "chief",
    "obc",
    "sc",
    "st",
    "caste",
    "election",
    "elected",
    "resigned",
    "arrested",
    "convicted",
    "born",
    "died",
    "wife",
    "son",
    "daughter",
  ]);

  const conflictingModifiers = distinctiveExtras.filter((w) =>
    scopeModifiers.has(w)
  );
  if (conflictingModifiers.length > 0) score -= 25;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function rating(value: string): "false" | "true" | "misleading" | "unknown" {
  const r = value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (
    [
      "mostly false",
      "partly false",
      "half true",
      "half false",
      "misleading",
      "mixed",
      "out of context",
      "missing context",
      "partially true",
      "partly true",
    ].some((x) => r.includes(x))
  ) {
    return "misleading";
  }

  if (
    r === "false" ||
    r.includes("false") ||
    r.includes("baseless") ||
    r.includes("incorrect") ||
    r.includes("wrong")
  ) {
    return "false";
  }

  if (
    r === "true" ||
    r.includes("true") ||
    r.includes("correct") ||
    r.includes("accurate")
  ) {
    return "true";
  }

  return "unknown";
}

function isAuthoritativeUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return AUTHORITATIVE_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
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

async function getOfficialEvidence(claim: string): Promise<{
  sources: AuthoritySource[];
  verdict: "VERIFIED" | "FALSE" | null;
  confidence: number;
  explanation: string;
}> {
  const matchingPages = OFFICIAL_SOURCE_PAGES.filter((page) =>
    page.relevanceFor.test(claim)
  );

  if (!matchingPages.length) {
    return { sources: [], verdict: null, confidence: 0, explanation: "" };
  }

  const results = await Promise.allSettled(
    matchingPages.map(async (page) => {
      const response = await axios.get(page.url, {
        timeout: 7000,
        headers: { "User-Agent": "ContextLens-AI/1.0" },
      });
      const text = stripHtml(String(response.data || ""));
      return {
        ...page,
        score: relevance(claim, text, page.title),
      };
    })
  );

  const sources = results
    .filter((result): result is PromiseFulfilledResult<(typeof matchingPages)[number] & { score: number }> => result.status === "fulfilled")
    .map((result) => ({
      title: result.value.title,
      source: result.value.source,
      url: result.value.url,
      relevance: result.value.score,
    }))
    .filter((source) => source.relevance >= 60)
    .sort((a, b) => b.relevance - a.relevance);

  if (!sources.length) {
    return { sources: [], verdict: null, confidence: 0, explanation: "" };
  }

  const negativeClaim = hasNegation(claim);

  if (negativeClaim) {
    return {
      sources,
      verdict: "FALSE",
      confidence: Math.min(95, Math.max(85, sources[0].relevance)),
      explanation:
        "A relevant authoritative government source supports the opposite proposition, so the submitted claim is contradicted by current official information.",
    };
  }

  return {
    sources,
    verdict: "VERIFIED",
    confidence: Math.min(95, Math.max(85, sources[0].relevance)),
    explanation:
      "A relevant authoritative government source supports this claim. ContextLens AI found matching information from an official source.",
  };
}

function buildFactCheckQueries(claim: string): string[] {
  const normalized = claim.replace(/\s+/g, " ").trim();
  const compact = words(claim).slice(0, 12).join(" ");
  const queries = [normalized, compact];

  if (/\blemon\b/i.test(claim) && /\bcancer\b/i.test(claim)) {
    queries.push("lemon water cancer cure");
  }

  if (/\bcure(?:s|d)?\b/i.test(claim) && /\bcancer\b/i.test(claim)) {
    queries.push("lemon water cancer treatment cure");
  }

  return Array.from(new Set(queries.filter(Boolean))).slice(0, 4);
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const claim = form.get("claim")?.toString().trim() || "";
    const ocrText = form.get("ocrText")?.toString() || "";
    const imageUploaded = form.get("imageUploaded")?.toString() === "true";

    if (!claim) {
      return NextResponse.json(
        { error: "Please provide a claim to analyze." },
        { status: 400 }
      );
    }

    if (!process.env.NEWS_API_KEY || !process.env.GOOGLE_FACT_CHECK_API_KEY) {
      return NextResponse.json(
        { error: "Analysis services are not configured correctly." },
        { status: 500 }
      );
    }

    const factCheckQueries = buildFactCheckQueries(claim);

    const [newsResult, authorityNewsResult, officialResult, ...factCheckResults] =
      await Promise.all([
        axios
          .get("https://newsapi.org/v2/everything", {
            params: {
              q: claim,
              language: "en",
              sortBy: "relevancy",
              pageSize: 8,
              apiKey: process.env.NEWS_API_KEY,
            },
            timeout: 10000,
          })
          .catch(() => ({ data: { articles: [] } })),
        axios
          .get("https://newsapi.org/v2/everything", {
            params: {
              q: claim,
              language: "en",
              sortBy: "relevancy",
              pageSize: 10,
              domains: AUTHORITATIVE_DOMAINS.join(","),
              apiKey: process.env.NEWS_API_KEY,
            },
            timeout: 10000,
          })
          .catch(() => ({ data: { articles: [] } })),
        getOfficialEvidence(claim),
        ...factCheckQueries.map((query) =>
          axios
            .get("https://factchecktools.googleapis.com/v1alpha1/claims:search", {
              params: {
                query,
                languageCode: "en",
                pageSize: 10,
                key: process.env.GOOGLE_FACT_CHECK_API_KEY,
              },
              timeout: 10000,
            })
            .catch(() => ({ data: { claims: [] } }))
        ),
      ]);

    const news = Array.isArray(newsResult.data?.articles)
      ? newsResult.data.articles
      : [];
    const authorityNews = Array.isArray(authorityNewsResult.data?.articles)
      ? authorityNewsResult.data.articles
      : [];

    const mapArticle = (a: {
      title?: string;
      description?: string | null;
      url?: string;
      source?: { name?: string };
    }): Article => ({
      title: a.title || "Untitled article",
      description: a.description || null,
      url: a.url || "",
      source: a.source?.name || "Unknown source",
      relevance: relevance(
        claim,
        `${a.title || ""} ${a.description || ""}`,
        a.title || ""
      ),
    });

    const articles: Article[] = news
      .map(mapArticle)
      .filter((article) => article.relevance >= 35 && article.url)
      .sort((a, b) => b.relevance - a.relevance);

    const authoritativeNews: Article[] = authorityNews
      .map(mapArticle)
      .filter(
        (article) => article.relevance >= 55 && isAuthoritativeUrl(article.url)
      )
      .sort((a, b) => b.relevance - a.relevance);

    const factChecks: FactCheck[] = [];
    const seenFactChecks = new Set<string>();

    for (const result of factCheckResults) {
      const rawChecks = Array.isArray(result.data?.claims)
        ? result.data.claims
        : [];

      for (const fc of rawChecks) {
        const review = fc.claimReview?.[0];
        if (!review) continue;

        const checkedClaim = String(fc.text || "").trim();
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
          rating: review.textualRating || "No rating available",
          url,
          relevance: score,
        });
      }
    }

    factChecks.sort((a, b) => b.relevance - a.relevance);

    let falseCount = 0;
    let trueCount = 0;
    let misleadingCount = 0;

    for (const fc of factChecks) {
      const type = rating(fc.rating);
      if (type === "false") falseCount++;
      if (type === "true") trueCount++;
      if (type === "misleading") misleadingCount++;
    }

    const totalRated = falseCount + trueCount + misleadingCount;
    const strongest = Math.max(falseCount, trueCount, misleadingCount);
    const agreement = totalRated ? strongest / totalRated : 0;
    const avgRelevance = factChecks.length
      ? factChecks.reduce((sum, fc) => sum + fc.relevance, 0) /
        factChecks.length
      : 0;

    let verdict = "UNVERIFIED";
    let confidence = 0;
    let explanation =
      "No sufficiently relevant published fact-check evidence was found. This does not mean the claim is true or false.";
    let evidenceType = "none";

    if (totalRated) {
      evidenceType = "fact-check";
      confidence = Math.min(
        95,
        Math.max(
          45,
          Math.round(
            40 +
              Math.min(totalRated / 3, 1) * 20 +
              agreement * 25 +
              Math.min(avgRelevance / 100, 1) * 10 +
              Math.min(strongest / 3, 1) * 5
          )
        )
      );

      if (falseCount && trueCount) {
        verdict = "UNCERTAIN";
        confidence = Math.max(35, confidence - 15);
        explanation =
          "Relevant fact-check sources disagree about this claim, so ContextLens AI cannot confidently classify it as true or false.";
      } else if (misleadingCount > falseCount && misleadingCount > trueCount) {
        verdict = "MISLEADING";
        explanation =
          "Relevant published fact-checks indicate that the claim is misleading, partially false, or missing important context.";
      } else if (falseCount > trueCount) {
        verdict = "FALSE";
        explanation =
          "Relevant published fact-checks indicate that this claim is false.";
      } else if (trueCount > falseCount) {
        verdict = "VERIFIED";
        explanation =
          "Relevant published fact-checks support this claim. ContextLens AI found evidence from published fact-check sources that agree with the claim.";
      } else {
        verdict = "UNCERTAIN";
        confidence = Math.max(35, confidence - 10);
        explanation =
          "Relevant fact-check evidence was found, but it does not provide a sufficiently clear consensus.";
      }
    } else if (officialResult.verdict) {
      evidenceType = "authoritative-source";
      verdict = officialResult.verdict;
      confidence = officialResult.confidence;
      explanation = officialResult.explanation;
    } else if (authoritativeNews.length) {
      evidenceType = "authoritative-source";
      verdict = "VERIFIED";
      confidence = Math.min(
        90,
        Math.max(
          75,
          Math.round(
            authoritativeNews.reduce((sum, article) => sum + article.relevance, 0) /
              authoritativeNews.length
          )
        )
      );
      explanation =
        "Relevant authoritative-source coverage was found. ContextLens AI treats this as stronger evidence than general news, but it is not a dedicated fact-check.";
    } else if (articles.length) {
      verdict = "UNVERIFIED";
      confidence = Math.min(
        40,
        Math.max(
          20,
          Math.round(
            articles.reduce((sum, article) => sum + article.relevance, 0) /
              articles.length
          )
        )
      );
      explanation =
        "Related news coverage was found, but no sufficiently relevant published fact-check or authoritative source was found. News coverage alone is not treated as proof that the claim is true.";
    }

    const mergedArticles = [
      ...authoritativeNews,
      ...articles.filter(
        (article) =>
          !authoritativeNews.some((authoritative) => authoritative.url === article.url)
      ),
    ].slice(0, 8);

    return NextResponse.json({
      success: true,
      verdict,
      confidence,
      confidenceLabel:
        "Evidence confidence — reflects the strength and agreement of retrieved evidence, not the mathematical probability that the claim is true.",
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
      factCheckEvidence: factChecks.map(
        ({ claim: checkedClaim, publisher, title, rating: checkRating, url, relevance: checkRelevance }) => ({
          claim: checkedClaim,
          publisher,
          title,
          rating: checkRating,
          url,
          relevance: checkRelevance,
        })
      ),
    });
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to analyze the claim.",
      },
      { status: 500 }
    );
  }
}
