// YOGESH API v1.0 — server-side link hunter
// Run: node yogesh-api.js
// Use: http://localhost:3000/bypass?url=https://short4cash.com/rPZM

const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const cheerio = require('cheerio');

chromium.use(stealth);

const app = express();
app.use(express.json());

// Ad/tracker domains blocklist
const JUNK = /google|gstatic|youtube|facebook|doubleclick|googlesyndication|cloudflare|cdnjs|jsdelivr|recaptcha|hcaptcha|twitter|x\.com|instagram|telegram|schema\.org|w3\.org|adservice|taboola|outbrain|adsterra|propellerads|popads|onclickads|mgid|revcontent|zabpress|monetag/i;

const SHORTENERS = [
  /short4cash\.com/i, /alpha-links\.in/i, /get2short\.com/i,
  /short(?:ly|e\.st|ner|link|ur[ls]|4|4fly|4-link)\./i, /adf\.ly/i,
  /ouo\./i, /shrink(?:me|earn)\./i, /exe\.io/i, /exey\.app/i,
  /droplink\.co/i, /gplinks?\./i, /lootlinks/i, /tnlink/i,
  /linkvertise/i, /zagl|cutpaid|zagred|za\.gl/i, /yuumari/i
];

function isJunk(u) {
  try { return JUNK.test(new URL(u).hostname); } catch { return true; }
}
function isShortener(u) {
  try { return SHORTENERS.some(r => r.test(new URL(u).hostname)); } catch { return false; }
}

// ---- URL extractor from any text/HTML ----
function extractUrls(text, baseUrl) {
  const found = new Set();
  const patterns = [
    /https?:\/\/[^\s"'<>\)\]\\]+/g,
    /(?:"|')(https?:\/\/[^"'\s]+)(?:"|')/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      let u = m[1];
      try {
        u = decodeURIComponent(u.replace(/\\u002F/gi, '/'));
      } catch {}
      if (!isJunk(u)) found.add(u);
    }
  }
  // Base64-encoded destinations
  const b64re = /(?:atob\(["']|base64[,:]\s*["'])([A-Za-z0-9+/=]{20,})["']?/g;
  let b;
  while ((b = b64re.exec(text)) !== null) {
    try {
      const dec = Buffer.from(b[1], 'base64').toString('utf8');
      if (/^https?:\/\//.test(dec) && !isJunk(dec)) found.add(dec);
    } catch {}
  }
  // meta refresh / location.href patterns
  const redir = /(?:location\.(?:href|replace)|window\.open|http-equiv="refresh"[^>]*url=)\s*=?\s*["']([^"']+)["']/gi;
  let r;
  while ((r = redir.exec(text)) !== null) {
    try {
      const u = new URL(r[1], baseUrl).href;
      if (!isJunk(u)) found.add(u);
    } catch {}
  }
  return [...found];
}

// ---- Core resolver: redirect chain + interstitial scraping ----
async function resolveChain(startUrl, maxHops = 10) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    locale: 'en-US'
  });
  const page = await ctx.newPage();
  const captured = new Set();
  let currentUrl = startUrl;

  // Network sniffing — sab requests/response dekho
  page.on('response', async resp => {
    try {
      const url = resp.url();
      if (isJunk(url)) return;
      const ct = (resp.headers()['content-type'] || '');
      if (!ct.includes('json') && !ct.includes('html') && !ct.includes('text')) return;
      const body = (await resp.text().catch(() => '')).slice(0, 300000);
      extractUrls(body, url).forEach(u => captured.add(u));
    } catch {}
  });
  page.on('request', req => {
    const u = req.url();
    if (!isJunk(u)) captured.add(u);
  });

  let finalUrl = null;
  for (let hop = 0; hop < maxHops; hop++) {
    try {
      const resp = await page.goto(currentUrl, {
        waitUntil: 'domcontentloaded', timeout: 25000, referer: hop ? currentUrl : undefined
      });
      if (resp && [301, 302, 303, 307, 308].includes(resp.status())) {
        const loc = resp.headers()['location'];
        if (loc) { currentUrl = new URL(loc, currentUrl).href; continue; }
      }
    } catch (e) {
      // timeout par bhi jo URL tha wahi last-known treat karo
    }

    await page.waitForTimeout(3000);

    // Auto-click skip/continue/get-link
    const clicked = await page.evaluate(() => {
      const re = /(continue|get\s*link|skip|proceed|verify|unlock|next|generate|submit|tap\s*here|click\s*here|go\s*to)/i;
      for (const el of document.querySelectorAll('a,button,input[type=submit],div[role=button],.btn')) {
        const t = ((el.textContent || '') + ' ' + (el.value || '') + ' ' + (el.id || '')).trim();
        if (re.test(t) && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed')) {
          try { el.scrollIntoView({block:'center'}); el.click(); return t.slice(0,40); } catch {}
        }
      }
      return null;
    });
    if (clicked) await page.waitForTimeout(2500);

    // HTML me hidden URL dhundo
    const html = await page.content().catch(() => '');
    extractUrls(html, currentUrl).forEach(u => captured.add(u));

    // Ab current URL — shortener hai ya destination?
    if (!isShortener(currentUrl)) {
      finalUrl = currentUrl;
      break;
    }
    // Captcha present?
    const hasCaptcha = await page.$('iframe[src*="recaptcha"], .g-recaptcha, .h-captcha').catch(() => null);
    if (hasCaptcha) { finalUrl = null; break; }
  }

  await browser.close();
  return { finalUrl, captured: [...captured] };
}

// ---- API endpoints ----
app.get('/bypass', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'url required' });
  try {
    const { finalUrl, captured } = await resolveChain(target);
    const nonShortener = captured.filter(u => !isShortener(u) && /^https?:\/\//.test(u));
    res.json({
      success: !!finalUrl,
      destination: finalUrl || nonShortener[0] || null,
      all_candidates: [...new Set([finalUrl, ...nonShortener].filter(Boolean))],
      note: finalUrl ? 'resolved' : (nonShortener.length ? 'partial' : 'captcha-or-blocked')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch mode — teeno links ek saath
app.post('/bypass/batch', async (req, res) => {
  const urls = req.body.urls || [];
  const results = [];
  for (const u of urls) {
    try {
      const r = await resolveChain(u);
      results.push({ url: u, ...r });
    } catch (e) {
      results.push({ url: u, error: e.message });
    }
  }
  res.json(results);
});

app.listen(3000, () => console.log('🚀 YOGESH API running: http://localhost:3000/bypass?url=...'));
                    
