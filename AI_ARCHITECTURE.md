# Market Edge AI architecture

## Request path

1. The existing GitHub Pages frontend scans Hyperliquid, Binance and Coinbase.
2. `quant-engine.js` produces the market regime, strategy candidate, levels, risk-sized plan and hard verdict.
3. The user may add zero to four chart screenshots and a question.
4. `ai-ui.js` compresses chart images to a maximum of 1,600 px and validates type, count and size.
5. The frontend sends only the sanitized quantitative snapshot, optional compressed screenshots and user question to the Cloudflare Worker.
6. The Worker validates origin, content type, request size, fields and images before calling the OpenAI Responses API.
7. GPT-5.6 Terra compares all supplied charts in one request and returns strict JSON-schema output.
8. `ai-engine.js` validates the structured response and fuses it with the quantitative verdict.
9. The quantitative verdict remains authoritative. AI can confirm a qualified direction or downgrade it to WAIT / NO TRADE; it cannot promote a quantitative WAIT / NO TRADE.

The deployment verdict remains **PAPER TRADE ONLY** until actual unseen statistical evidence changes it.

## Model selection

- New chart analysis: `gpt-5.6-terra`, low reasoning effort. It accepts image input and supports strict structured output while balancing quality and cost.
- Follow-up chat: `gpt-5.6-luna`, low reasoning effort. It receives the cached structured analysis instead of re-running vision, reducing repeat image cost.
- Both model IDs are server-side environment variables and can be changed without exposing credentials.

## Structured chart analysis

The Worker uses the Responses API with `text.format.type = json_schema`, `strict = true`, and a schema that requires:

- asset, bias, setup type and AI verdict;
- 5m / 15m / 1h / 4h / 1d summaries;
- observations labelled `OBSERVED` or `INFERRED`;
- conflicts, bull case, bear case, risk notes and uncertainties.

The prompt forbids invented prices, candle values, statistics, funding, exchange rules and probabilities. AI entry zones and targets may only copy supplied quantitative levels; otherwise they remain empty or `UNKNOWN / NOT AVAILABLE`.

## Fusion rules

| Quant result | AI result | Final result |
|---|---|---|
| missing / unavailable | any | NO TRADE |
| NO TRADE | any | NO TRADE |
| WAIT | any | WAIT |
| TAKE TRADE long | LONG | LONG (paper only) |
| TAKE TRADE short | SHORT | SHORT (paper only) |
| TAKE TRADE | WAIT | WAIT |
| TAKE TRADE | opposite direction | WAIT |
| TAKE TRADE | malformed / unavailable | WAIT |

## Security and privacy

- `OPENAI_API_KEY` exists only as a Cloudflare Worker secret.
- No exchange keys, wallet keys, passwords or seed phrases are requested.
- Requests are accepted only from configured origins.
- Request bodies are capped at 8.5 MB; at most four supported images and 6 MB of decoded image data are accepted.
- A best-effort per-isolate rate limit defaults to 12 requests per minute per source address. A durable Cloudflare Rate Limiting rule is recommended for high-traffic production use.
- Upstream calls time out and return generic JSON errors without stack traces or secrets.
- OpenAI requests use `store: false` and a hashed, privacy-preserving safety identifier.
- Market Edge does not permanently store screenshots. The frontend holds compressed images in memory until removed or the page closes; the Worker forwards them in memory and does not persist them.
- Paper portfolio data stays in browser local storage on that device.

## Cost controls

- Images are downscaled and compressed before upload.
- Multiple charts are compared in one vision request.
- Follow-up chat reuses the existing structured chart analysis rather than resending images.
- Chat history is limited to the latest six turns.
- Output schemas and output-token limits prevent uncontrolled responses.
- Errors are returned once; the frontend does not retry indefinitely.

## Limitations

- AI chart interpretation is not statistically calibrated and is not a probability.
- Screenshot quality, overlays and cropped context can hide relevant evidence.
- The Worker’s in-memory rate limiter is best effort across isolates.
- Paper positions are device-local and do not synchronize between browsers.
- The AI layer cannot repair weak quantitative evidence or make the system live-ready.
