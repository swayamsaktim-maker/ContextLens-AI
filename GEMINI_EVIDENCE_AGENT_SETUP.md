# ContextLens AI — Google Evidence Agent setup

ContextLens now uses a two-stage verification pipeline:

1. **Evidence Search Agent** — Gemini with Google Search grounding searches the live web and returns cited web sources.
2. **Verification Agent** — Gemini receives only the retrieved evidence plus Google Fact Check results and decides VERIFIED / FALSE / MISLEADING / UNVERIFIED.

## Required environment variable

Add this to the local `.env.local` used by the Next.js app:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.6-flash
```

Keep the key server-side. Do not prefix it with `NEXT_PUBLIC_`.

The existing `GOOGLE_FACT_CHECK_API_KEY` can remain configured. It is now an additional evidence source rather than the main verification engine.

## Google setup

Create a Gemini API key in Google AI Studio / the Google Gemini API project and make sure the Gemini API is enabled for that key. The key must be available to the Next.js server at runtime.

## Test order

After adding the key:

```powershell
npm run lint
npm run build
npm run dev
```

Then test:

- `The moon is made of cheese.`
- `The moon is made of chocolate.`
- `Narendra Modi is the Prime Minister of India.`
- `Trump is the President of India.`
- `Scientists confirmed that drinking lemon water cures cancer.`

The important behavior is that the system no longer requires a hard-coded fact-check entry for a claim. The search agent retrieves current evidence, and the verifier judges the exact claim from that evidence.

If Google Search grounding cannot retrieve evidence, ContextLens should say **UNVERIFIED** rather than inventing a verdict.
