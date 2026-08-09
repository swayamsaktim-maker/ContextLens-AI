"use client";

import { useState } from "react";
import { createWorker } from "tesseract.js";

type AnalysisData = {
  verdict: string;
  confidence: number;
  explanation: string;
  imageContext: string;

  totalRatedFactChecks: number;
  evidenceAgreement: number;

  factChecksFound: number;
  factCheckEvidence: {
    claim: string;
    publisher: string;
    title: string;
    rating: string;
    url: string;
  }[];


  articles: {
    title: string;
    description: string | null;
    url: string;
    source: string;
  }[];
};

export default function Home() {
  const [claim, setClaim] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(false);
  const [analysisData, setAnalysisData] =
  useState<AnalysisData | null>(null);

  const handleImageUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];

  if (file) {
    setImage(URL.createObjectURL(file));
    setImageFile(file);
    console.log("IMAGE FILE:", file.name, file.type, file.size);
    setChecking(true);
    const worker = await createWorker("eng");

    const {
      data: { text },
    } = await worker.recognize(file);

    await worker.terminate();

    console.log("Extracted text:", text);
    const cleanedText = text
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    console.log("Cleaned OCR text:", cleanedText);

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
      sentences
        .filter((sentence) =>
          /\b(cause|causes|cure|cures|prevent|prevents|increase|increases|decrease|decreases|is|are|can|will|does|do|has|have|according|study|research)\b/i.test(
            sentence
          )
        )
        .sort((a, b) => b.length - a.length)[0] ||
      sentences[0] ||
      extractedClaim;

    setClaim(likelyClaim);
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
      console.log("CLAIM SENT TO API:", claim);
      const formData = new FormData();

      formData.append("claim", claim);
      formData.append("ocrText", ocrText);
      formData.append("imageUploaded", imageFile ? "true" : "false");

      if (imageFile) {
        formData.append("image", imageFile);
      }

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      console.log("Real-time search result:", data);

      if (!response.ok) {
        throw new Error(data.error || "Analysis failed");
      }

      setAnalysisData(data);
      setResult(true);

    } catch (error) {
      console.error(error);
      alert("Unable to analyze this claim.");
    } finally {
      setChecking(false);
    }
  };

  if (result) {
    return (
      <main className="min-h-screen bg-white text-zinc-900 flex items-center justify-center px-6">
        <div className="w-full max-w-2xl">

          <p className="text-sm font-medium tracking-wide text-zinc-500">
            CONTEXTLENS AI
          </p>

          <div className="mt-8 rounded-3xl border border-zinc-200 p-8">
            <div className="mb-8">
              <p className="text-sm font-medium text-zinc-500">
                Analyzed content
              </p>

              {image ? (
                <div className="mt-3 overflow-hidden rounded-2xl border border-zinc-200">
                  <img
                    src={image}
                    alt="Analyzed claim"
                    className="max-h-64 w-full object-contain bg-zinc-50"
                  />
                </div>
              ) : (
                <div className="mt-3 rounded-2xl bg-zinc-50 p-5 text-left">
                  <p className="text-sm leading-6 text-zinc-700">
                    {claim}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500">
                Analysis result
              </span>

              <span className="rounded-full bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-700">
                {analysisData?.verdict || "UNKNOWN"}
              </span>
            </div>

            <h1 className="mt-6 text-3xl font-semibold">
              Context matters.
            </h1>

            <div className="mt-5 rounded-2xl bg-zinc-50 p-5">
              <p className="text-sm font-semibold text-zinc-900">
                Why this result?
              </p>

              <p className="mt-2 text-sm leading-6 text-zinc-600">
                {analysisData?.explanation ||
                  "The available evidence was analyzed to provide additional context for this claim."}
              </p>
            </div>

            {image && (
              <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-5">
                <div className="flex items-center gap-2">
                  <span className="text-base">🖼️</span>
                  <p className="text-sm font-semibold text-zinc-900">
                    Image Context
                  </p>
                </div>

                <p className="mt-2 text-sm leading-6 text-zinc-600">
                  {analysisData?.imageContext ||
                    "This claim was extracted from the uploaded image and analyzed against available fact-check evidence."}
                </p>

                <div className="mt-3 border-t border-zinc-100 pt-3">
                  <p className="text-xs text-zinc-400">
                    OCR text was extracted from this image before fact-check analysis.
                  </p>
                </div>
              </div>
            )}

            <p className="mt-4 text-zinc-600">
              {analysisData?.verdict?.toUpperCase() === "VERIFIED"
                ? "This claim is supported by multiple relevant sources and has been verified based on the available evidence."
                : analysisData?.verdict?.toUpperCase() === "LIKELY TRUE"
                ? "The available evidence strongly supports this claim."
                : analysisData?.verdict?.toUpperCase() === "UNCERTAIN"
                ? "More reliable evidence is needed before reaching a strong conclusion."
                : "There is not enough reliable evidence to verify this claim."}
            </p>

            <div className="mt-8 rounded-2xl bg-zinc-50 p-5">
              <p className="text-sm text-zinc-500">
                Confidence
              </p>

              <p className="mt-1 text-3xl font-semibold">
                {analysisData?.confidence ?? 0}%
              </p>
            </div>

            {analysisData && (
              <div className="mt-4 rounded-2xl border border-zinc-200 p-5">
                <p className="text-sm font-semibold text-zinc-900">
                  Evidence Strength
                </p>

                {analysisData.totalRatedFactChecks > 0 ? (
                  <p className="mt-2 text-sm leading-6 text-zinc-600">
                    Based on {analysisData.totalRatedFactChecks} rated fact-check
                    {analysisData.totalRatedFactChecks === 1 ? "" : "s"} with{" "}
                    {Math.round(analysisData.evidenceAgreement * 100)}% agreement.
                  </p>
                ) : (
                  <p className="mt-2 text-sm leading-6 text-zinc-600">
                    No published fact-check was found. The result is based on relevant
                    real-time sources instead.
                  </p>
                )}
              </div>
            )}
            {analysisData && analysisData.articles.length > 0 && (
              <div className="mt-6">
                <p className="text-sm font-medium">
                  Sources found in real time
                </p>

                <div className="mt-3 space-y-3">
                  {analysisData.articles.map((article: any, index: number) => (
                    <a
                      key={index}
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50"
                    >
                      <p className="text-sm font-semibold text-zinc-900">
                        {article.title}
                      </p>

                      <p className="mt-1 text-xs text-zinc-500">
                        {article.source}
                      </p>
                    </a>
                  ))}
                </div>
              </div>
            )}


            <div className="mt-6">
              <p className="text-sm font-medium">
                Trusted sources
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full border border-zinc-200 px-3 py-2 text-sm">
                  WHO
                </span>

                <span className="rounded-full border border-zinc-200 px-3 py-2 text-sm">
                  PubMed
                </span>

                <span className="rounded-full border border-zinc-200 px-3 py-2 text-sm">
                  Nature
                </span>
              </div>
            </div>

            {analysisData && analysisData.factCheckEvidence.length > 0 && (
              <div className="mt-8">
                <p className="text-sm font-semibold text-zinc-900">
                  Fact-check evidence
                </p>

                <p className="mt-1 text-sm text-zinc-500">
                  Published fact-checks related to this claim.
                </p>

                <div className="mt-4 space-y-3">
                  {analysisData.factCheckEvidence.map((factCheck, index) => (
                    <a
                      key={index}
                      href={factCheck.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-2xl border border-zinc-200 p-5 hover:bg-zinc-50"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm font-semibold text-zinc-900">
                          {factCheck.publisher}
                        </p>

                        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700">
                          {factCheck.rating}
                        </span>
                      </div>

                      <p className="mt-3 text-sm font-medium text-zinc-800">
                        {factCheck.title}
                      </p>

                      <p className="mt-3 text-xs text-zinc-500">
                        Click to read the original fact-check
                      </p>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-8 rounded-2xl bg-black p-5 text-white">
              <p className="text-sm font-semibold tracking-wide">
                READ BEFORE SHARING
              </p>

              <p className="mt-2 text-sm text-zinc-300">
                Take a moment to verify the evidence before sharing this
                information.
              </p>
            </div>

            <button
              onClick={() => {
                setResult(false);
                setClaim("");
                setImage(null);
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

        <p className="text-sm font-medium tracking-wide text-zinc-500 mb-4">
          CONTEXTLENS AI
        </p>

        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">
          Understand before you share.
        </h1>

        <p className="mt-4 text-zinc-500">
          Check the context behind a claim before passing it on.
        </p>

        <div className="mt-10">

          <textarea
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            placeholder="Paste a claim you want to check..."
            className="w-full h-36 resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-base outline-none transition focus:border-zinc-400"
          />

          <div className="mt-3 flex items-center justify-between">

            <label className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-900">
              📎 Add image

              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
            </label>

            {image && (
              <button
                onClick={() => setImage(null)}
                className="text-xs text-zinc-400 hover:text-zinc-900"
              >
                Remove image
              </button>
            )}

          </div>

          {image && (
            <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200">
              <img
                src={image}
                alt="Uploaded claim"
                className="max-h-72 w-full object-contain bg-zinc-50"
              />
            </div>
          )}

          <button
            onClick={handleCheck}
            disabled={!claim.trim() && !image}
            className="mt-5 w-full rounded-xl bg-black py-3.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {checking ? "Analyzing..." : "Check Claim"}
          </button>

        </div>

        <p className="mt-6 text-xs text-zinc-400">
          Check text claims or screenshots from social media.
        </p>

      </div>
    </main>
  );
}