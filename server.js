/**
 * Plugin Copilot — Scraper Server v6
 * Uses ScraperAPI to bypass 403 blocks on all sources.
 * ScraperAPI routes through residential IPs — no more blocking.
 *
 * Render deploy:
 *   Build command:  npm install
 *   Start command:  node server.js
 *
 * Set environment variable in Render dashboard:
 *   SCRAPER_API_KEY = your ScraperAPI key
 *
 * Sources:
 *   - Reddit r/AudioProductionDeals  (JSON API via ScraperAPI)
 *   - KVR Audio deals thread         (HTML via ScraperAPI)
 *   - VI-Control deals forum         (HTML via ScraperAPI)
 *   - AudioPluginGuy.com/deals       (HTML via ScraperAPI)
 *   - LinkedMusicians deals          (HTML via ScraperAPI)
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ScraperAPI key — set as environment variable in Render dashboard
// Never hardcode in production, but fallback here for initial testing
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || '50c29a0b985556b6aa7edc4da9d74ff7';

// Build ScraperAPI URL — routes any URL through residential proxies
function scraperUrl(targetUrl, options = {}) {
  const params = new URLSearchParams({
    api_key: SCRAPER_KEY,
    url: targetUrl,
    ...options
  });
  return `https://api.scraperapi.com/?${params.toString()}`;
}

// ── Cache ────────────────────────────────────────────────────
let cache      = null;
let cacheTime  = 0;
let lastCounts = {};
const TTL = 5 * 60 * 1000;

// ── Keep-alive ───────────────────────────────────────────────
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  setInterval(() => {
    fetch(url + '/health').catch(() => {});
    console.log('[keep-alive]', new Date().toISOString());
  }, 13 * 60 * 1000);
}

// ── Fetch via ScraperAPI with timeout ────────────────────────
async function scrapeFetch(targetUrl, ms = 30000, extraParams = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(scraperUrl(targetUrl, extraParams), {
      signal: controller.signal,
      headers: { 'Accept': 'text/html,application/json,*/*' }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Category classifier ──────────────────────────────────────
const CATS = {
  'Reverb'      : ['reverb','room reverb','plate reverb','spring reverb','convolution'],
  'Delay'       : [' delay ',' echo ','tape delay'],
  'Compression' : ['compressor','compression',' limiter','bus comp','1176','la-2a'],
  'EQ'          : ['equalizer','equaliser','pultec',' eq '],
  'Distortion'  : ['distortion','saturation','overdrive','fuzz','clipper'],
  'Modulation'  : ['chorus','flanger','phaser','tremolo','vibrato','rotary'],
  'Synths'      : ['synthesizer','wavetable','fm synth','analog synth','serum','massive','vital'],
  'Instruments' : ['piano','guitar','bass guitar','drum kit','orchestral','strings','kontakt','sample library'],
  'Mastering'   : ['mastering','master bus','loudness','metering','lufs'],
  'Utility'     : ['tuner','pitch shift','spectrum analyzer','noise reduction']
};

function classify(text) {
  const lo = (' ' + text + ' ').toLowerCase();
  for (const [cat, kws] of Object.entries(CATS))
    if (kws.some(k => lo.includes(k))) return cat;
  return 'Other';
}

// ── Price extraction ─────────────────────────────────────────
function extractPrice(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/g)]
    .map(m => parseFloat(m[1]))
    .filter(p => {
      // Must be a realistic plugin price
      if (p < 5 || p > 999) return false;
      // Exclude rating patterns like $4.9, $4.5
      if (p < 10 && String(p).includes('.')) return false;
      return true;
    });
  return matches.length ? Math.min(...matches) : null;
}

function extractMSRP(text) {
  if (!text) return null;
  const m = text.match(
    /(?:was|reg(?:ular)?|msrp|rrp|retail|orig(?:inal)?(?:\s+price)?|full price|list(?:ed)? (?:at|price))\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)/i
  );
  if (m) return parseFloat(m[1]);
  // "$sale / $msrp" pattern
  const slash = text.match(/\$(\d{1,3})\s*[\/]\s*\$(\d{1,3})/);
  if (slash) {
    const a = parseFloat(slash[1]), b = parseFloat(slash[2]);
    if (b > a) return b;
  }
  // "$X off $Y" pattern
  const off = text.match(/\$(\d{1,3})\s+off\s+\$(\d{1,3})/i);
  if (off) return parseFloat(off[2]);
  return null;
}

// ── Name cleaning ────────────────────────────────────────────
const SKIP = new Set([
  'free','deal','sale','unknown','various','plugin','audio','music',
  'software','app','get','new','now','save','buy','check','see','out',
  'find','best','top','hot','here','this','that','the','and','for'
]);

function cleanName(raw) {
  if (!raw || raw.length < 3) return null;
  let name = raw
    .replace(/^\[.*?\]\s*/,'')                          // [Developer] prefix
    .replace(/\$[\d,]+(?:\.\d{1,2})?/g,'')             // prices
    .replace(/\d+\s*%\s*off\b/gi,'')                   // "50% off"
    .replace(/\((?:reg|was|msrp|retail|save|only|just)[^)]{0,30}\)/gi,'') // price notes
    .replace(/\s*\|.*$/,'')                             // | suffix
    .replace(/[—–]\s*(?:now\s*)?\$[\d.]+.*$/i,'')      // "— $49" suffix
    .replace(/[,:!]+$/,'')                              // trailing punctuation
    .replace(/\s{2,}/g,' ')
    .trim();

  if (!name || name.length < 3 || name.length > 100) return null;

  const lo = name.toLowerCase();
  const words = lo.replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  // Reject if every word is a skip word
  if (words.every(w => SKIP.has(w) || w.length < 2)) return null;

  // Reject if it reads like a sentence (4+ common words)
  const commonWords = new Set(['the','and','for','with','from','this','that','your',
    'find','best','get','now','new','save','off','all','our','its','has','you']);
  if (words.filter(w => commonWords.has(w)).length >= 3) return null;

  return name;
}

function extractDev(title) {
  const m = title.match(/^\[([^\]]{2,35})\]/);
  if (m) return m[1].trim();
  const dash = title.match(/^([A-Z][a-zA-Z\s&.]{2,25})\s*[-–:]/);
  if (dash) return dash[1].trim();
  return 'Various';
}

function sentiment(text) {
  const lo = text.toLowerCase();
  let s = 0.5;
  ['great','excellent','best','worth','buy','steal','deal','love','recommended','essential']
    .forEach(w => { if (lo.includes(w)) s += 0.04; });
  ['avoid','skip','bad','meh','buggy','overpriced','not worth','disappointing']
    .forEach(w => { if (lo.includes(w)) s -= 0.06; });
  return Math.max(0.1, Math.min(0.95, parseFloat(s.toFixed(2))));
}

function dealScore(d) {
  const disc   = d.msrp > 0 ? Math.min((d.msrp - d.current_price) / d.msrp * 100, 100) : 0;
  const vsLow  = d.current_price <= d.historical_low_price ? 100
    : d.current_price <= d.historical_avg_sale_price ? 60 : 20;
  const rarity = Math.min(d.sale_frequency_days / 365, 1) * 100;
  const days   = d.last_sale_dates?.length
    ? (Date.now() - new Date(d.last_sale_dates[0])) / 86400000 : 999;
  const rec    = Math.min(days / (d.sale_frequency_days || 90), 1) * 100;
  const sent   = (d.sentiment || 0.5) * 100;
  return Math.min(Math.round(disc*.3 + vsLow*.3 + rarity*.2 + rec*.1 + sent*.1), 100);
}

let _uid = 1000;
function uid() { return ++_uid; }

function makeDeal(f) {
  const price = f.current_price;
  if (!price || price < 5) return null;
  const msrp = (f.msrp && f.msrp > price) ? f.msrp : price * 2;
  const d = {
    id: uid(),
    plugin_name: '', developer: 'Various', category: 'Other',
    current_price: price, msrp,
    historical_low_price: price,
    historical_avg_sale_price: Math.round(msrp * 0.65),
    last_sale_dates: [new Date().toISOString()],
    sale_frequency_days: 120,
    url: '', source: '',
    timestamp: new Date().toISOString(),
    price_history: [],
    dev_discount_freq: 'unknown',
    sentiment: 0.5, notes: '',
    ...f, msrp,
  };
  if (!d.plugin_name || d.plugin_name.length < 3) return null;
  d.deal_score = dealScore(d);
  return d;
}

// ── SCRAPER 1: Reddit r/AudioProductionDeals ─────────────────
// Using ScraperAPI so Reddit can't block by IP
async function scrapeReddit() {
  const res = await scrapeFetch(
    'https://www.reddit.com/r/AudioProductionDeals/new.json?limit=100&raw_json=1',
    30000,
    { render: false } // JSON endpoint, no JS rendering needed
  );

  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.data?.children) throw new Error('Reddit: unexpected shape');

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const deals  = [];

  for (const { data: p } of json.data.children) {
    if (p.stickied) continue;
    if (p.created_utc * 1000 < cutoff) continue;
    if (p.link_flair_text && /discussion|question|meta|mod|weekly/i.test(p.link_flair_text)) continue;

    const fullText = `${p.title} ${p.selftext || ''}`;
    const price    = extractPrice(p.title) ?? extractPrice(p.selftext || '');
    if (!price) continue;

    const name = cleanName(p.title);
    if (!name) continue;

    const msrp    = extractMSRP(fullText);
    const dealUrl = (!p.is_self && p.url && !p.url.includes('reddit.com'))
      ? p.url : `https://reddit.com${p.permalink}`;
    const ts = new Date(p.created_utc * 1000).toISOString();

    const d = makeDeal({
      plugin_name   : name,
      developer     : extractDev(p.title),
      category      : classify(fullText),
      current_price : price,
      msrp          : msrp || price * 2,
      url           : dealUrl,
      source        : 'Reddit r/AudioProductionDeals',
      timestamp     : ts,
      last_sale_dates: [ts],
      sentiment     : sentiment(fullText),
      notes         : (p.selftext || '').slice(0, 200),
    });
    if (d) deals.push(d);
  }

  console.log(`[reddit] ${deals.length} deals`);
  return deals;
}

// ── SCRAPER 2: KVR Audio ─────────────────────────────────────
async function scrapeKVR() {
  const res = await scrapeFetch(
    'https://www.kvraudio.com/forum/viewtopic.php?t=262151&start=25500',
    30000
  );

  if (!res.ok) throw new Error(`KVR HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];
  const seen  = new Set();

  $('div.postbody').each((_, el) => {
    const $el = $(el).clone();
    $el.find('blockquote, .quotecontent, .sig').remove();
    const text = $el.text().replace(/\s+/g, ' ').trim();

    const price = extractPrice(text);
    if (!price || price > 600) return;

    const msrp = extractMSRP(text) || price * 2;
    if (msrp <= price) return;

    // Extract name from text before the first price mention
    const beforePrice = text.split(/\$\d/)[0].trim();
    const lines = beforePrice.split(/[.!\n]/)
      .map(l => l.trim())
      .filter(l => l.length > 3 && l.length < 100);
    const rawName = lines[lines.length - 1] || lines[0] || '';
    const name = cleanName(rawName);
    if (!name) return;

    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
    if (seen.has(key)) return;
    seen.add(key);

    // Find best deal link — prefer non-KVR URLs
    let dealUrl = 'https://www.kvraudio.com/forum/viewtopic.php?t=262151';
    $el.find('a[href^="http"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes('kvraudio.com') && !href.includes('javascript')) {
        dealUrl = href; return false;
      }
    });

    const d = makeDeal({
      plugin_name  : name,
      category     : classify(text),
      current_price: price, msrp,
      url          : dealUrl,
      source       : 'KVR Audio',
      sentiment    : sentiment(text),
      notes        : text.slice(0, 200),
    });
    if (d) deals.push(d);
  });

  console.log(`[kvr] ${deals.length} deals`);
  return deals.slice(0, 25);
}

// ── SCRAPER 3: VI-Control ────────────────────────────────────
async function scrapeVIControl() {
  const res = await scrapeFetch(
    'https://vi-control.net/community/forums/deals-deals-deals.138/',
    30000
  );

  if (!res.ok) throw new Error(`VI-Control HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];
  const seen  = new Set();

  // XenForo 2 thread list
  $('div.structItem--thread, li.structItem--thread').each((_, el) => {
    const titleEl = $(el).find('.structItem-title');
    const text    = titleEl.text().replace(/\s+/g, ' ').trim();
    const href    = titleEl.find('a').last().attr('href') || '';
    const price   = extractPrice(text);
    if (!price) return;

    const name = cleanName(text);
    if (!name) return;

    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
    if (seen.has(key)) return;
    seen.add(key);

    const d = makeDeal({
      plugin_name  : name,
      category     : classify(text),
      current_price: price,
      msrp         : extractMSRP(text) || price * 2,
      url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
      source       : 'VI-Control',
      notes        : text,
    });
    if (d) deals.push(d);
  });

  // Fallback: thread links with prices
  if (!deals.length) {
    $('a[href*="/community/threads/"]').each((_, el) => {
      const text  = $(el).text().replace(/\s+/g, ' ').trim();
      const price = extractPrice(text);
      if (!price || text.length < 8) return;
      const name = cleanName(text);
      if (!name) return;
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
      if (seen.has(key)) return;
      seen.add(key);
      const href = $(el).attr('href') || '';
      const d = makeDeal({
        plugin_name  : name,
        category     : classify(text),
        current_price: price,
        msrp         : extractMSRP(text) || price * 2,
        url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
        source       : 'VI-Control',
        notes        : text,
      });
      if (d) deals.push(d);
    });
  }

  console.log(`[vic] ${deals.length} deals`);
  return deals.slice(0, 20);
}

// ── SCRAPER 4: AudioPluginGuy.com ────────────────────────────
async function scrapeAPG() {
  const res = await scrapeFetch(
    'https://www.audiopluginguy.com/deals/',
    30000
  );

  if (!res.ok) throw new Error(`APG HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];
  const seen  = new Set();

  // Try heading links — WordPress post titles
  const titleSelectors = [
    'h2.entry-title a', 'h3.entry-title a',
    'h2 a[rel="bookmark"]', 'h3 a[rel="bookmark"]',
    '.entry-title a', '.post-title a',
    'article h2 a', 'article h3 a',
    'h2 a', 'h3 a'
  ];

  for (const sel of titleSelectors) {
    $(sel).each((_, el) => {
      const $el    = $(el);
      const title  = $el.text().replace(/\s+/g, ' ').trim();
      const href   = $el.attr('href') || '';

      if (title.length < 5 || title.length > 200) return;
      // Skip nav/menu links
      if (href.includes('/category/') || href.includes('/tag/') ||
          href.includes('/page/') || href === '#') return;

      // Look for price in title or surrounding container
      const $card = $el.closest('article, .post, .entry, [class*="post-"], [class*="deal"]');
      const bodyText = ($card.length ? $card.text() : title).replace(/\s+/g, ' ');

      const price = extractPrice(title) || extractPrice(bodyText.slice(0, 500));
      if (!price || price > 600) return;

      const name = cleanName(title);
      if (!name) return;

      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
      if (seen.has(key)) return;
      seen.add(key);

      const msrp = extractMSRP(bodyText) || price * 2;
      const dateEl = $card.find('time').first();
      let ts = dateEl.attr('datetime') || new Date().toISOString();
      try { ts = new Date(ts).toISOString(); } catch { ts = new Date().toISOString(); }

      const d = makeDeal({
        plugin_name   : name,
        category      : classify(title + ' ' + bodyText.slice(0, 200)),
        current_price : price, msrp,
        url           : href.startsWith('http') ? href : `https://www.audiopluginguy.com${href}`,
        source        : 'AudioPluginGuy',
        timestamp     : ts,
        last_sale_dates: [ts],
        sentiment     : sentiment(bodyText.slice(0, 300)),
        notes         : bodyText.slice(0, 200),
      });
      if (d) deals.push(d);
    });
    if (deals.length >= 5) break;
  }

  console.log(`[apg] ${deals.length} deals`);
  return deals.slice(0, 30);
}

// ── SCRAPER 5: LinkedMusicians ───────────────────────────────
async function scrapeLinkedMusicians() {
  const res = await scrapeFetch(
    'https://linkedmusicians.com/forums/forum/deals/virtual-instruments-vsts-effects-plugins-sample-libraries/',
    30000
  );

  if (!res.ok) throw new Error(`LinkedMusicians HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];
  const seen  = new Set();

  const selectors = [
    'a.topictitle',
    'li.row > dl > dt > a',
    '.forumbg a.topictitle',
    'td.topic a',
    'h2 > a[href*="viewtopic"]',
    'a[href*="viewtopic"]'
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const text  = $(el).text().replace(/\s+/g, ' ').trim();
      const href  = $(el).attr('href') || '';
      if (text.length < 8 || text.length > 200) return;

      const price = extractPrice(text);
      if (!price) return;

      const name = cleanName(text);
      if (!name) return;

      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
      if (seen.has(key)) return;
      seen.add(key);

      const d = makeDeal({
        plugin_name  : name,
        category     : classify(text),
        current_price: price,
        msrp         : extractMSRP(text) || price * 2,
        url          : href.startsWith('http') ? href : `https://linkedmusicians.com${href}`,
        source       : 'LinkedMusicians',
        notes        : text,
      });
      if (d) deals.push(d);
    });
    if (deals.length) break;
  }

  console.log(`[lm] ${deals.length} deals`);
  return deals.slice(0, 20);
}

// ── Dedup ────────────────────────────────────────────────────
function dedup(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = (d.plugin_name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// Custom sources store
let customSources = [];

// ── /api/deals ────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  const force = req.query.force === '1';

  if (!force && cache && Date.now() - cacheTime < TTL) {
    return res.json({
      deals  : cache,
      source : 'cache',
      sources: lastCounts,
      updated: new Date(cacheTime).toISOString()
    });
  }

  console.log('[scraper] starting fetch' + (force ? ' (forced)' : '') + '...');

  // All scrapers run in parallel, each with their own 30s timeout via scrapeFetch
  const [reddit, kvr, vic, apg, lm] = await Promise.all([
    scrapeReddit().catch(e        => { console.error('[reddit]', e.message); return []; }),
    scrapeKVR().catch(e           => { console.error('[kvr]',    e.message); return []; }),
    scrapeVIControl().catch(e     => { console.error('[vic]',    e.message); return []; }),
    scrapeAPG().catch(e           => { console.error('[apg]',    e.message); return []; }),
    scrapeLinkedMusicians().catch(e=> { console.error('[lm]',     e.message); return []; }),
  ]);

  lastCounts = {
    reddit: reddit.length,
    kvr   : kvr.length,
    vic   : vic.length,
    apg   : apg.length,
    linkedMusicians: lm.length,
  };
  console.log('[scraper] counts:', JSON.stringify(lastCounts));

  const combined = dedup([...reddit, ...kvr, ...vic, ...apg, ...lm]);
  combined.sort((a, b) => b.deal_score - a.deal_score);

  // Only cache and return if we actually got real data
  // If everything failed, return an error so the client knows
  if (combined.length === 0) {
    return res.status(503).json({
      error  : 'All scrapers returned 0 results',
      sources: lastCounts,
      message: 'ScraperAPI may be rate-limited or sources have changed structure. Check /api/test for details.'
    });
  }

  cache     = combined;
  cacheTime = Date.now();

  res.json({
    deals  : combined,
    source : 'live',
    sources: lastCounts,
    updated: new Date().toISOString()
  });
});

// ── /api/test — plain text, streams results ───────────────────
app.get('/api/test', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.write('Plugin Copilot Scraper v6 — ScraperAPI\n');
  res.write('=======================================\n');
  res.write(`ScraperAPI key: ${SCRAPER_KEY ? SCRAPER_KEY.slice(0,8) + '...' : 'NOT SET'}\n\n`);

  const tests = [
    { name: 'REDDIT',         fn: scrapeReddit },
    { name: 'KVR AUDIO',      fn: scrapeKVR },
    { name: 'VI-CONTROL',     fn: scrapeVIControl },
    { name: 'AUDIOPLUGINGUY', fn: scrapeAPG },
    { name: 'LINKEDMUSICIANS',fn: scrapeLinkedMusicians },
  ];

  for (const { name, fn } of tests) {
    res.write(`--- ${name} ---\n`);
    try {
      const start   = Date.now();
      const results = await fn();
      const ms      = Date.now() - start;
      res.write(`count: ${results.length}  time: ${ms}ms\n`);
      results.slice(0, 6).forEach(d => {
        res.write(`  • ${d.plugin_name} — $${d.current_price} (msrp $${d.msrp}) [${d.source}]\n`);
      });
    } catch(e) {
      res.write(`ERROR: ${e.message}\n`);
    }
    res.write('\n');
  }

  res.end();
});

// ── Custom sources ────────────────────────────────────────────
app.post('/api/custom-sources', (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!customSources.find(s => s.url === url)) {
    customSources.push({ url, name: name || url });
    cache = null;
  }
  res.json({ ok: true, sources: customSources });
});
app.delete('/api/custom-sources', (req, res) => {
  const { url } = req.body || {};
  customSources = customSources.filter(s => s.url !== url);
  cache = null;
  res.json({ ok: true, sources: customSources });
});
app.get('/api/custom-sources', (_, res) => res.json({ sources: customSources }));

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    ok     : true,
    cached : cache?.length || 0,
    sources: lastCounts,
    apiKey : SCRAPER_KEY ? 'set' : 'MISSING',
    time   : new Date().toISOString()
  });
});

// ── Root ──────────────────────────────────────────────────────
app.get('/', (_, res) => {
  const counts = Object.entries(lastCounts).map(([k,v])=>`${k}:${v}`).join(' ');
  res.send(`<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;max-width:600px">
<h2>Plugin Copilot Scraper v6</h2>
<p>ScraperAPI key: ${SCRAPER_KEY ? 'configured' : '<strong style="color:red">MISSING — set SCRAPER_API_KEY env var</strong>'}</p>
<p>Cache: ${cache ? cache.length + ' deals' : 'empty'} | ${counts || 'not fetched yet'}</p>
<ul style="line-height:2.4">
  <li><a href="/api/deals">/api/deals</a> — all deals (5min cache)</li>
  <li><a href="/api/deals?force=1">/api/deals?force=1</a> — force fresh scrape</li>
  <li><a href="/api/test">/api/test</a> — test each scraper (takes ~2min)</li>
  <li><a href="/health">/health</a> — health + cache status</li>
</ul>
<p style="color:#888;font-size:12px">Paste the base URL of this page into Plugin Copilot → Settings → Scraper Connection</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Plugin Copilot scraper v6 (ScraperAPI) on port ${PORT}`);
  if (!SCRAPER_KEY) console.error('WARNING: SCRAPER_API_KEY not set!');
  startKeepAlive();
});
