import { NextResponse } from "next/server";
import axios from "axios";
function calculateRelevance(
  claim: string,
  title: string,
  description: string | null
) {
  const claimWords = claim
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter((word) => word.length > 3);

  const articleText = `${title} ${description || ""}`.toLowerCase();

  const matchedWords = claimWords.filter((word) =>
    articleText.includes(word)
  );

  if (claimWords.length === 0) return 0;

  return Math.round(
    (matchedWords.length / claimWords.length) * 100
  );
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    const claim = formData.get("claim")?.toString() || "";
    const ocrText = formData.get("ocrText")?.toString() || "";
    
    const imageUploaded =
        formData.get("imageUploaded")?.toString() === "true";

    const cleanClaim = claim.trim();

    console.log("Received claim:", claim);
    console.log("Received OCR text:", ocrText);
    
    if (!claim) {
      return NextResponse.json(
        { error: "Please provide a claim to analyze." },
        { status: 400 }
      );
    }

    const response = await axios.get(
      "https://newsapi.org/v2/everything",
      {
        params: {
          q: cleanClaim,
          language: "en",
          sortBy: "relevancy",
          pageSize: 5,
          apiKey: process.env.NEWS_API_KEY,
        },
      }
    );

    const factCheckResponse = await axios.get(
        "https://factchecktools.googleapis.com/v1alpha1/claims:search",
        {
            params: {
                query: cleanClaim,
                languageCode: "en",
                pageSize: 10,
                key: process.env.GOOGLE_FACT_CHECK_API_KEY,
            },
        }
    );

    const factChecks = factCheckResponse.data.claims || [];
    console.log("Number of fact checks found:", factChecks.length);
    console.log(
        "FACT CHECK RAW RESULTS:",
        JSON.stringify(factChecks, null, 2)
    );
    const articles = response.data.articles.map(
      (article: {
        title: string;
        description: string | null;
        url: string;
        source: { name: string };
      }) => ({
        title: article.title,
        description: article.description,
        url: article.url,
        source: article.source.name,
        relevance: calculateRelevance(
            claim,
            article.title,
            article.description
        ),
      })
    );
    const relevantArticles = articles.filter(
        (article: { relevance: number }) => article.relevance >= 50
    );

    const relevantFactChecks = factChecks.filter((factCheck: any) => {
        const factCheckText =
            `${factCheck.text || ""} ${factCheck.claimReview?.[0]?.title || ""}`
                .toLowerCase();

        const claimWords = claim
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/)
            .filter(
                (word: string) =>
                word.length > 3 &&
                ![
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
            ].includes(word)
    );
        const matchingWords = claimWords.filter((word: string) => {
            if (factCheckText.includes(word)) {
                return true;
            }

            if (word.endsWith("s") && factCheckText.includes(word.slice(0, -1))) {
                return true;
            }

            if (
                 word.endsWith("ed") &&
                factCheckText.includes(word.slice(0, -2))
            ) {
                return true;
            }

            if (
                word.endsWith("ing") &&
                factCheckText.includes(word.slice(0, -3))
            ) {
                return true;
            }

            return false;
        });

        const matchingRatio =
            claimWords.length > 0
                ? matchingWords.length / claimWords.length
                : 0;

        const hasStrongMatch =
    (claimWords.length <= 2 && matchingWords.length >= 1) ||
    (matchingWords.length >= 3 && matchingRatio >= 0.5) ||
    matchingWords.length >= 4;
        return hasStrongMatch;
    });
     

    const factChecksFound = relevantFactChecks.length;
    const hasFactCheckEvidence = factChecksFound > 0;

    const factCheckEvidence = relevantFactChecks.map((factCheck: any) => ({
        claim: factCheck.text,
        publisher: factCheck.claimReview?.[0]?.publisher?.name || "Unknown",
        title: factCheck.claimReview?.[0]?.title || "No title available",
        rating: factCheck.claimReview?.[0]?.textualRating || "No rating available",
        url: factCheck.claimReview?.[0]?.url || "",
    }));

    const factCheckRatings = factCheckEvidence.map(
        (factCheck: any) => factCheck.rating.toLowerCase()
    );

    const falseCount = factCheckRatings.filter(
        (rating: string) =>
            rating.includes("false") ||
            rating.includes("baseless")
    ).length;

    const trueCount = factCheckRatings.filter(
        (rating: string) =>
            rating.includes("true") ||
            rating.includes("correct")
    ).length;

    const misleadingCount = factCheckRatings.filter(
        (rating: string) =>
            rating.includes("misleading") ||
            rating.includes("partly false") ||
            rating.includes("partly true") ||
            rating.includes("mixed")
    ).length;

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
    let evidenceConfidence = 0;

    if (totalRatedFactChecks > 0) {
        const evidenceStrength = Math.min(
            totalRatedFactChecks / 5,
            1
        );

        evidenceConfidence = Math.round(
            50 + evidenceAgreement * 35 + evidenceStrength * 10
        );

        evidenceConfidence = Math.min(evidenceConfidence, 95);
    } 

    const authoritativeDomains = [
    "gov.in",
    "nic.in",
    "who.int",
    "un.org",
    "nasa.gov",
    "ecisveep.nic.in",
    ];

    const hasAuthoritativeSource = articles.some((article: any) =>
        authoritativeDomains.some((domain) => article.url.includes(domain))
    );

    let verdict = "UNKNOWN";
    let confidence = 50;
    let explanation =
        "Not enough reliable evidence was found to confidently verify this claim.";
    if (factChecksFound === 0 && relevantArticles.length === 0) {
        verdict = "UNVERIFIED";
        confidence = 0;
        explanation =
            "No matching fact-check or sufficiently relevant source was found. This does not mean the claim is true or false.";
    } else if (factChecksFound === 0 && relevantArticles.length > 0) {
        verdict = "LIKELY TRUE";
        confidence = Math.min(85 + relevantArticles.length * 5, 95);
        explanation =
            "No published fact-check was found, but relevant real-time sources were found that support this claim.";
    } else if (
        falseCount > 0 &&
        trueCount > 0 &&
        Math.abs(falseCount - trueCount) <= 1
    ) {
        verdict = "UNCERTAIN";
        confidence = Math.max(30, evidenceConfidence - 25);
        explanation =
            "Relevant fact-check evidence is conflicting, so there is no clear consensus to confidently classify this claim as true or false.";
    } else if (
        misleadingCount > falseCount &&
        misleadingCount > trueCount &&
        misleadingCount > 0
    ) {
        verdict = "MISLEADING";
        confidence = evidenceConfidence;
        explanation =
            "Relevant published fact-checks indicate that this claim is misleading, partially false, or lacks important context.";
} else if (falseCount > trueCount && falseCount > 0) {
        verdict = "FALSE";
        confidence = evidenceConfidence;
        explanation =
            "Published fact-checks from independent sources indicate that this claim is false.";


} else if (hasAuthoritativeSource) {
    verdict = "VERIFIED";
    confidence = 100;
    explanation =
        "This claim is supported by a direct authoritative source found during real-time analysis.";
    } else if (!hasFactCheckEvidence && relevantArticles.length >= 5) {
        verdict = "LIKELY TRUE";
        confidence = 85;
        explanation =
            "Multiple highly relevant sources were found, but no direct authoritative source was found to fully verify the claim.";
    } else if (articles.length >= 3) {
    verdict = "LIKELY TRUE";
    confidence = 75;
    explanation =
        "Several relevant sources support this claim, but additional verification may be needed.";
    } else if (articles.length >= 1) {
    verdict = "UNCERTAIN";
    confidence = 60;
    explanation =
        "Some related information was found, but there is not enough evidence for a strong conclusion.";
    }

    return NextResponse.json({
      success: true,
      verdict,
      confidence,
      explanation,
      imageContext: imageUploaded
        ? "This analysis was performed on a claim extracted from an uploaded image."
        : "This analysis was performed on text entered directly by the user.",
      articles,
      totalRatedFactChecks,
      evidenceAgreement,
      factChecksFound,
      factCheckEvidence,
    });
  } catch (error) {
    console.error("Analysis error details:", error);
    console.error(
        "Error message:",
        error instanceof Error ? error.message : String(error)
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