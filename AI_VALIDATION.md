# AI validation and failure handling

## Automated coverage

`ai-engine.test.js` covers:

- valid and malformed AI JSON;
- unsupported and oversized images;
- zero-image and multiple-image validation;
- missing quantitative results;
- AI/quant disagreement;
- WAIT and NO TRADE gates;
- final paper LONG and SHORT;
- 5.70 USDC tiny-balance rejection;
- paper mark-to-market and closure;
- immutable original signal data;
- contextual explanation and sample-size gating.

`backend/worker.test.mjs` uses mocked OpenAI responses and covers:

- backend health;
- text-only analysis;
- multiple image inputs;
- unsupported and oversized image rejection;
- upstream API unavailability;
- malformed structured output;
- timeout handling;
- lower-cost chat model routing;
- denied origins and unsupported content types.

`quant-engine.test.js` continues to validate the unchanged quantitative engine.

No automated test calls a paid OpenAI endpoint.

## Failure behavior

- Missing backend configuration: the interface shows setup required; the quantitative verdict is unchanged.
- Timeout or upstream failure: one clean error is shown; no automatic trade is created and no infinite retry occurs.
- Malformed model output: rejected before fusion; final result is WAIT when a qualified quant setup exists.
- Missing quant result: final result is NO TRADE.
- AI/quant direction conflict: final result is WAIT.
- Unsupported or oversized upload: rejected locally and again by the Worker.
- Missing images: permitted as text-only analysis, with visual evidence marked unavailable.

## Live validation requirements

After the Worker secret is configured, production testing should cover:

- text-only analysis;
- one supported chart;
- multiple timeframe charts;
- follow-up chat;
- intentionally unsupported image;
- API failure and timeout behavior;
- mobile and desktop layouts;
- 5.70 USDC paper account;
- mocked fusion fixtures for WAIT, NO TRADE, LONG and SHORT;
- browser console with no uncaught errors.

Real LONG or SHORT results must never be fabricated merely to exercise the interface. Unit fixtures may test those deterministic branches, but production AI success should be reported only after the deployed Worker actually responds.

## Current limitation

Until the Cloudflare Worker is deployed with `OPENAI_API_KEY` and `ai-config.js` points to it, production AI calls correctly remain unavailable. The quantitative scanner, learning mode and local paper portfolio continue to work.
