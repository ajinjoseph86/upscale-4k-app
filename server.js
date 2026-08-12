require('dotenv').config();

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FAL_KEY = process.env.FAL_KEY;
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '10.00');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const UPSCALE_PRICE_USD = parseFloat(process.env.UPSCALE_PRICE_USD || '3.00');
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// GPT Image 2 edit, high quality, up to 4K output.
// See https://fal.ai/models/fal-ai/gpt-image-2/edit
// Conservative worst-case estimate used for the daily budget guard.
const FAL_MODEL = 'openai/gpt-image-2/edit';
const ESTIMATED_UPSCALE_COST_USD = 0.9;
const MAX_DIMENSION = 4096;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SPEND_FILE = path.join(DATA_DIR, 'spend.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PAID_FILE = path.join(DATA_DIR, 'paid.json');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, 'public', 'generated');

for (const dir of [DATA_DIR, GENERATED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json());

// ---------- per-visitor client id (so each browser only sees its own uploads) ----------

const CLIENT_COOKIE = 'upscale_client_id';

function getClientId(req, res) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
  if (match) return match[1];

  const id = uuidv4();
  res.setHeader(
    'Set-Cookie',
    `${CLIENT_COOKIE}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax`
  );
  return id;
}

app.use((req, res, next) => {
  req.clientId = getClientId(req, res);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated', express.static(GENERATED_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

// ---------- date / budget helpers (Asia/Singapore) ----------

function todayKeySGT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function getTodaySpend() {
  const spend = await readJson(SPEND_FILE, {});
  return spend[todayKeySGT()] || 0;
}

async function addSpend(amount) {
  const spend = await readJson(SPEND_FILE, {});
  const key = todayKeySGT();
  spend[key] = (spend[key] || 0) + amount;
  await writeJson(SPEND_FILE, spend);
  return spend[key];
}

async function appendHistory(entry) {
  const history = await readJson(HISTORY_FILE, []);
  history.unshift(entry);
  await writeJson(HISTORY_FILE, history.slice(0, 200));
  return history;
}

// ---------- paid uploads ----------

async function isPaid(uploadId, clientId) {
  const paid = await readJson(PAID_FILE, []);
  return paid.some((p) => p.uploadId === uploadId && p.clientId === clientId);
}

async function markPaid({ uploadId, clientId, sessionId }) {
  const paid = await readJson(PAID_FILE, []);
  if (paid.some((p) => p.sessionId === sessionId)) return;
  paid.push({ uploadId, clientId, sessionId, paidAt: new Date().toISOString() });
  await writeJson(PAID_FILE, paid);
}

// ---------- fal.ai helpers ----------

async function falSubmit(input) {
  const res = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.detail ? JSON.stringify(body.detail) : `fal submit failed (${res.status})`);
  }
  return body;
}

async function falPollResult(statusUrl, responseUrl, { timeoutMs = 120000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const statusRes = await fetch(statusUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const status = await statusRes.json();
    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(responseUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
      if (!resultRes.ok) throw new Error(`fal result fetch failed (${resultRes.status})`);
      return resultRes.json();
    }
    if (status.status === 'ERROR' || status.status === 'FAILED') {
      throw new Error(`fal generation failed: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('fal generation timed out');
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download result image (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
}

async function fileToDataUri(filePath) {
  const buf = await fsp.readFile(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// ---------- routes ----------

app.get('/api/budget', async (req, res) => {
  const spent = await getTodaySpend();
  res.json({
    date: todayKeySGT(),
    dailyBudgetUsd: DAILY_BUDGET_USD,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, DAILY_BUDGET_USD - spent).toFixed(4)),
    upscalePriceUsd: UPSCALE_PRICE_USD,
  });
});

app.get('/api/history', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  res.json(history.filter((entry) => entry.clientId === req.clientId));
});

// ---------- upload (free — just stores the original, no fal cost) ----------

app.post('/api/upload', upload.single('photo'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Upload an image first.' });
  }

  try {
    const metadata = await sharp(file.buffer).metadata();
    const id = uuidv4();
    const destFile = `${id}-original.png`;
    await sharp(file.buffer).rotate().png().toFile(path.join(GENERATED_DIR, destFile));

    const entry = {
      id,
      clientId: req.clientId,
      createdAt: new Date().toISOString(),
      originalUrl: `/generated/${destFile}`,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
    };
    await appendHistory(entry);

    res.json({ success: true, id: entry.id, originalUrl: entry.originalUrl });
  } catch (err) {
    console.error('upload error:', err);
    res.status(500).json({ error: 'Could not process that image.' });
  }
});

// ---------- paywall ----------

app.post('/api/checkout', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Server is missing STRIPE_SECRET_KEY. Add it to .env and restart.' });
  }

  const { uploadId } = req.body;
  if (!uploadId) {
    return res.status(400).json({ error: 'uploadId is required.' });
  }

  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === uploadId && h.clientId === req.clientId);
  if (!entry) {
    return res.status(404).json({ error: 'Image not found for this session.' });
  }

  if (await isPaid(uploadId, req.clientId)) {
    return res.json({ alreadyPaid: true });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(UPSCALE_PRICE_USD * 100),
          product_data: { name: 'Upscale to 4K' },
        },
        quantity: 1,
      },
    ],
    metadata: { uploadId, clientId: req.clientId },
    success_url: `${origin}/?paid_upload=${uploadId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
  });

  res.json({ url: session.url });
});

app.get('/api/verify-payment', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Server is missing STRIPE_SECRET_KEY.' });
  }
  const { session_id: sessionId } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required.' });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') {
    return res.status(402).json({ paid: false });
  }
  if (session.metadata?.clientId !== req.clientId) {
    return res.status(403).json({ error: 'Session does not belong to this browser.' });
  }

  const { uploadId } = session.metadata;

  // Already upscaled for a repeat verify (e.g. page refresh)?
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === uploadId && h.clientId === req.clientId);
  if (!entry) {
    return res.status(404).json({ error: 'Original image not found.' });
  }
  if (entry.upscaledUrl) {
    await markPaid({ uploadId, clientId: req.clientId, sessionId });
    return res.json({ paid: true, uploadId, upscaledUrl: entry.upscaledUrl });
  }

  try {
    // ---- budget check BEFORE spending anything — the upscale only ever runs after payment ----
    const spentToday = await getTodaySpend();
    if (spentToday + ESTIMATED_UPSCALE_COST_USD > DAILY_BUDGET_USD) {
      return res.status(429).json({
        error: `Daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached, can't render this upscale right now. ` +
          `Your payment was still successful — contact support for a manual delivery.`,
      });
    }

    const scale = MAX_DIMENSION / Math.max(entry.originalWidth, entry.originalHeight);
    const targetWidth = Math.round(entry.originalWidth * scale);
    const targetHeight = Math.round(entry.originalHeight * scale);

    const sourceDataUri = await fileToDataUri(path.join(GENERATED_DIR, path.basename(entry.originalUrl)));

    const submitted = await falSubmit({
      prompt:
        'This is a resolution upscale request. Reproduce this exact image with no changes to content, ' +
        'composition, subject, colours, or style — only render it at the higher target resolution with ' +
        'crisp, enhanced detail and clarity.',
      image_urls: [sourceDataUri],
      num_images: 1,
      image_size: { width: targetWidth, height: targetHeight },
      quality: 'high',
      output_format: 'png',
    });

    const result = await falPollResult(submitted.status_url, submitted.response_url);
    const outputImage = result?.images?.[0];
    if (!outputImage?.url) {
      throw new Error('fal.ai response did not include an output image.');
    }

    const upscaledFile = `${uploadId}-4k.png`;
    await downloadToFile(outputImage.url, path.join(GENERATED_DIR, upscaledFile));
    await addSpend(ESTIMATED_UPSCALE_COST_USD);

    entry.upscaledUrl = `/generated/${upscaledFile}`;
    await writeJson(HISTORY_FILE, history);
    await markPaid({ uploadId, clientId: req.clientId, sessionId });

    res.json({ paid: true, uploadId, upscaledUrl: entry.upscaledUrl });
  } catch (err) {
    console.error('verify-payment upscale error:', err);
    res.status(500).json({
      error: 'Payment succeeded but the upscale failed. Contact support for a manual delivery.',
    });
  }
});

app.get('/api/download/:uploadId', async (req, res) => {
  const { uploadId } = req.params;
  if (!(await isPaid(uploadId, req.clientId))) {
    return res.status(402).json({ error: 'Payment required.' });
  }
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === uploadId && h.clientId === req.clientId);
  if (!entry?.upscaledUrl) {
    return res.status(404).json({ error: 'Upscaled image not found.' });
  }
  res.download(
    path.join(GENERATED_DIR, path.basename(entry.upscaledUrl)),
    `upscaled-4k-${uploadId.slice(0, 8)}.png`
  );
});

app.listen(PORT, () => {
  console.log(`Upscale to 4K app running at http://localhost:${PORT}`);
  if (!FAL_KEY) {
    console.warn('WARNING: FAL_KEY is not set. Copy .env.example to .env and add your fal.ai API key.');
  }
});
