"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { createWorker } from "tesseract.js";

type Source = {
  title: string;
  source: string;
  url: string;
  relevance: number;
};

type FactCheck = {
  claim: string;
  publisher: string;
  title: string;
  rating: string;
  url: string;
  relevance?: number;
};

type Article = {
  title: string;
  description: string | null;
  url: string;
  source: string;
  relevance: number;
};

type AnalysisData = {
  verdict: string;
  confidence: number;
  confidenceLabel: string;
  explanation: string;
  evidenceType?: string;
  imageContext: string;
  extractedTextAvailable: boolean;
  totalRatedFactChecks: number;
  evidenceAgreement: number;
  factChecksFound: number;
  authoritativeSources?: Source[];
  factCheckEvidence: FactCheck[];
  articles: Article[];
};

const VERDICT_STYLES: Record<string, string> = {
  VERIFIED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FALSE: "bg-red-50 text-red-700 border-red-200",
  MISLEADING: "bg-amber-50 text-amber-700 border-amber-200",
  UNCERTAIN: "bg-amber-50 text-amber-700 border-amber-200",
  UNVERIFIED: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function verdictStyle(verdict: string): string {
  return VERDICT_STYLES[verdict] || VERDICT_STYLES.UNVERIFIED;
}

export default function Home() {
  const [claim, setClaim] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(false);
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);

  useEffect(() => {
    return () => {
      if (image?.startsWith("blob:")) URL.revokeObjectURL(image);
    };
  }, [image]);

  const clearImage = () => {
    if (image?.startsWith("blob:")) URL.revokeObjectURL(image);
    setImage(null);
    setImageFile(null);
    setOcrText("");
  };

  const resetAnalysis = () => {
    setResult(false);
    setAnalysisData(null);
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (image?.startsWith("blob:")) URL.revokeObjectURL(image);
    setImage(URL.createObjectURL(file));
    setImageFile(file);
    setResult(false);
    setAnalysisData(null);
    setChecking(true);

    try {
      const worker = await createWorker("eng");
      const {
        data: { text },
      } = await worker.recognize(file);
      await worker.terminate();

      const cleanedText = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      setOcrText(cleanedText);

      const extractedClaim = cleanedText
        .replace(/\b(FALSE|TRUE|MISLEADING|VERIFIED|FACT CHECK)\b/gi, " ")
        .replace(/\b(?:IIE|[0-9]+)\b/gi, " ")
        .replace(/^\s*(?:pI|PI|pl|P1)\s*[-:]\s*/i, "")
        .replace(/[|[\]{}<>]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const sentences = extractedClaim
        .split(/[.!?]+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 10);

      const likelyClaim =
        sentences.find((sentence) =>
          /\b(cause|causes|cure|cures|prevent|prevents|increase|increases|decrease|decreases|is|are|can|will|does|do|has|have|according|study|research)\b/i.test(
            sentence
          )
        ) || sentences[0] || extractedClaim;

      setClaim(likelyClaim);
    } catch (error) {
      console.error("OCR error:", error);
      alert("Unable to read the image. Please enter the claim manually.");
    } finally {
      setChecking(false);
    }
  };

  const handleCheck = async () => {
    if (!claim.trim()) {
      alert("Please enter a claim first.");
      return;
    }

    setChecking(true);
    setResult(false);

    try {
      const formData = new FormData();
      formData.append("claim", claim.trim());
      formData.append("ocrText", ocrText);
      formData.append("imageUploaded", imageFile ? "true" : "false");
      if (imageFile) formData.append("image", imageFile);

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Analysis failed");

      setAnalysisData({
        ...data,
        confidence: clampPercent(Number(data.confidence)),
      });
      setResult(true);
    } catch (error) {
      console.error("Analysis error:", error);
      alert(error instanceof Error ? error.message : "Unable to analyze this claim.");
    } finally {
      setChecking(false);
    }
  };

  if (result && analysisData) {
    const confidence = clampPercent(analysisData.confidence);
    const verdict = analysisData.verdict.toUpperCase();

    return (
      <main className="min-h-screen bg-white px-6 py-10 text-zinc-900">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-semibold tracking-[0.18em] text-zinc-500">CONTEXTLENS AI</p>
            <button
              type="button"
              onClick={resetAnalysis}
              className="text-sm text-zinc-500 transition hover:text-zinc-900"
            >
              Check another claim
            </button>
          </div>

          <section className="mt-8 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
            <div>
              <p className="text-sm font-medium text-zinc-500">Analyzed content</p>
              {image ? (
                <div className="relative mt-3 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50">
                  <Image
                    src={image}
                    alt="Analyzed claim"
                    width={1200}
                    height={700}
                    unoptimized
                    className="max-h-80 w-full object-contain"
                  />
                </div>
              ) : (
                <div className="mt-3 rounded-2xl bg-zinc-50 p-5">
                  <p className="text-sm leading-6 text-zinc-800">{claim}</p>
                </div>
              )}
            </div>

            <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 pb-5">
              <span className="text-sm text-zinc-500">Analysis result</span>
              <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${verdictStyle(verdict)}`}>
                {verdict}
              </span>
            </div>

            <h1 className="mt-7 text-3xl font-semibold tracking-tight">Context matters.</h1>

            <div className="mt-5 rounded-2xl bg-zinc-50 p-5">
              <p className="text-sm font-semibold text-zinc-900">Why this result?</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600">{analysisData.explanation}</p>
            </div>

            {image && (
              <div className="mt-5 rounded-2xl border border-zinc-200 p-5">
                <p className="text-sm font-semibold text-zinc-900">Image context</p>
                <p className="mt-2 text-sm leading-6 text-zinc-600">{analysisData.imageContext}</p>
                {analysisData.extractedTextAvailable && (
                  <div className="mt-3 border-t border-zinc-100 pt-3">
                    <p className="text-xs text-zinc-400">OCR text was extracted before fact-check analysis.</p>
                  </div>
                )}
              </div>
            )}

            <div className="mt-6 rounded-2xl border border-zinc-200 p-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-sm text-zinc-500">Confidence</p>
                  <p className="mt-1 text-4xl font-semibold tracking-tight">{confidence}%</p>
                </div>
                <p className="max-w-xs text-right text-xs leading-5 text-zinc-500">{analysisData.confidenceLabel}</p>
              </div>

              <div
                className="mt-5 h-3 overflow-hidden rounded-full bg-zinc-100"
                role="progressbar"
                aria-label="Evidence confidence"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={confidence}
              >
                <div
                  className="h-full rounded-full bg-zinc-900 transition-[width] duration-500"
                  style={{ width: `${confidence}%` }}
                />
              </div>

              <div className="mt-2 flex justify-between text-[11px] text-zinc-400">
                <span>0</span>
                <span>100</span>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-zinc-200 p-5">
              <p className="text-sm font-semibold text-zinc-900">Evidence strength</p>
              {analysisData.totalRatedFactChecks > 0 ? (
                <p className="mt-2 text-sm leading-6 text-zinc-600">
                  Based on {analysisData.totalRatedFactChecks} rated fact-check{analysisData.totalRatedFactChecks === 1 ? "" : "s"} with {Math.round(analysisData.evidenceAgreement * 100)}% agreement.
                </p>
              ) : analysisData.factChecksFound > 0 ? (
                <p className="mt-2 text-sm leading-6 text-zinc-600">
                  Relevant fact-check pages were found, but their machine-readable ratings could not be confirmed.
                </p>
              ) : analysisData.authoritativeSources?.length ? (
                <p className="mt-2 text-sm leading-6 text-zinc-600">
                  Supported by {analysisData.authoritativeSources.length} relevant authoritative source{analysisData.authoritativeSources.length === 1 ? "" : "s"}.
                </p>
              ) : (
                <p className="mt-2 text-sm leading-6 text-zinc-600">
                  No published fact-check was found. Related sources are not treated as proof of truth.
                </p>
              )}
            </div>

            {analysisData.authoritativeSources && analysisData.authoritativeSources.length > 0 && (
              <div className="mt-6">
                <p className="text-sm font-semibold text-zinc-900">Authoritative sources</p>
                <div className="mt-3 space-y-3">
                  {analysisData.authoritativeSources.map((source, index) => (
                    <a
                      key={`${source.url}-${index}`}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-4 transition hover:bg-zinc-50"
                    >
                      <p className="text-sm font-semibold text-zinc-900">{source.title}</p>
                      <p className="mt-1 text-xs text-zinc-500">{source.source}</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {analysisData.factCheckEvidence.length > 0 && (
              <div className="mt-7">
                <p className="text-sm font-semibold text-zinc-900">Fact-check evidence</p>
                <p className="mt-1 text-xs text-zinc-500">Published fact-checks related to this claim.</p>
                <div className="mt-3 space-y-3">
                  {analysisData.factCheckEvidence.map((factCheck, index) => (
                    <a
                      key={`${factCheck.url}-${index}`}
                      href={factCheck.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-4 transition hover:bg-zinc-50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-zinc-900">{factCheck.publisher}</p>
                        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600">
                          {factCheck.rating || "Not machine-rated"}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-zinc-800">{factCheck.title}</p>
                      <p className="mt-2 text-xs leading-5 text-zinc-500">Checked claim: {factCheck.claim}</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {analysisData.articles.length > 0 && (
              <div className="mt-7">
                <p className="text-sm font-semibold text-zinc-900">Sources found in real time</p>
                <div className="mt-3 space-y-3">
                  {analysisData.articles.map((article, index) => (
                    <a
                      key={`${article.url}-${index}`}
                      href={article.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-4 transition hover:bg-zinc-50"
                    >
                      <p className="text-sm font-semibold text-zinc-900">{article.title}</p>
                      <p className="mt-1 text-xs text-zinc-500">{article.source}</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-8 rounded-2xl bg-zinc-900 p-5 text-white">
              <p className="text-xs font-semibold tracking-[0.18em] text-zinc-400">READ BEFORE SHARING</p>
              <p className="mt-2 text-sm leading-6 text-zinc-200">Take a moment to verify the evidence before sharing this information.</p>
            </div>

            <button
              type="button"
              onClick={resetAnalysis}
              className="mt-5 w-full rounded-2xl border border-zinc-200 px-5 py-3 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
            >
              Check Another Claim
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white px-6 py-12 text-zinc-900">
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-sm font-semibold tracking-[0.18em] text-zinc-500">CONTEXTLENS AI</p>
        <h1 className="mt-8 text-4xl font-semibold tracking-tight sm:text-5xl">Verify before you share.</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600">
          ContextLens AI checks claims against published fact-checks, authoritative sources, and real-time coverage.
        </p>

        <section className="mt-10 rounded-3xl border border-zinc-200 p-6 shadow-sm sm:p-8">
          <label htmlFor="claim" className="text-sm font-semibold text-zinc-900">Claim to check</label>
          <textarea
            id="claim"
            value={claim}
            onChange={(event) => {
              setClaim(event.target.value);
              setResult(false);
              setAnalysisData(null);
            }}
            placeholder="Example: Scientists confirmed that drinking lemon water cures cancer."
            className="mt-3 min-h-40 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-sm leading-6 outline-none transition focus:border-zinc-400 focus:bg-white"
          />

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <label className="cursor-pointer rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50">
              Upload image
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
            </label>

            {image && (
              <button
                type="button"
                onClick={clearImage}
                className="text-sm text-zinc-500 transition hover:text-zinc-900"
              >
                Remove image
              </button>
            )}
          </div>

          {image && (
            <div className="relative mt-5 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50">
              <Image
                src={image}
                alt="Uploaded claim"
                width={1200}
                height={700}
                unoptimized
                className="max-h-96 w-full object-contain"
              />
            </div>
          )}

          <button
            type="button"
            onClick={handleCheck}
            disabled={checking || !claim.trim()}
            className="mt-6 w-full rounded-2xl bg-zinc-900 px-5 py-4 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? "Analyzing evidence..." : "Check Claim"}
          </button>

          {checking && (
            <p className="mt-3 text-center text-xs text-zinc-400">Retrieving and comparing evidence. This can take a few seconds.</p>
          )}
        </section>
      </div>
    </main>
  );
}
