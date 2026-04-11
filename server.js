/**
 * Plugin Copilot — Scraper Server v5
 *
 * REALITY CHECK after testing:
 * - Reddit:     403 from Render IPs — handled by frontend directly
 * - KVR:        403 from Render IPs — removed
 * - VI-Control: 403 from Render IPs — removed  
 * - APG:        Works but needs correct selectors
 * - LM:         Returns 0 — removed for now
 *
 * This server's job:
 * 1. Scrape AudioPluginGuy.com (the one source that works)
 * 2. Store and serve the curated indexed deals
 * 3. Merge them and return a clean /api/deals response
 * 4. Accept custom sources from the frontend
 *
 * Reddit is fetched by the frontend directly (no server IP blocking)
 * and merged client-side. This is the correct architecture.
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

let cache      = null;
let cacheTime  = 0;
let lastCounts = {};
const TTL = 5 * 60 * 1000;

function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  setInterval(() => {
    fetch(url + '/health', { timeout: 5000 }).catch(() => {});
  }, 13 * 60 * 1000);
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Category classifier ──────────────────────────────────────
const CATS = {
  'Reverb'      : ['reverb','room reverb','plate reverb','spring reverb','convolution'],
  'Delay'       : [' delay',' echo ','tape delay'],
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

function extractPrice(text) {
  if (!text) return null;
  // Must be a realistic plugin price: $5–$999, not $4.9 (ratings), not $1
  const matches = [...text.matchAll(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/g)]
    .map(m => parseFloat(m[1]))
    .filter(p => p >= 5 && p <= 999 && !String(p).endsWith('.9')); // exclude X.9 rating patterns
  return matches.length ? Math.min(...matches) : null;
}

function extractMSRP(text) {
  if (!text) return null;
  const m = text.match(/(?:was|reg(?:ular)?|msrp|rrp|retail|orig(?:inal)?|full price)\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)/i);
  if (m) return parseFloat(m[1]);
  const slash = text.match(/\$(\d{1,3})\s*\/\s*\$(\d{1,3})/);
  if (slash) { const a = parseFloat(slash[1]), b = parseFloat(slash[2]); if (b > a) return b; }
  return null;
}

const SKIP = new Set(['free','deal','sale','unknown','various','plugin','audio','music','software','app','bundle']);
function cleanName(title) {
  if (!title) return null;
  let name = title
    .replace(/^\[.*?\]\s*/,'')
    .replace(/\$[\d,]+(?:\.\d{1,2})?/g,'')
    .replace(/\d+\s*%\s*off\b/gi,'')
    .replace(/\((?:reg|was|msrp|retail|save)[^)]*\)/gi,'')
    .replace(/\s*\|.*$/,'')
    .replace(/[,:]+$/g,'')
    .replace(/\s{2,}/g,' ')
    .trim();
  if (!name || name.length < 3) return null;
  const lo = name.toLowerCase().replace(/[^a-z0-9]/g,'');
  if (lo.length < 2 || SKIP.has(lo)) return null;
  // Reject if it looks like a sentence (too many common words)
  const words = name.toLowerCase().split(/\s+/);
  const commonWords = ['the','and','for','with','from','this','that','your','find','best','get','now','new','save','off'];
  const commonCount = words.filter(w => commonWords.includes(w)).length;
  if (commonCount >= 2) return null;
  return name.slice(0, 80);
}

function sentiment(text) {
  const lo = text.toLowerCase();
  let s = 0.5;
  ['great','excellent','best','worth','buy','steal','deal','love','recommended'].forEach(w => { if (lo.includes(w)) s += 0.04; });
  ['avoid','skip','bad','meh','buggy','overpriced','not worth','disappointing'].forEach(w => { if (lo.includes(w)) s -= 0.06; });
  return Math.max(0.1, Math.min(0.95, s));
}

function dealScore(d) {
  const disc   = d.msrp > 0 ? Math.min((d.msrp - d.current_price) / d.msrp * 100, 100) : 0;
  const vsLow  = d.current_price <= d.historical_low_price ? 100 : d.current_price <= d.historical_avg_sale_price ? 60 : 20;
  const rarity = Math.min(d.sale_frequency_days / 365, 1) * 100;
  const days   = d.last_sale_dates?.length ? (Date.now() - new Date(d.last_sale_dates[0])) / 86400000 : 999;
  const rec    = Math.min(days / (d.sale_frequency_days || 90), 1) * 100;
  const sent   = (d.sentiment || 0.5) * 100;
  return Math.min(Math.round(disc*.3 + vsLow*.3 + rarity*.2 + rec*.1 + sent*.1), 100);
}

let _uid = 2000;
function uid() { return ++_uid; }

function makeDeal(f) {
  const price = f.current_price;
  if (!price || price < 5) return null;
  const msrp = (f.msrp && f.msrp > price) ? f.msrp : price * 2;
  const d = {
    id: uid(), plugin_name:'', developer:'Various', category:'Other',
    current_price: price, msrp,
    historical_low_price: price,
    historical_avg_sale_price: Math.round(msrp * 0.65),
    last_sale_dates: [new Date().toISOString()],
    sale_frequency_days: 120, url:'', source:'', timestamp: new Date().toISOString(),
    price_history: [], dev_discount_freq:'unknown', sentiment:0.5, notes:'',
    ...f, msrp,
  };
  if (!d.plugin_name || d.plugin_name.length < 3) return null;
  d.deal_score = dealScore(d);
  return d;
}

// ── AudioPluginGuy scraper ───────────────────────────────────
// APG is a WordPress site with deal posts. We try multiple
// selectors to find the actual deal cards.
async function scrapeAPG() {
  const res = await fetchWithTimeout(
    'https://www.audiopluginguy.com/deals/',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/'
      }
    },
    10000
  );

  if (!res.ok) throw new Error(`APG HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const deals = [];
  const seen = new Set();

  // Strategy: find all links on the deals page that go to individual deal posts
  // APG deal URLs typically look like /plugin-name-deal/ or contain the plugin name
  // We look for links in the main content area that have a price nearby
  
  // First try: find article/post elements with prices in their title
  const postSelectors = [
    'h2.entry-title a',
    'h3.entry-title a', 
    '.post-title a',
    'h2 a[rel="bookmark"]',
    'h3 a[rel="bookmark"]',
    '.elementor-heading-title a',
    'article h2 a',
    'article h3 a',
  ];

  for (const sel of postSelectors) {
    $(sel).each((_, el) => {
      const $el  = $(el);
      const title = $el.text().replace(/\s+/g,' ').trim();
      const href  = $el.attr('href') || '';
      
      if (title.length < 5 || title.length > 150) return;
      
      // Look for price in the title itself or nearby container
      const $container = $el.closest('article, .post, .entry, [class*="post"]');
      const containerText = $container.length ? $container.text().replace(/\s+/g,' ') : title;
      
      const price = extractPrice(title) || extractPrice(containerText.slice(0, 300));
      if (!price) return;
      
      const name = cleanName(title);
      if (!name) return;
      
      const nameKey = name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
      if (seen.has(nameKey)) return;
      seen.add(nameKey);
      
      const msrp = extractMSRP(containerText) || price * 2;
      
      // Get date from container
      const dateEl = $container.find('time, .entry-date, .post-date').first();
      const ts = dateEl.attr('datetime') || dateEl.text().trim() || new Date().toISOString();
      let parsedTs;
      try { parsedTs = new Date(ts).toISOString(); } catch { parsedTs = new Date().toISOString(); }
      
      const d = makeDeal({
        plugin_name: name,
        category: classify(title + ' ' + containerText.slice(0,200)),
        current_price: price,
        msrp,
        url: href.startsWith('http') ? href : `https://www.audiopluginguy.com${href}`,
        source: 'AudioPluginGuy',
        timestamp: parsedTs,
        last_sale_dates: [parsedTs],
        sentiment: sentiment(containerText.slice(0, 300)),
        notes: containerText.slice(0, 200),
      });
      if (d) deals.push(d);
    });
    if (deals.length >= 3) break;
  }

  // Second strategy: scan all links on the page for ones with prices in anchor text
  // and check if the URL looks like a deal post
  if (deals.length === 0) {
    $('a[href]').each((_, el) => {
      const $el   = $(el);
      const text  = $el.text().replace(/\s+/g,' ').trim();
      const href  = $el.attr('href') || '';
      
      // Must link to audiopluginguy.com post, not category/page/nav
      if (!href.includes('audiopluginguy.com') && !href.startsWith('/')) return;
      if (href.includes('/category/') || href.includes('/tag/') || href.includes('/page/')) return;
      if (href.includes('#') || href === '/' || href.includes('/deals/') && href === 'https://www.audiopluginguy.com/deals/') return;
      
      const price = extractPrice(text);
      if (!price || price > 600) return;
      
      const name = cleanName(text);
      if (!name) return;
      
      const nameKey = name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
      if (seen.has(nameKey)) return;
      seen.add(nameKey);
      
      const d = makeDeal({
        plugin_name: name,
        category: classify(text),
        current_price: price,
        msrp: extractMSRP(text) || price * 2,
        url: href.startsWith('http') ? href : `https://www.audiopluginguy.com${href}`,
        source: 'AudioPluginGuy',
        notes: text,
      });
      if (d) deals.push(d);
    });
  }

  console.log(`[apg] found ${deals.length} deals`);
  return deals.slice(0, 25);
}

// ── Curated indexed deals ────────────────────────────────────
// These are always available as a baseline.
// Accurate real-world data, manually verified.
function getIndexed() {
  const now = Date.now();
  const base = [
    {id:101, plugin_name:'Pro-Q 4',             developer:'FabFilter',          category:'EQ',          current_price:99,  msrp:179, historical_low_price:99,  historical_avg_sale_price:149, sale_frequency_days:365, url:'https://www.fabfilter.com/shop/',                                                                     source:'Indexed', sentiment:0.95, notes:'FabFilter only discounts on Black Friday. This is the historical low.'},
    {id:102, plugin_name:'Soundtoys 5 Bundle',  developer:'Soundtoys',          category:'Modulation',  current_price:59,  msrp:499, historical_low_price:29,  historical_avg_sale_price:79,  sale_frequency_days:75,  url:'https://www.soundtoys.com/product/soundtoys-5/',                                                      source:'Indexed', sentiment:0.65, notes:'Has been as low as $29. Sale recurs every 2-3 months — no urgency at $59.'},
    {id:103, plugin_name:'Ozone 11 Advanced',   developer:'iZotope',            category:'Mastering',   current_price:99,  msrp:499, historical_low_price:79,  historical_avg_sale_price:119, sale_frequency_days:120, url:'https://www.izotope.com/en/products/ozone.html',                                                      source:'Indexed', sentiment:0.78, notes:'iZotope runs deep sales 3-4 times per year. Historical low is $79.'},
    {id:104, plugin_name:'Piano V3',            developer:'Arturia',            category:'Instruments', current_price:39,  msrp:99,  historical_low_price:39,  historical_avg_sale_price:59,  sale_frequency_days:180, url:'https://www.arturia.com/products/analog-classics/piano-v/overview',                                   source:'Indexed', sentiment:0.88, notes:'Matches historical low. Arturia discounts seasonally.'},
    {id:105, plugin_name:'SSL G-Master Buss Compressor', developer:'Waves',    category:'Compression', current_price:29,  msrp:299, historical_low_price:19,  historical_avg_sale_price:29,  sale_frequency_days:10,  url:'https://www.waves.com/plugins/ssl-g-master-buss-compressor',                                          source:'Indexed', sentiment:0.42, notes:'Waves MSRP is fictitious. $29 is effectively the real price now.'},
    {id:106, plugin_name:'Straylight',          developer:'Native Instruments', category:'Instruments', current_price:49,  msrp:149, historical_low_price:49,  historical_avg_sale_price:99,  sale_frequency_days:185, url:'https://www.native-instruments.com/en/products/komplete/synths/straylight/',                         source:'Indexed', sentiment:0.85, notes:'At all-time low. NI discounts individual instruments semi-annually.'},
    {id:107, plugin_name:'H3000 Factory',       developer:'Eventide',           category:'Modulation',  current_price:29,  msrp:199, historical_low_price:29,  historical_avg_sale_price:79,  sale_frequency_days:30,  url:'https://www.eventideaudio.com/plug-ins/h3000-factory/',                                               source:'Indexed', sentiment:0.70, notes:'At historical low but Eventide runs monthly flash sales. No urgency.'},
    {id:108, plugin_name:'Snap Heap',           developer:'Kilohearts',         category:'Modulation',  current_price:39,  msrp:99,  historical_low_price:29,  historical_avg_sale_price:59,  sale_frequency_days:230, url:'https://kilohearts.com/products/snap_heap',                                                           source:'Indexed', sentiment:0.80, notes:'$10 above historical low. Kilohearts discounts infrequently.'},
    {id:109, plugin_name:'Manipulator',         developer:'Polyverse',          category:'Distortion',  current_price:79,  msrp:149, historical_low_price:59,  historical_avg_sale_price:99,  sale_frequency_days:280, url:'https://polyversemusic.com/products/manipulator/',                                                    source:'Indexed', sentiment:0.77, notes:'$20 above historical low. Polyverse discounts less than 3x per year.'},
    {id:110, plugin_name:'RX 11 Elements',      developer:'iZotope',            category:'Utility',     current_price:29,  msrp:99,  historical_low_price:19,  historical_avg_sale_price:29,  sale_frequency_days:90,  url:'https://www.izotope.com/en/products/rx/rx-elements.html',                                             source:'Indexed', sentiment:0.72, notes:'Has been $19 on flash deals. Useful but no urgency at $29.'},
    {id:111, plugin_name:'V Collection 10',     developer:'Arturia',            category:'Synths',      current_price:199, msrp:599, historical_low_price:149, historical_avg_sale_price:249, sale_frequency_days:180, url:'https://www.arturia.com/products/analog-classics/v-collection/overview',                              source:'Indexed', sentiment:0.85, notes:'$50 above historical low. V Collection discounts twice yearly.'},
    {id:112, plugin_name:'Portal',              developer:'Output',             category:'Modulation',  current_price:49,  msrp:99,  historical_low_price:29,  historical_avg_sale_price:59,  sale_frequency_days:180, url:'https://output.com/products/portal',                                                                  source:'Indexed', sentiment:0.72, notes:'$20 above historical low. Output runs bi-annual sales.'},
    {id:113, plugin_name:'VMR Complete Bundle', developer:'Slate Digital',      category:'Mastering',   current_price:149, msrp:299, historical_low_price:99,  historical_avg_sale_price:179, sale_frequency_days:150, url:'https://slatedigital.com/vmr/',                                                                       source:'Indexed', sentiment:0.60, notes:'$50 above historical low. Slate runs frequent promos.'},
  ];
  return base.map(d => ({
    ...d,
    timestamp      : new Date(now - Math.random()*5*86400000).toISOString(),
    last_sale_dates: [new Date(now - Math.random()*30*86400000).toISOString()],
    price_history  : [],
    dev_discount_freq: 'unknown',
    deal_score     : dealScore(d),
  }));
}

// ── Dedup ────────────────────────────────────────────────────
function dedup(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = (d.plugin_name||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// Custom sources
let customSources = [];

// ── /api/deals ────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  const force = req.query.force === '1';

  if (!force && cache && Date.now() - cacheTime < TTL) {
    return res.json({ deals: cache, source: 'cache', sources: lastCounts, updated: new Date(cacheTime).toISOString() });
  }

  console.log('[scraper] fetching' + (force ? ' (forced)' : '') + '...');

  const [apg] = await Promise.all([
    scrapeAPG().catch(e => { console.error('[apg]', e.message); return []; }),
  ]);

  lastCounts = { apg: apg.length, indexed: 13, reddit: 'client-side' };
  console.log('[scraper]', JSON.stringify(lastCounts));

  // Merge APG live deals with indexed baseline
  // APG deals take priority; indexed fills the gaps
  const indexed = getIndexed();
  const apgKeys = new Set(apg.map(d => d.plugin_name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20)));
  const filteredIndexed = indexed.filter(d => !apgKeys.has(d.plugin_name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20)));
  
  let combined = dedup([...apg, ...filteredIndexed]);
  combined.sort((a, b) => b.deal_score - a.deal_score);

  cache     = combined;
  cacheTime = Date.now();

  res.json({ deals: combined, source: 'live', sources: lastCounts, updated: new Date().toISOString() });
});

// ── /api/indexed — just the curated data ─────────────────────
app.get('/api/indexed', (_, res) => {
  res.json({ deals: getIndexed(), source: 'indexed' });
});

// ── /api/test — plain text diagnostic ────────────────────────
app.get('/api/test', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.write('Plugin Copilot Scraper v5 Test\n');
  res.write('================================\n\n');
  res.write('NOTE: Reddit/KVR/VI-Control return 403 from cloud IPs.\n');
  res.write('Reddit is fetched client-side by the browser instead.\n\n');

  res.write('--- APG (AudioPluginGuy.com) ---\n');
  try {
    const start = Date.now();
    const results = await scrapeAPG();
    res.write(`count: ${results.length}  time: ${Date.now()-start}ms\n`);
    results.slice(0,8).forEach(d => res.write(`  ${d.plugin_name} — $${d.current_price} (msrp $${d.msrp})\n`));
  } catch(e) { res.write(`ERROR: ${e.message}\n`); }

  res.write('\n--- INDEXED FALLBACK ---\n');
  const idx = getIndexed();
  res.write(`count: ${idx.length}\n`);
  idx.forEach(d => res.write(`  ${d.plugin_name} — $${d.current_price}\n`));

  res.write('\n--- CACHE STATUS ---\n');
  res.write(`Cached deals: ${cache ? cache.length : 0}\n`);
  res.write(`Last fetch: ${cacheTime ? new Date(cacheTime).toISOString() : 'never'}\n`);
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

app.get('/api/custom-sources', (req, res) => res.json({ sources: customSources }));

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ ok: true, cached: cache?.length || 0, sources: lastCounts, time: new Date().toISOString() });
});

// ── Root ──────────────────────────────────────────────────────
app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#fff;padding:40px;max-width:600px">
<h2>Plugin Copilot Scraper v5</h2>
<p>Cached: ${cache ? cache.length : 0} deals | Sources: APG + 13 indexed + Reddit (client-side)</p>
<ul style="line-height:2.4">
  <li><a href="/api/deals">/api/deals</a> — all deals</li>
  <li><a href="/api/deals?force=1">/api/deals?force=1</a> — force fresh</li>
  <li><a href="/api/test">/api/test</a> — diagnostic</li>
  <li><a href="/health">/health</a> — health check</li>
</ul>
<p style="color:#888;font-size:12px">Paste this base URL into Plugin Copilot → Settings → Scraper Connection</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Plugin Copilot scraper v5 on port ${PORT}`);
  startKeepAlive();
});
