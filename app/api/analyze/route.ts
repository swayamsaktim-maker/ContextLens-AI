import { NextResponse } from "next/server";
import axios from "axios";
import { articleRelevance, evaluateFactChecks, finalVerdict, compositionContradiction } from "../../../lib/verificationEngine";

async function wikipediaEvidence(claim: string) {
  try {
    const search = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", list: "search", srsearch: claim, format: "json", origin: "*", srlimit: 3 },
      timeout: 6000,
    });
    const title = search.data?.query?.search?.[0]?.title;
    if (!title) return null;
    const result = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { timeout: 6000 });
    return {
      title,
      extract: result.data?.extract || "",
      url: result.data?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };
  } catch (error) {
    console.warn("Knowledge source unavailable", error);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const claim = formData.get("claim")?.toString().trim() || "";
    const ocrText = formData.get("ocrText")?.toString() || "";
    const imageUploaded = formData.get("imageUploaded")?.toString() === "true";

    if (!claim) return NextResponse.json({ error: "Please provide a claim to analyze." }, { status: 400 });

    const [newsResult, factCheckResult, wiki] = await Promise.all([
      axios.get("https://newsapi.org/v2/everything", {
        params: { q: claim, language: "en", sortBy: "relevancy", pageSize: 10, apiKey: process.env.NEWS_API_KEY },
        timeout: 8000,
      }).catch((error) => ({ data: { articles: [] }, error })),
      axios.get("https://factchecktools.googleapis.com/v1alpha1/claims:search", {
        params: { query: claim, languageCode: "en", pageSize: 10, key: process.env.GOOGLE_FACT_CHECK_API_KEY },
        timeout: 8000,
      }).catch((error) => ({ data: { claims: [] }, error })),
      wikipediaEvidence(claim),
    ]);

    const articles = (newsResult.data?.articles || []).map((article: any) => ({
      title: article.title || "Untitled",
      description: article.description || null,
      url: article.url || "",
      source: article.source?.name || "Unknown",
      relevance: articleRelevance(claim, article.title || "", article.description || ""),
    }));
    const relevantArticles = articles.filter((article: any) => article.relevance >= 55);

    const claimWords = claim.toLowerCase().replace(/[^a-z0-9\\s]/g, " ").split(/\\s+/).filter((w: string) => w.length > 2);
    const factChecks = (factCheckResult.data?.claims || []).filter((item: any) => {
      const text = `${item.text || ""} ${item.claimReview?.[0]?.title || ""}`.toLowerCase();
      const sourceWords = new Set(text.replace(/[^a-z0-9\\s]/g, " ").split(/\\s+/));
      const matches = claimWords.filter((word: string) => sourceWords.has(word)).length;
      return claimWords.length <= 2 ? matches >= 1 : matches / claimWords.length >= 0.45;
    });

    const factCheckEvidence = factChecks.map((item: any) => ({
      claim: item.text || "",
      publisher: item.claimReview?.[0]?.publisher?.name || "Unknown",
      title: item.claimReview?.[0]?.title || "No title available",
      rating: item.claimReview?.[0]?.textualRating || "No rating available",
      url: item.claimReview?.[0]?.url || "",
    }));

    const factStats = evaluateFactChecks(factCheckEvidence);
    const authoritativeDomains = ["gov.in", "nic.in", "who.int", "un.org", "nasa.gov", "ecisveep.nic.in"];
    const authoritative = relevantArticles.some((article: any) => {
      try {
        const hostname = new URL(article.url).hostname;
        return authoritativeDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
      } catch { return false; }
    });

    const contradiction = wiki ? compositionContradiction(claim, wiki.extract) : false;
    const knowledgeSupported = Boolean(wiki && !contradiction && articleRelevance(claim, wiki.title, wiki.extract) >= 65);

    const result = finalVerdict({
      falseCount: factStats.falseCount,
      trueCount: factStats.trueCount,
      misleadingCount: factStats.misleadingCount,
      contradiction,
      authoritative,
      knowledgeSupported,
      relevantArticles: relevantArticles.length,
    });

    return NextResponse.json({
      success: true,
      verdict: result.verdict,
      confidence: result.confidence,
      explanation: result.explanation,
      imageContext: imageUploaded
        ? "This analysis was performed on a claim extracted from an uploaded image."
        : "This analysis was performed on text entered directly by the user.",
      articles,
      totalRatedFactChecks: factStats.rated,
      evidenceAgreement: factStats.agreement,
      factChecksFound: factChecks.length,
      factCheckEvidence,
      knowledgeEvidence: wiki ? { title: wiki.title, extract: wiki.extract, url: wiki.url, contradiction, supported: knowledgeSupported } : null,
      diagnostics: {
        newsApiAvailable: !newsResult.error,
        factCheckApiAvailable: !factCheckResult.error,
        knowledgeSourceAvailable: Boolean(wiki),
        relevantArticles: relevantArticles.length,
      },
    });
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to analyze the claim." }, { status: 500 });
  }
}
