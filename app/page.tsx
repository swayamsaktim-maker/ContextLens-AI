"use client";

import { useState } from "react";
import { createWorker } from "tesseract.js";

type Source = {
  title: string;
  description?: string | null;
  url: string;
  source?: string;
  relevance?: number;
};

type FactCheck = {
  claim: string;
  publisher: string;
  title: string;
  rating: string;
  url: string;
};

type KnowledgeEvidence = {
  title: string;
  extract: string;
  url: string;
  contradiction: boolean;
  supported: boolean;
};

type AnalysisData = {
  verdict: "VERIFIED" | "FALSE" | "MISLEADING" | "UNCERTAIN" | "UNVERIFIED";
  confidence: number;
  explanation: string;
  imageContext: string;
  totalRatedFactChecks: number;
  evidenceAgreement: number;
  factChecksFound: number;
  factCheckEvidence: FactCheck[];
  articles: Source[];
  knowledgeEvidence: KnowledgeEvidence | null;
  diagnostics?: {
    newsApiAvailable: boolean;
    factCheckApiAvailable: boolean;
    knowledgeSourceAvailable: boolean;
    relevantArticles: number;
  };
};

const verdictStyles: Record<AnalysisData["verdict"], string> = {
  VERIFIED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FALSE: "bg-red-50 text-red-700 border-red-200",
  MISLEADING: "bg-amber-50 text-amber-700 border-amber-200",
  UNCERTAIN: "bg-violet-50 text-violet-700 border-violet-200",
  UNVERIFIED: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

function verdictDescription(verdict: AnalysisData["verdict"]) {
  switch (verdict) {
    case "VERIFIED": return "The available evidence directly supports this claim.";
    case "FALSE": return "The available evidence contradicts this claim.";
    case "MISLEADING": return "The claim is missing context or is only partly accurate.";
    case "UNCERTAIN": return "Relevant information exists, but the evidence is not strong enough for a firm conclusion.";
    default: return "No sufficiently strong evidence was found. Absence of evidence is not proof that the claim is true.";
  }
}

export default function Home() {
  const [claim, setClaim] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(false);
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setResult(false);
    setClaim("");
    setOcrText("");
    setImage(null);
    setImageFile(null);
    setAnalysisData(null);
    setError(null);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setImage(URL.createObjectURL(file));
    setImageFile(file);
    setChecking(true);

    try {
      const worker = await createWorker("eng");
      const { data: { text } } = await worker.recognize(file);
      await worker.terminate();

      const cleaned = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      setOcrText(cleaned);

      const extracted = cleaned
        .replace(/\b(FALSE|TRUE|MISLEADING|VERIFIED|FACT CHECK)\b/gi, " ")
        .replace(/\b(?:IIE|[0-9]+)\b/gi, " ")
        .replace(/[|[\]{}<>]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const sentences = extracted.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 10);
      const likelyClaim = sentences
        .filter((sentence) => /\b(cause|causes|cure|cures|prevent|prevents|increase|increases|decrease|decreases|is|are|can|will|does|do|has|have|according|study|research|made|contains)\b/i.test(sentence))
        .sort((a, b) => b.length - a.length)[0] || sentences[0] || extracted;

      setClaim(likelyClaim);
    } catch (err) {
      console.error(err);
      setError("The image could not be read. You can type the claim manually.");
    } finally {
      setChecking(false);
    }
  };

  const handleCheck = async () => {
    if (!claim.trim()) {
      setError("Please enter a claim first.");
      return;
    }

    setChecking(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("claim", claim.trim());
      formData.append("ocrText", ocrText);
      formData.append("imageUploaded", imageFile ? "true" : "false");
      if (imageFile) formData.append("image", imageFile);

      const response = await fetch("/api/analyze", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Analysis failed");

      setAnalysisData(data);
      setResult(true);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Unable to analyze this claim.");
    } finally {
      setChecking(false);
    }
  };

  if (result && analysisData) {
    return (
      <main className="min-h-screen bg-white text-zinc-900 px-5 py-10 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold tracking-[0.18em] text-zinc-500">CONTEXTLENS AI</p>
            <button onClick={reset} className="text-sm text-zinc-500 hover:text-zinc-900">New check</button>
          </div>

          <section className="mt-8 overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-100 p-6 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Analyzed content</p>
              {image ? (
                <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50">
                  <img src={image} alt="Analyzed claim" className="max-h-72 w-full object-contain" />
                </div>
              ) : (
                <div className="mt-4 rounded-2xl bg-zinc-50 p-5 text-base leading-7 text-zinc-800">{claim}</div>
              )}
            </div>

            <div className="p-6 sm:p-8">
              <div className="flex flex-wrap items-center gap-3">
                <span className={`rounded-full border px-3 py-1 text-xs font-bold tracking-wide ${verdictStyles[analysisData.verdict]}`}>
                  {analysisData.verdict}
                </span>
                <span className="text-sm text-zinc-500">Evidence confidence: {analysisData.confidence}%</span>
              </div>

              <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Context matters.</h1>
              <p className="mt-3 text-zinc-600">{verdictDescription(analysisData.verdict)}</p>

              <div className="mt-7 rounded-2xl border border-zinc-200 p-5">
                <p className="text-sm font-semibold">Why this result?</p>
                <p className="mt-2 text-sm leading-6 text-zinc-600">{analysisData.explanation}</p>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl bg-zinc-50 p-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Evidence confidence</p>
                  <p className="mt-2 text-3xl font-semibold">{analysisData.confidence}%</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">This measures evidence strength, not the mathematical probability that the claim is true.</p>
                </div>
                <div className="rounded-2xl bg-zinc-50 p-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Evidence agreement</p>
                  <p className="mt-2 text-3xl font-semibold">{Math.round(analysisData.evidenceAgreement * 100)}%</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">Agreement among rated published fact-checks, when available.</p>
                </div>
              </div>

              {analysisData.knowledgeEvidence && (
                <div className="mt-6 rounded-2xl border border-zinc-200 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm font-semibold">Independent knowledge evidence</p>
                    <span className="text-xs text-zinc-400">{analysisData.knowledgeEvidence.contradiction ? "Contradicts claim" : analysisData.knowledgeEvidence.supported ? "Supports claim" : "Related source"}</span>
                  </div>
                  <p className="mt-3 text-sm font-medium">{analysisData.knowledgeEvidence.title}</p>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 line-clamp-5">{analysisData.knowledgeEvidence.extract}</p>
                  <a href={analysisData.knowledgeEvidence.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium underline underline-offset-4">Open source</a>
                </div>
              )}

              {analysisData.factCheckEvidence.length > 0 && (
                <div className="mt-7">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold">Published fact-checks</p>
                      <p className="mt-1 text-xs text-zinc-500">Only matching fact-check records are included in the decision.</p>
                    </div>
                    <span className="text-xs text-zinc-400">{analysisData.factChecksFound} found</span>
                  </div>
                  <div className="mt-3 space-y-3">
                    {analysisData.factCheckEvidence.map((item, index) => (
                      <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noopener noreferrer" className="block rounded-2xl border border-zinc-200 p-5 transition hover:bg-zinc-50">
                        <div className="flex items-start justify-between gap-4">
                          <p className="text-sm font-semibold">{item.publisher}</p>
                          <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-semibold">{item.rating}</span>
                        </div>
                        <p className="mt-2 text-sm text-zinc-700">{item.title}</p>
                        <p className="mt-3 text-xs text-zinc-400">Read original fact-check →</p>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {analysisData.articles.length > 0 && (
                <div className="mt-7">
                  <p className="text-sm font-semibold">Real-time sources</p>
                  <p className="mt-1 text-xs text-zinc-500">These sources help discover context; articles alone are not treated as proof.</p>
                  <div className="mt-3 space-y-3">
                    {analysisData.articles.slice(0, 8).map((article, index) => (
                      <a key={`${article.url}-${index}`} href={article.url} target="_blank" rel="noopener noreferrer" className="block rounded-2xl border border-zinc-200 p-4 transition hover:bg-zinc-50">
                        <div className="flex items-start justify-between gap-4">
                          <p className="text-sm font-semibold">{article.title}</p>
                          {typeof article.relevance === "number" && <span className="shrink-0 text-xs text-zinc-400">{article.relevance}% match</span>}
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">{article.source}</p>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {image && (
                <div className="mt-7 rounded-2xl border border-zinc-200 p-5">
                  <p className="text-sm font-semibold">Image context</p>
                  <p className="mt-2 text-sm leading-6 text-zinc-600">{analysisData.imageContext}</p>
                  {ocrText && <p className="mt-3 border-t border-zinc-100 pt-3 text-xs leading-5 text-zinc-400">OCR extracted: {ocrText}</p>}
                </div>
              )}

              <div className="mt-8 rounded-2xl bg-black p-5 text-white">
                <p className="text-sm font-bold tracking-[0.12em]">READ BEFORE SHARING</p>
                <p className="mt-2 text-sm leading-6 text-zinc-300">ContextLens AI provides evidence-based context. For high-stakes decisions, open the original sources and verify them yourself.</p>
              </div>

              {analysisData.diagnostics && (
                <details className="mt-5 rounded-2xl border border-zinc-200 p-4 text-xs text-zinc-500">
                  <summary className="cursor-pointer font-medium">Analysis diagnostics</summary>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <span>News source: {analysisData.diagnostics.newsApiAvailable ? "available" : "unavailable"}</span>
                    <span>Fact-check API: {analysisData.diagnostics.factCheckApiAvailable ? "available" : "unavailable"}</span>
                    <span>Knowledge source: {analysisData.diagnostics.knowledgeSourceAvailable ? "available" : "unavailable"}</span>
                    <span>Relevant articles: {analysisData.diagnostics.relevantArticles}</span>
                  </div>
                </details>
              )}

              <button onClick={reset} className="mt-6 w-full rounded-xl border border-zinc-200 py-3.5 text-sm font-semibold transition hover:bg-zinc-50">Check Another Claim</button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white text-zinc-900 px-5 py-12 sm:px-8">
      <div className="mx-auto flex min-h-[80vh] w-full max-w-2xl flex-col justify-center text-center">
        <p className="text-sm font-semibold tracking-[0.18em] text-zinc-500">CONTEXTLENS AI</p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-6xl">Understand before you share.</h1>
        <p className="mx-auto mt-5 max-w-xl text-zinc-500">Check the evidence and context behind a claim before passing it on.</p>

        <div className="mt-10 text-left">
          <textarea value={claim} onChange={(e) => setClaim(e.target.value)} placeholder="Paste a claim you want to check..." className="h-40 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-base outline-none transition focus:border-zinc-400" />

          <div className="mt-3 flex items-center justify-between">
            <label className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-900">
              Add screenshot / image
              <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            </label>
            {image && <button onClick={() => { setImage(null); setImageFile(null); setOcrText(""); }} className="text-xs text-zinc-400 hover:text-zinc-900">Remove image</button>}
          </div>

          {image && <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50"><img src={image} alt="Uploaded claim" className="max-h-72 w-full object-contain" /></div>}

          {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

          <button onClick={handleCheck} disabled={checking || !claim.trim()} className="mt-5 w-full rounded-xl bg-black py-3.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300">
            {checking ? "Analyzing evidence..." : "Check Claim"}
          </button>
        </div>

        <p className="mt-6 text-xs text-zinc-400">Text claims and social-media screenshots supported.</p>
      </div>
    </main>
  );
}
