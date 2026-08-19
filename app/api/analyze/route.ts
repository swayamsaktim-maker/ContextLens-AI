import { NextResponse } from "next/server";
import { analyzeClaimWithAgents } from "@/lib/evidence-agent";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const claim = String(form.get("claim") || "").replace(/\s+/g, " ").trim();
    const ocrText = String(form.get("ocrText") || "").trim();
    const imageUploaded = String(form.get("imageUploaded") || "") === "true";

    if (!claim) {
      return NextResponse.json({ error: "Please provide a claim to analyze." }, { status: 400 });
    }

    const result = await analyzeClaimWithAgents(claim);

    return NextResponse.json({
      ...result,
      imageContext: imageUploaded ? "Claim extracted from or checked alongside an uploaded image." : "",
      extractedTextAvailable: Boolean(ocrText),
    });
  } catch (error) {
    console.error("ContextLens analysis error:", error);
    const message = error instanceof Error ? error.message : "Unable to analyze the claim.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
