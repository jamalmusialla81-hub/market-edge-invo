# AI backend setup

The frontend works as a quantitative scanner and paper portfolio without the AI backend. Do not put an OpenAI API key in any browser file or GitHub secret that is exposed to Pages.

## One-time Cloudflare Worker deployment

From the repository root (`outputs`):

1. Install the pinned deployment dependency:

   ```sh
   pnpm install
   ```

2. Sign in to the Cloudflare account that should own the Worker:

   ```sh
   pnpm exec wrangler login
   ```

3. Store the OpenAI key as an encrypted Worker secret. Paste it only when Wrangler prompts; it is never printed or committed:

   ```sh
   pnpm exec wrangler secret put OPENAI_API_KEY --config backend/wrangler.jsonc
   ```

4. Deploy the Worker:

   ```sh
   pnpm run deploy:ai
   ```

5. Copy the resulting `https://...workers.dev` origin into `ai-config.js` as `apiBase`, with no trailing slash. Do not put a key there.

6. Commit and push `ai-config.js` to `main`, then wait for GitHub Pages to update.

## Required server-side values

- Secret: `OPENAI_API_KEY`
- Public Worker variables already configured in `backend/wrangler.jsonc`:
  - `ALLOWED_ORIGINS=https://jamalmusialla81-hub.github.io`
  - `VISION_MODEL=gpt-5.6-terra`
  - `CHAT_MODEL=gpt-5.6-luna`
  - `RATE_LIMIT_PER_MINUTE=12`
  - `OPENAI_TIMEOUT_MS=25000`

## Verification

After deployment:

```sh
curl https://YOUR-WORKER.workers.dev/health
```

The response should contain `"ok":true` and `"configured":true`. Never paste the secret into a URL, source file, browser console, issue or chat message.
