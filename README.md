# Upscale to 4K

Upload any image and pay once to get a real 4K upscale. Unlike the other
apps in this project, there's no free preview generation — uploading is
free (just stores your original), and the actual fal.ai upscale render
only runs **after** payment succeeds, since it's the most expensive
operation in the whole project (~$0.90/image estimated).

## 1. Install

```bash
npm install
```

## 2. Add your keys

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `FAL_KEY` — from https://fal.ai/dashboard/keys
- `STRIPE_SECRET_KEY` — from https://dashboard.stripe.com/apikeys (test key while testing)

Never commit `.env` — it's already in `.gitignore`.

## 3. Run

```bash
npm start
```

Open http://localhost:3000 in your browser.

## How it works

1. Upload any image. This just resizes/saves it server-side — no fal.ai call yet.
2. Click **"Pay $5.00 to Upscale to 4K"** — Stripe Checkout opens.
3. On successful payment, the server computes 4K-scaled dimensions (longest
   side = 4096px, aspect ratio preserved), sends the original to fal.ai
   with an "exact reproduction, higher resolution" prompt, and saves the
   result.
4. The 4K download is served only to the paying visitor for that specific
   upload (checked via the per-visitor cookie + payment record).

## Cost control — daily budget cap

Same guardrail as the other apps: `data/spend.json` tracks cumulative spend
per day (Asia/Singapore time). Crucially, the budget check happens **after**
payment is confirmed but **before** the fal.ai call — if the daily cap would
be exceeded, the customer still gets a successful charge but sees a message
to contact support for manual delivery, rather than the server silently
overspending.

## Project structure

```
server.js            Express server + fal.ai + Stripe + budget/history logic
public/index.html     UI markup
public/style.css       Styling (shared dark theme with the other apps)
public/app.js           Frontend logic (upload, checkout, payment-return handling)
public/generated/       Saved originals + upscaled outputs (gitignored)
data/                    spend.json, history.json, paid.json (gitignored, runtime)
```

## Deployment

Same pattern as the other apps: push to GitHub, deploy as a Render Web
Service (Starter plan + persistent disk), set env vars, point a subdomain
(e.g. `upscale.multiversematrix.net`) at it via a CNAME record.
