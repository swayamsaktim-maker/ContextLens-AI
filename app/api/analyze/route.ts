import { NextResponse } from "next/server";
import axios from "axios";

type NewsArticle = {
  title: string;
  description: string | null;
  url: string;
  source: string;
  relevance: number;
};

type FactCheckEvidence = {
  claim: string;
  publisher: string;
  title: string;
  rating: string;
  url: string;
  relevance: number;
};

const STOP_WORDS = new Set([
  "this",
  "that",
  "these",
  "those",
  "there",
  "their",
  "about",
  "with",
  "from",
  "have",
  "will",
  "would",
  "could",
  "should",
  "been",
  "being",
  "into",
  "than",
  "then",
  "they",
  "them",
  "what",
  "when",
  "where",
  "which",
  "while",
  "whose",
  "your",
  "ours",
  "ourselves",
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "has",
  "had",
  "can",
  "its",
  "our",
  "you",
  "but",
  "not",
  "who",
  "how",
  "why",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

function normalizeWord(word: string): string {
  if (word.endsWith("ies") && word.length > 4) {
    return `${word.slice(0, -3)}y`;
  }

  if (word.endsWith("ing") && word.length > 5) {
    return word.slice(0, -3);
  }

  if (word.endsWith("ed") && word.length > 4) {
    return word.slice(0, -2);
  }

  if (word.endsWith("s") && word.length > 4) {
    return word.slice(0, -1);
  }

  return word;
}

function calculateRelevance(
  claim: string,
  title: string,
  description: string | null
): number {
  const claimWords = tokenize(claim).map(normalizeWord);

  if (claimWords.length === 0) {
    return 0;
  }

  const articleWords = new Set(
    tokenize(`${title} ${description || ""}`).map(normalizeWord)
  );

  const matchedWords = claimWords.filter((word) =>
    articleWords.has(word)
  );

  const lexicalScore =
    matchedWords.length / Math.max(claimWords.length, 1);

  // Give titles more importance because they are generally
  // a stronger signal of what the article is actually about.
  const titleWords = new Set(tokenize(title).map(normalizeWord));

  const titleMatches = claimWords.filter((word) =>
    titleWords.has(word)
  );

  const titleScore =
    titleMatches.length / Math.max(claimWords.length, 1);

  return Math.min(
    100,
    Math.round(lexicalScore * 70 + titleScore * 30)
  );
}

function calculateTextRelevance(
  claim: string,
  evidenceText: string
): number {
  const claimWords = tokenize(claim).map(normalizeWord);

  if (claimWords.length === 0) {
    return 0;
  }

  const evidenceWords = new Set(
    tokenize(evidenceText).map(normalizeWord)
  );

  const matches = claimWords.filter((word) =>
    evidenceWords.has(word)
  );

  return Math.round(
    (matches.length / claimWords.length) * 100
  );
}

function classifyRating(rating: string): {
  type: "false" | "true" | "misleading" | "unknown";
  strength: number;
} {
  const normalized = rating
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // More specific ratings must be checked before generic
  // "true"/"false" matching.
  if (
    normalized.includes("mostly false") ||
    normalized.includes("partly false") ||
    normalized.includes("half true") ||
    normalized.includes("half false") ||
    normalized.includes("misleading") ||
    normalized.includes("mixed") ||
    normalized.includes("out of context") ||
    normalized.includes("missing context") ||
    normalized.includes("partially true") ||
    normalized.includes("partly true")
  ) {
    return {
      type: "misleading",
      strength: 0.8,
    };
  }

  if (
    normalized === "false" ||
    normalized.includes("false") ||
    normalized.includes("baseless") ||
    normalized.includes("incorrect") ||
    normalized.includes("wrong")
  ) {
    return {
      type: "false",
      strength: 1,
    };
  }

  if (
    normalized === "true" ||
    normalized.includes("true") ||
    normalized.includes("correct") ||
    normalized.includes("accurate")
  ) {
    return {
      type: "true",
      strength: 1,
    };
  }

  return {
    type: "unknown",
    strength: 0,
  };
}

function getConfidence(
  strongestCount: number,
  totalRated: number,
  averageRelevance: number,
  agreement: number
): number {
  if (totalRated === 0) {
    return 0;
  }

  const evidenceCoverage = Math.min(totalRated / 3, 1);
  const relevanceStrength = Math.min(averageRelevance / 100, 1);

  const score =
    40 +
    evidenceCoverage * 20 +
    agreement * 25 +
    relevanceStrength * 10 +
    Math.min(strongestCount / 3, 1) * 5;

  return Math.min(95, Math.max(30, Math.round(score)));
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    const claim = formData.get("claim")?.toString() || "";
    const ocrText = formData.get("ocrText")?.toString() || "";

    const imageUploaded =
      formData.get("imageUploaded")?.toString() === "true";

    const cleanClaim = claim.trim();

    if (!cleanClaim) {
      return NextResponse.json(
        {
          error: "Please provide a claim to analyze.",
        },
        { status: 400 }
      );
    }

    if (
      !process.env.NEWS_API_KEY ||
      !process.env.GOOGLE_FACT_CHECK_API_KEY
    ) {
      return NextResponse.json(
        {
          error:
            "Analysis services are not configured correctly.",
        },
        { status: 500 }
      );
    }

    const [newsResult, factCheckResult] =
      await Promise.allSettled([
        axios.get(
          "https://newsapi.org/v2/everything",
          {
            params: {
              q: cleanClaim,
              language: "en",
              sortBy: "relevancy",
              pageSize: 5,
              apiKey: process.env.NEWS_API_KEY,
            },
            timeout: 10000,
          }
        ),

        axios.get(
          "https://factchecktools.googleapis.com/v1alpha1/claims:search",
          {
            params: {
              query: cleanClaim,
              languageCode: "en",
              pageSize: 10,
              key: process.env.GOOGLE_FACT_CHECK_API_KEY,
            },
            timeout: 10000,
          }
        ),
      ]);

    /*
     * ---------------------------------------------------------
     * NEWS EVIDENCE
     * ---------------------------------------------------------
     */

    const newsData =
      newsResult.status === "fulfilled"
        ? newsResult.value.data
        : null;

    const rawArticles = Array.isArray(newsData?.articles)
      ? newsData.articles
      : [];

    const articles: NewsArticle[] = rawArticles.map(
      (article: {
        title?: string;
        description?: string | null;
        url?: string;
        source?: { name?: string };
      }) => ({
        title: article.title || "Untitled article",
        description: article.description || null,
        url: article.url || "",
        source: article.source?.name || "Unknown source",
        relevance: calculateRelevance(
          cleanClaim,
          article.title || "",
          article.description || null
        ),
      })
    );

    const relevantArticles = articles
      .filter((article) => article.relevance >= 50)
      .sort((a, b) => b.relevance - a.relevance);

    /*
     * ---------------------------------------------------------
     * FACT CHECK EVIDENCE
     * ---------------------------------------------------------
     */

    const factCheckData =
      factCheckResult.status === "fulfilled"
        ? factCheckResult.value.data
        : null;

    const factChecks = Array.isArray(factCheckData?.claims)
      ? factCheckData.claims
      : [];

    const relevantFactChecks: FactCheckEvidence[] = [];

    for (const factCheck of factChecks) {
      const review = factCheck.claimReview?.[0];

      if (!review) {
        continue;
      }

      const evidenceText = [
        factCheck.text || "",
        review.title || "",
        review.textualRating || "",
        review.publisher?.name || "",
      ].join(" ");

      const relevance = calculateTextRelevance(
        cleanClaim,
        evidenceText
      );

      /*
       * A fact-check should have meaningful overlap with the
       * submitted claim before it influences the verdict.
       */
      if (relevance >= 50) {
        relevantFactChecks.push({
          claim: factCheck.text || cleanClaim,
          publisher:
            review.publisher?.name || "Unknown publisher",
          title: review.title || "No title available",
          rating:
            review.textualRating || "No rating available",
          url: review.url || "",
          relevance,
        });
      }
    }

    const factChecksFound = relevantFactChecks.length;

    /*
     * ---------------------------------------------------------
     * FACT CHECK RATING ANALYSIS
     * ---------------------------------------------------------
     */

    let falseCount = 0;
    let trueCount = 0;
    let misleadingCount = 0;

    const classifiedFactChecks = relevantFactChecks.map(
      (factCheck) => {
        const classification = classifyRating(
          factCheck.rating
        );

        if (classification.type === "false") {
          falseCount++;
        }

        if (classification.type === "true") {
          trueCount++;
        }

        if (classification.type === "misleading") {
          misleadingCount++;
        }

        return {
          ...factCheck,
          classification: classification.type,
          strength: classification.strength,
        };
      }
    );

    const totalRatedFactChecks =
      falseCount + trueCount + misleadingCount;

    const strongestEvidenceCount = Math.max(
      falseCount,
      trueCount,
      misleadingCount
    );

    const evidenceAgreement =
      totalRatedFactChecks > 0
        ? strongestEvidenceCount / totalRatedFactChecks
        : 0;

    const averageFactCheckRelevance =
      relevantFactChecks.length > 0
        ? relevantFactChecks.reduce(
            (sum, item) => sum + item.relevance,
            0
          ) / relevantFactChecks.length
        : 0;

    /*
     * ---------------------------------------------------------
     * VERDICT ENGINE
     * ---------------------------------------------------------
     *
     * Important:
     *
     * We intentionally DO NOT use "authoritative domain"
     * as automatic proof of truth.
     *
     * A WHO/NASA/government article can mention a claim
     * without supporting it.
     *
     * News article count also does NOT establish truth.
     */

    let verdict = "UNVERIFIED";
    let confidence = 0;

    let explanation =
      "No sufficiently relevant published fact-check evidence was found. This does not mean the claim is true or false.";

    if (totalRatedFactChecks > 0) {
      confidence = getConfidence(
        strongestEvidenceCount,
        totalRatedFactChecks,
        averageFactCheckRelevance,
        evidenceAgreement
      );

      /*
       * Conflicting fact-check evidence takes priority.
       */
      if (falseCount > 0 && trueCount > 0) {
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
      } else if (falseCount > trueCount && falseCount > 0) {
        verdict = "FALSE";

        explanation =
          "Relevant published fact-checks indicate that this claim is false.";
      } else if (trueCount > falseCount && trueCount > 0) {
        verdict = "SUPPORTED";

        explanation =
          "Relevant published fact-checks support the claim. ContextLens AI found evidence from published fact-check sources that agree with the claim.";
      } else {
        verdict = "UNCERTAIN";
        confidence = Math.max(35, confidence - 10);

        explanation =
          "Relevant fact-check evidence was found, but it does not provide a sufficiently clear consensus.";
      }
    } else if (relevantArticles.length > 0) {
      /*
       * News articles can provide context, but they cannot
       * independently establish that a claim is true.
       */
      verdict = "UNVERIFIED";
      confidence = Math.min(
        40,
        Math.max(
          20,
          Math.round(
            relevantArticles.reduce(
              (sum, article) => sum + article.relevance,
              0
            ) / relevantArticles.length
          )
        )
      );

      explanation =
        "Related news coverage was found, but no sufficiently relevant published fact-check was found. News coverage alone is not treated as proof that the claim is true.";
    }

    /*
     * ---------------------------------------------------------
     * RESPONSE
     * ---------------------------------------------------------
     */

    return NextResponse.json({
      success: true,
      verdict,
      confidence,

      /*
       * This makes the meaning of the number explicit to the UI.
       */
      confidenceLabel:
        "Evidence confidence — reflects the strength and agreement of retrieved evidence, not the mathematical probability that the claim is true.",

      explanation,

      imageContext: imageUploaded
        ? "This analysis was performed on a claim extracted from an uploaded image."
        : "This analysis was performed on text entered directly by the user.",

      /*
       * Useful for debugging the OCR pipeline without exposing
       * the raw image or API responses.
       */
      extractedTextAvailable: Boolean(ocrText.trim()),

      articles: relevantArticles,

      totalRatedFactChecks,
      evidenceAgreement,
      factChecksFound,

      /*
       * Only sources actually retrieved from Google Fact Check
       * are returned.
       */
      factCheckEvidence: classifiedFactChecks.map(
        ({
          claim,
          publisher,
          title,
          rating,
          url,
          relevance,
        }) => ({
          claim,
          publisher,
          title,
          rating,
          url,
          relevance,
        })
      ),
    });
  } catch (error) {
    console.error(
      "Analysis request failed:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

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