"use client";

import Image from "next/image";
import { useState } from "react";
import { createWorker } from "tesseract.js";

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
  authoritativeSources?: {
    title: string;
    source: string;
    url: string;
    relevance: number;
  }[];
  factCheckEvidence: {
    claim: string;
    publisher: string;
    title: string;
    rating: string;
    url: string;
    relevance?: number;
  }[];
  articles: {
    title: string;
    description: string | null;
    url: string;
    source: string;
    relevance: number;
  }[];
};

export default function Home() {
  const [claim, setClaim] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(false);
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);

  const clearImage = () => {
    setImage(null);
    setImageFile(null);
    setOcrText("");
  };

  const handleImageUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImage(URL.createObjectURL(file));
    setImageFile(file);
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
    try {
      const formData = new FormData();
      formData.append("claim", claim);
      formData.append("ocrText", ocrText);
      formData.append("imageUploaded", imageFile ? "true" : "false");
      if (imageFile) formData.append("image", imageFile);

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Analysis failed");

      setAnalysisData(data);
      setResult(true);
    } catch (error) {
      console.error("Analysis error:", error);
      alert(error instanceof Error ? error.message : "Unable to analyze this claim.");
    } finally {
      setChecking(false);
    }
  };

  if (result && analysisData) {
    return (
      <main className="min-h-screen bg-white text-zinc-900 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-2xl">
          <p className="text-sm font-medium tracking-wide text-zinc-500">CONTEXTLENS AI</p>

          <div className="mt-8 rounded-3xl border border-zinc-200 p-8">
            <div className="mb-8">
              <p className="text-sm font-medium text-zinc-500">Analyzed content</p>
              {image ? (
                <div className="mt-3 overflow-hidden rounded-2xl border border-zinc-200">
                  <Image
                    src={image}
                    alt="Analyzed claim"
                    width={800}
                    height={500}
                    unoptimized
                    className="max-h-64 w-full object-contain bg-zinc-50"
                  />
                </div>
              ) : (
                <div className="mt-3 rounded-2xl bg-zinc-50 p-5 text-left">
                  <p className="text-sm leading-6 text-zinc-700">{claim}</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-zinc-500">Analysis result</span>
              <span className="rounded-full bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-700">
                {analysisData.verdict}
              </span>
            </div>

            <h1 className="mt-6 text-3xl font-semibold">Context matters.</h1>

            <div className="mt-5 rounded-2xl bg-zinc-50 p-5">
              <p className="text-sm font-semibold text-zinc-900">Why this result?</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600">{analysisData.explanation}</p>
            </div>

            {image && (
              <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-5">
                <div className="flex items-center gap-2">
                  <span className="text-base">🖼️</span>
                  <p className="text-sm font-semibold text-zinc-900">Image Context</p>
                </div>
                <p className="mt-2 text-sm leading-6 text-zinc-600">{analysisData.imageContext}</p>
                <div className="mt-3 border-t border-zinc-100 pt-3">
                  <p className="text-xs text-zinc-400">OCR text was extracted from this image before fact-check analysis.</p>
                </div>
              </div>
            )}

            <div className="mt-8 rounded-2xl bg-zinc-50 p-5">
              <p className="text-sm text-zinc-500">Confidence</p>
              <p className="mt-1 text-3xl font-semibold">{analysisData.confidence}%</p>
              <div className="mt-2 text-xs leading-5 text-zinc-500">
                {analysisData.confidenceLabel}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-zinc-200 p-5">
              <p className="text-sm font-semibold text-zinc-900">Evidence Strength</p>
              {analysisData.totalRatedFactChecks > 0 ? (
                <p className="mt-2 text-sm leading-6 text-zinc-600">
                  Based on {analysisData.totalRatedFactChecks} rated fact-check{analysisData.totalRatedFactChecks === 1 ? "" : "s"} with {Math.round(analysisData.evidenceAgreement * 100)}% agreement.
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
                <p className="text-sm font-medium">Authoritative sources</p>
                <div className="mt-3 space-y-3">
                  {analysisData.authoritativeSources.map((source, index) => (
                    <a
                      key={`${source.url}-${index}`}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50"
                    >
                      <p className="text-sm font-semibold text-zinc-900">{source.title}</p>
                      <p className="mt-1 text-xs text-zinc-500">{source.source}</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {analysisData.articles.length > 0 && (
              <div className="mt-6">
                <p className="text-sm font-medium">Sources found in real time</p>
                <div className="mt-3 space-y-3">
                  {analysisData.articles.map((article, index) => (
                    <a
                      key={`${article.url}-${index}`}
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50"
                    >
                      <p className="text-sm font-semibold text-zinc-900">{article.title}</p>
                      <p className="mt-1 text-xs text-zinc-500">{article.source}</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6">
              <p className="text-sm font-medium">Evidence sources</p>
              {analysisData.factCheckEvidence.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {Array.from(new Set(analysisData.factCheckEvidence.map((item) => item.publisher).filter(Boolean))).map((publisher) => (
                    <span key={publisher} className="rounded-full border border-zinc-200 px-3 py-2 text-sm">
                      {publisher}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm leading-6 text-zinc-500">
                  No relevant published fact-check publisher was found for this claim. Related sources are not treated as proof of truth.
                </p>
              )}
            </div>

            {analysisData.factCheckEvidence.length > 0 && (
              <div className="mt-8">
                <p className="text-sm font-semibold text-zinc-900">Fact-check evidence</p>
                <p className="mt-1 text-sm text-zinc-500">Published fact-checks related to this claim.</p>
                <div className="mt-4 space-y-3">
                  {analysisData.factCheckEvidence.map((factCheck, index) => (
                    <a
                      key={`${factCheck.url}-${index}`}
                      href={factCheck.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-5 hover:bg-zinc-50"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm font-semibold text-zinc-900">{factCheck.publisher}</p>
                        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700">{factCheck.rating}</span>
                      </div>
                      <p className="mt-3 text-sm font-medium text-zinc-800">{factCheck.title}</p>
                      <p className="mt-3 text-xs text-zinc-500">Click to read the original fact-check</p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-8 rounded-2xl bg-black p-5 text-white">
              <p className="text-sm font-semibold tracking-wide">READ BEFORE SHARING</p>
              <p className="mt-2 text-sm text-zinc-300">Take a moment to verify the evidence before sharing this information.</p>
            </div>

            <button
              onClick={() => {
                setResult(false);
                setAnalysisData(null);
                setClaim("");
                clearImage();
              }}
              className="mt-6 w-full rounded-xl border border-zinc-200 py-3.5 text-sm font-medium hover:bg-zinc-50"
            >
              Check Another Claim
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white text-zinc-900 flex items-center justify-center px-6">
      <div className="w-full max-w-2xl text-center">
        <p className="mb-4 text-sm font-medium tracking-wide text-zinc-500">CONTEXTLENS AI</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Understand before you share.</h1>
        <p className="mt-4 text-zinc-500">Check the context behind a claim before passing it on.</p>

        <div className="mt-10">
          <textarea
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            placeholder="Paste a claim you want to check..."
            className="h-36 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-base outline-none transition focus:border-zinc-400"
          />

          <div className="mt-3 flex items-center justify-between">
            <label className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-900">
              📎 Add image
              <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            </label>
            {image && (
              <button onClick={clearImage} className="text-xs text-zinc-400 hover:text-zinc-900">
                Remove image
              </button>
            )}
          </div>

          {image && (
            <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200">
              <Image src={image} alt="Uploaded claim" width={800} height={500} unoptimized className="max-h-72 w-full object-contain bg-zinc-50" />
            </div>
          )}

          <button
            onClick={handleCheck}
            disabled={checking}
            className="mt-6 w-full rounded-xl bg-black py-4 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {checking ? "Analyzing..." : "Check Claim"}
          </button>
        </div>
      </div>
    </main>
  );
}
