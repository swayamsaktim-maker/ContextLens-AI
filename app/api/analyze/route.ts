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

const STOP = new Set(
  "this that these those there their about with from have will would could should been being into than then they them what when where which while whose your ours ourselves the and for are was were has had can its our you but not who how why is am be to of in on as at by an a or"
    .split(" ")
);

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

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) =>
      w.endsWith("ies") && w.length > 4
        ? `${w.slice(0, -3)}y`
        : w.endsWith("ing") && w.length > 5
        ? w.slice(0, -3)
        : w.endsWith("ed") && w.length > 4
        ? w.slice(0, -2)
        : w.endsWith("s") && w.length > 4
        ? w.slice(0, -1)
        : w
    );
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

// Fact-check search results are often about a related claim, not the exact
// proposition the user entered. Compare the checked proposition itself and
// penalize distinctive extra concepts so keyword overlap cannot masquerade as
// evidence for a different claim.
function factCheckRelevance(
  claim: string,
  checkedClaim: string,
  title: string
): number {
  const c = words(claim);
  const e = words(checkedClaim);
  const t = new Set(words(title));
  const cSet = new Set(c);
  const eSet = new Set(e);

  if (!cSet.size || !eSet.size) return 0;

  const overlap = [...cSet].filter((w) => eSet.has(w)).length;
  const claimCoverage = overlap / cSet.size;
  const evidenceCoverage = overlap / eSet.size;
  const f1 =
    claimCoverage + evidenceCoverage > 0
      ? (2 * claimCoverage * evidenceCoverage) /
        (claimCoverage + evidenceCoverage)
      : 0;
  const titleCoverage =
    [...cSet].filter((w) => t.has(w)).length / cSet.size;

  let score = f1 * 70 + titleCoverage * 30;

  const distinctiveExtras = [...eSet].filter((w) => !cSet.has(w));
  const extraRatio = distinctiveExtras.length / eSet.size;
  if (extraRatio > 0.3 && claimCoverage < 1) score -= 20;

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

    const [newsResult, fcResult, authorityResult] = await Promise.allSettled([
      axios.get("https://newsapi.org/v2/everything", {
        params: {
          q: claim,
          language: "en",
          sortBy: "relevancy",
          pageSize: 5,
          apiKey: process.env.NEWS_API_KEY,
        },
        timeout: 10000,
      }),
      axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", {
        params: {
          query: claim,
          languageCode: "en",
          pageSize: 10,
          key: process.env.GOOGLE_FACT_CHECK_API_KEY,
        },
        timeout: 10000,
      }),
      axios.get("https://newsapi.org/v2/everything", {
        params: {
          q: claim,
          language: "en",
          sortBy: "relevancy",
          pageSize: 10,
          domains: AUTHORITATIVE_DOMAINS.join(","),
          apiKey: process.env.NEWS_API_KEY,
        },
        timeout: 10000,
      }),
    ]);

    const news =
      newsResult.status === "fulfilled" &&
      Array.isArray(newsResult.value.data?.articles)
        ? newsResult.value.data.articles
        : [];

    const authorityNews =
      authorityResult.status === "fulfilled" &&
      Array.isArray(authorityResult.value.data?.articles)
        ? authorityResult.value.data.articles
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
      .filter((a: Article) => a.relevance >= 50)
      .sort((a: Article, b: Article) => b.relevance - a.relevance);

    const authoritativeArticles: Article[] = authorityNews
      .map(mapArticle)
      .filter(
        (a: Article) =>
          a.relevance >= 70 && isAuthoritativeUrl(a.url)
      )
      .sort((a: Article, b: Article) => b.relevance - a.relevance);

    const rawChecks =
      fcResult.status === "fulfilled" &&
      Array.isArray(fcResult.value.data?.claims)
        ? fcResult.value.data.claims
        : [];

    const factChecks: FactCheck[] = [];

    for (const fc of rawChecks) {
      const review = fc.claimReview?.[0];
      if (!review) continue;

      const checkedClaim = String(fc.text || "").trim();
      const title = String(review.title || "").trim();
      const score = factCheckRelevance(claim, checkedClaim, title);

      // Only close proposition matches can affect the verdict. A fact-check
      // about a different Modi claim must not label this claim FALSE.
      if (score >= 80) {
        factChecks.push({
          claim: checkedClaim || claim,
          publisher: review.publisher?.name || "Unknown publisher",
          title: title || "No title available",
          rating: review.textualRating || "No rating available",
          url: review.url || "",
          relevance: score,
        });
      }
    }

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
      ? factChecks.reduce((s, f) => s + f.relevance, 0) / factChecks.length
      : 0;

    let verdict = "UNVERIFIED";
    let confidence = 0;
    let explanation =
      "No sufficiently relevant published fact-check evidence was found. This does not mean the claim is true or false.";
    let evidenceType = "none";

    // Published fact-checks take precedence over general or official news.
    if (totalRated) {
      evidenceType = "fact-check";
      confidence = Math.min(
        95,
        Math.max(
          30,
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
      } else if (
        misleadingCount > falseCount &&
        misleadingCount > trueCount
      ) {
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
    } else if (authoritativeArticles.length) {
      // Official government/authority material can support a current factual
      // claim even when no dedicated fact-check exists. This fixes the common
      // case where a current office-holder or institutional fact has no Google
      // Fact Check entry.
      evidenceType = "authoritative-source";
      verdict = "VERIFIED";
      confidence = Math.min(
        95,
        Math.max(
          80,
          Math.round(
            75 +
              Math.min(
                authoritativeArticles.reduce((s, a) => s + a.relevance, 0) /
                  authoritativeArticles.length,
                100
              ) *
                0.2
          )
        )
      );
      explanation =
        "A relevant authoritative source supports this claim. ContextLens AI found matching information from a trusted government or institutional source.";
    } else if (articles.length) {
      verdict = "UNVERIFIED";
      confidence = Math.min(
        40,
        Math.max(
          20,
          Math.round(
            articles.reduce((s, a) => s + a.relevance, 0) / articles.length
          )
        )
      );
      explanation =
        "Related news coverage was found, but no sufficiently relevant published fact-check or authoritative source was found. News coverage alone is not treated as proof that the claim is true.";
    }

    const mergedArticles = [
      ...authoritativeArticles,
      ...articles.filter(
        (article) => !authoritativeArticles.some((a) => a.url === article.url)
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
      authoritativeSources: authoritativeArticles.map((article) => ({
        title: article.title,
        source: article.source,
        url: article.url,
        relevance: article.relevance,
      })),
      totalRatedFactChecks: totalRated,
      evidenceAgreement: agreement,
      factChecksFound: factChecks.length,
      factCheckEvidence: factChecks.map(
        ({ claim: checkedClaim, publisher, title, rating: checkRating, url }) => ({
          claim: checkedClaim,
          publisher,
          title,
          rating: checkRating,
          url,
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
