"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { createWorker } from "tesseract.js";

type Source = { title: string; source: string; url: string; relevance: number; statement?: string };
type FactCheck = { claim: string; publisher: string; title: string; rating: string; url: string; relevance?: number };
type Article = { title: string; description: string | null; url: string; source: string; relevance: number };
type AnalysisData = {
  verdict: string;
  confidence: number;
  confidenceLabel: string;
  explanation: string;
  counterEvidence?: string;
  evidenceType?: string;
  imageContext: string;
  extractedTextAvailable: boolean;
  totalRatedFactChecks: number;
  evidenceAgreement: number;
  factChecksFound: number;
  authoritativeSources?: Source[];
  factCheckEvidence: FactCheck[];
  articles: Article[];
  evidenceStrength?: string;
};

const verdictStyles: Record<string, string> = {
  VERIFIED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FALSE: "border-red-200 bg-red-50 text-red-700",
  MISLEADING: "border-amber-200 bg-amber-50 text-amber-700",
  UNCERTAIN: "border-amber-200 bg-amber-50 text-amber-700",
  UNVERIFIED: "border-zinc-200 bg-zinc-100 text-zinc-700",
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

export default function Home() {
  const [claim, setClaim] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (image?.startsWith("blob:")) URL.revokeObjectURL(image);
  }, [image]);

  const reset = () => {
    if (image?.startsWith("blob:")) URL.revokeObjectURL(image);
    setClaim("");
    setOcrText("");
    setImage(null);
    setImageFile(null);
    setAnalysisData(null);
    setError("");
  };

  const handleImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (image?.startsWith("blob:")) URL.revokeObjectURL(image);
    setImage(URL.createObjectURL(file));
    setImageFile(file);
    setAnalysisData(null);
    setError("");
    setChecking(true);
    try {
      const worker = await createWorker("eng");
      const result = await worker.recognize(file);
      await worker.terminate();
      const text = result.data.text.replace(/\s+/g, " ").trim();
      setOcrText(text);
      setClaim(text.replace(/\b(FALSE|TRUE|MISLEADING|VERIFIED|FACT CHECK)\b/gi, "").replace(/\s+/g, " ").trim());
    } catch {
      setError("We could not read text from this image. You can still type the claim manually.");
    } finally {
      setChecking(false);
    }
  };

  const handleCheck = async () => {
    if (!claim.trim() && !ocrText.trim()) {
      setError("Enter a claim or upload an image first.");
      return;
    }
    setChecking(true);
    setError("");
    try {
      const form = new FormData();
      form.append("claim", claim.trim() || ocrText.trim());
      form.append("ocrText", ocrText);
      form.append("imageUploaded", String(Boolean(imageFile)));
      if (imageFile) form.append("image", imageFile);
      const response = await fetch("/api/analyze", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Analysis failed.");
      setAnalysisData(data);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to analyze this claim.");
    } finally {
      setChecking(false);
    }
  };

  const confidence = analysisData ? clamp(analysisData.confidence) : 0;

  return (
    <main className="min-h-screen bg-white text-zinc-950">
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-16">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.22em] text-zinc-500">CONTEXTLENS AI</p>
            <p className="mt-1 text-xs text-zinc-400">The trust layer for digital information</p>
          </div>
          {analysisData && <button onClick={reset} className="rounded-full border border-zinc-200 px-4 py-2 text-xs font-medium hover:bg-zinc-50">Check another claim</button>}
        </header>

        {!analysisData ? (
          <section className="mx-auto max-w-3xl py-20 text-center sm:py-28">
            <p className="text-xs font-semibold tracking-[0.2em] text-zinc-400">AI-POWERED CONTEXT ENGINE</p>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-6xl">Don&apos;t just read a claim.<br />Check its context.</h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-zinc-500 sm:text-lg">ContextLens AI retrieves fact-checks, authoritative sources, knowledge evidence and real-time coverage before you decide whether information is safe to trust or share.</p>

            <div className="mt-10 rounded-3xl border border-zinc-200 p-3 text-left shadow-sm">
              <textarea value={claim} onChange={(e) => setClaim(e.target.value)} placeholder="Paste a claim here…" rows={5} className="w-full resize-none rounded-2xl p-4 text-sm outline-none placeholder:text-zinc-400" />
              <div className="flex flex-col gap-3 border-t border-zinc-100 p-2 sm:flex-row sm:items-center sm:justify-between">
                <label className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium text-zinc-600 hover:bg-zinc-50">
                  {checking ? "Reading image…" : "Upload an image"}
                  <input type="file" accept="image/*" className="hidden" onChange={handleImage} />
                </label>
                <button onClick={handleCheck} disabled={checking} className="rounded-xl bg-black px-6 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50">{checking ? "Analyzing…" : "Check claim"}</button>
              </div>
            </div>

            {image && (
              <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200">
                <Image src={image} alt="Uploaded claim" width={1200} height={700} unoptimized className="max-h-72 w-full object-contain bg-zinc-50" />
              </div>
            )}
            {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

            <div className="mt-16 grid gap-3 text-left sm:grid-cols-3">
              <div className="rounded-2xl border border-zinc-200 p-5"><p className="text-sm font-semibold">Claim-level matching</p><p className="mt-2 text-xs leading-5 text-zinc-500">Evidence is matched to the actual proposition, not just shared keywords.</p></div>
              <div className="rounded-2xl border border-zinc-200 p-5"><p className="text-sm font-semibold">Source hierarchy</p><p className="mt-2 text-xs leading-5 text-zinc-500">Official sources and published fact-checks carry more weight than ordinary news.</p></div>
              <div className="rounded-2xl border border-zinc-200 p-5"><p className="text-sm font-semibold">Evidence first</p><p className="mt-2 text-xs leading-5 text-zinc-500">When evidence is insufficient, the system says so instead of inventing certainty.</p></div>
            </div>
          </section>
        ) : (
          <section className="mx-auto max-w-3xl py-10 sm:py-16">
            <p className="text-xs font-semibold tracking-[0.2em] text-zinc-400">ANALYZED CONTENT</p>
            <div className="mt-3 rounded-2xl bg-zinc-50 p-5 text-sm leading-6 text-zinc-700">{claim}</div>

            <div className="mt-6 rounded-3xl border border-zinc-200 p-6 sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold tracking-[0.18em] text-zinc-400">ANALYSIS RESULT</p>
                  <span className={`mt-3 inline-flex rounded-full border px-4 py-2 text-sm font-semibold ${verdictStyles[analysisData.verdict] || verdictStyles.UNVERIFIED}`}>{analysisData.verdict}</span>
                </div>
                <div className="text-right"><p className="text-xs text-zinc-400">Evidence confidence</p><p className="mt-1 text-4xl font-semibold tracking-tight">{confidence}%</p></div>
              </div>

              <h2 className="mt-8 text-2xl font-semibold tracking-tight">Context matters.</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-600">{analysisData.explanation}</p>

              {analysisData.counterEvidence && (
                <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
                  <p className="text-xs font-semibold tracking-[0.16em] text-zinc-400">WHAT THE EVIDENCE SAYS</p>
                  <p className="mt-2 text-sm font-medium leading-6 text-zinc-800">{analysisData.counterEvidence}</p>
                </div>
              )}

              <div className="mt-6">
                <div className="h-3 overflow-hidden rounded-full bg-zinc-100" role="progressbar" aria-label="Evidence confidence" aria-valuemin={0} aria-valuemax={100} aria-valuenow={confidence}>
                  <div className="h-full rounded-full bg-zinc-900 transition-[width] duration-700" style={{ width: `${confidence}%` }} />
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-zinc-400"><span>0</span><span>100</span></div>
                <p className="mt-3 text-xs leading-5 text-zinc-400">{analysisData.confidenceLabel}</p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-zinc-200 p-5">
              <p className="text-sm font-semibold">Evidence strength</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600">{analysisData.evidenceStrength || "Evidence strength depends on source quality, relevance and agreement."}</p>
            </div>

            {analysisData.authoritativeSources?.length ? (
              <div className="mt-7"><p className="text-sm font-semibold">Authoritative / knowledge sources</p><div className="mt-3 space-y-3">{analysisData.authoritativeSources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" className="block rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50"><p className="text-sm font-semibold">{source.title}</p><p className="mt-1 text-xs text-zinc-500">{source.source}</p>{source.statement && <p className="mt-2 text-xs leading-5 text-zinc-600">{source.statement}</p>}</a>)}</div></div>
            ) : null}

            {analysisData.factCheckEvidence.length > 0 && (
              <div className="mt-7"><p className="text-sm font-semibold">Fact-check evidence</p><div className="mt-3 space-y-3">{analysisData.factCheckEvidence.map((item, index) => <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noreferrer" className="block rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{item.publisher}</p><span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">{item.rating || "Not machine-rated"}</span></div><p className="mt-2 text-sm">{item.title}</p><p className="mt-2 text-xs leading-5 text-zinc-500">Checked claim: {item.claim}</p></a>)}</div></div>
            )}

            {analysisData.articles.length > 0 && <div className="mt-7"><p className="text-sm font-semibold">Sources found in real time</p><div className="mt-3 space-y-3">{analysisData.articles.map((article, index) => <a key={`${article.url}-${index}`} href={article.url} target="_blank" rel="noreferrer" className="block rounded-2xl border border-zinc-200 p-4 hover:bg-zinc-50"><p className="text-sm font-semibold">{article.title}</p><p className="mt-1 text-xs text-zinc-500">{article.source}</p></a>)}</div></div>}

            <div className="mt-8 rounded-2xl bg-black p-5 text-white"><p className="text-xs font-semibold tracking-[0.18em] text-zinc-400">READ BEFORE SHARING</p><p className="mt-2 text-sm leading-6 text-zinc-200">Take a moment to verify the evidence before sharing this information.</p></div>
            <button onClick={reset} className="mt-4 w-full rounded-xl border border-zinc-200 py-3.5 text-sm font-medium hover:bg-zinc-50">Check another claim</button>
          </section>
        )}

        <section className="border-t border-zinc-100 pt-12 sm:pt-16">
          <div className="grid gap-8 sm:grid-cols-[1fr_1.5fr]">
            <div><p className="text-xs font-semibold tracking-[0.18em] text-zinc-400">FUTURE VISION</p><h2 className="mt-3 text-2xl font-semibold tracking-tight">From a fact-checker to a digital trust layer.</h2></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-zinc-200 p-5"><p className="text-sm font-semibold">Multimodal verification</p><p className="mt-2 text-xs leading-5 text-zinc-500">Text, screenshots, images, audio and video with OCR, speech and media forensics.</p></div>
              <div className="rounded-2xl border border-zinc-200 p-5"><p className="text-sm font-semibold">Claim decomposition</p><p className="mt-2 text-xs leading-5 text-zinc-500">Break complex posts into atomic claims and verify each proposition independently.</p></div>
              <div className="rounded-2xl border border-zinc-200 p-5"><p className="text-sm font-semibold">Time-aware evidence</p><p className="mt-2 text-xs leading-5 text-zinc-500">Separate what is true now, what was true before, and what is still unknown.</p></div>
              <div className="rounded-2xl border border-zinc-200 p-5"><p className="text-sm font-semibold">Explainable evidence graph</p><p className="mt-2 text-xs leading-5 text-zinc-500">Show judges and users exactly which source supports or contradicts each claim.</p></div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
