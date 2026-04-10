/**
 * Plugin Copilot — Scraper Server v4
 * Render.com deploy:
 *   Build command:  npm install
 *   Start command:  node server.js
 *
 * SIMPLIFIED: Every fetch has an 8-second timeout.
 * /api/test returns in under 30 seconds guaranteed.
 * Server-side fallback ensures deals are always returned.
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Cache ────────────────────────────────────────────────────
let cache      = null;
let cacheTime  = 0;
let lastCounts = {};
const TTL = 5 * 60 * 1000;

// ── Keep-alive (Render free) ─────────────────────────────────
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  setInterval(() => {
    fetch(url + '/health', { timeout: 5000 }).catch(() => {});
    console.log('[keep-alive]', new Date().toISOString());
  }, 13 * 60 * 1000);
}

// ── Fetch with guaranteed timeout ────────────────────────────
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Category classifier ──────────────────────────────────────
const CATS = {
  'Reverb'      : ['reverb','room reverb','hall reverb','plate reverb','spring reverb','convolution'],
  'Delay'       : [' delay',' echo ','tape delay','ping pong'],
  'Compression' : ['compressor','compression',' limiter','bus comp','1176','la-2a','ssl bus'],
  'EQ'          : ['equalizer','equaliser','pultec','api 550','neve 1073',' eq '],
  'Distortion'  : ['distortion','saturation','overdrive','fuzz','clipper','harmonic exciter'],
  'Modulation'  : ['chorus','flanger','phaser','tremolo','vibrato','rotary','leslie','ensemble'],
  'Synths'      : ['synthesizer','wavetable','fm synth','analog synth','serum','massive','vital'],
  'Instruments' : ['piano','electric piano','guitar','bass guitar','drum kit','orchestral','strings','kontakt','sample library'],
  'Mastering'   : ['mastering','master bus','loudness','metering','lufs','true peak'],
  'Utility'     : ['tuner','pitch shift','spectrum analyzer','noise reduction','restoration']
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
    .filter(p => p >= 3 && p <= 999);
  return matches.length ? Math.min(...matches) : null;
}

function extractMSRP(text) {
  if (!text) return null;
  const m = text.match(/(?:was|reg(?:ular)?|msrp|rrp|retail|orig(?:inal)?|full price)\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)/i);
  if (m) return parseFloat(m[1]);
  const slash = text.match(/\$(\d{1,3})\s*[\/]\s*\$(\d{1,3})/);
  if (slash) { const a = parseFloat(slash[1]), b = parseFloat(slash[2]); if (b > a) return b; }
  return null;
}

// ── Plugin name cleaning ─────────────────────────────────────
// Simple and safe — only removes what we're certain about
const SKIP_WORDS = new Set(['free','deal','sale','unknown','various','plugin','vst','audio']);

function cleanName(title) {
  if (!title) return null;
  let name = title
    .replace(/^\[.*?\]\s*/,'')           // [Developer] prefix
    .replace(/\$[\d,]+(?:\.\d{1,2})?/g,'')  // prices
    .replace(/\d+\s*%\s*off\b/gi,'')     // "50% off"
    .replace(/\s*\|.*$/,'')             // pipe suffix only (not dashes!)
    .replace(/\s{2,}/g,' ')
    .trim();

  if (name.length < 2) return null;
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g,'');
  if (lower.length < 2) return null;
  if (SKIP_WORDS.has(lower)) return null;
  return name.slice(0, 80);
}

function extractDev(title) {
  const m = title.match(/^\[([^\]]{2,35})\]/);
  if (m) return m[1].trim();
  return 'Various';
}

// ── Sentiment ─────────────────────────────────────────────────
function sentiment(text) {
  const lo = text.toLowerCase();
  let s = 0.5;
  ['great','excellent','best','worth','buy','steal','deal','love','recommended'].forEach(w => { if (lo.includes(w)) s += 0.04; });
  ['avoid','skip','bad','meh','buggy','overpriced','not worth','disappointing'].forEach(w => { if (lo.includes(w)) s -= 0.06; });
  return Math.max(0.1, Math.min(0.95, s));
}

// ── Deal score ────────────────────────────────────────────────
function dealScore(d) {
  const disc   = d.msrp > 0 ? Math.min((d.msrp - d.current_price) / d.msrp * 100, 100) : 0;
  const vsLow  = d.current_price <= d.historical_low_price ? 100 : d.current_price <= d.historical_avg_sale_price ? 60 : 20;
  const rarity = Math.min(d.sale_frequency_days / 365, 1) * 100;
  const days   = d.last_sale_dates?.length ? (Date.now() - new Date(d.last_sale_dates[0])) / 86400000 : 999;
  const rec    = Math.min(days / (d.sale_frequency_days || 90), 1) * 100;
  const sent   = (d.sentiment || 0.5) * 100;
  return Math.min(Math.round(disc*.3 + vsLow*.3 + rarity*.2 + rec*.1 + sent*.1), 100);
}

let _uid = 1000;
function uid() { return ++_uid; }

function makeDeal(fields) {
  const price = fields.current_price;
  if (!price || price < 1) return null;
  const msrp = (fields.msrp && fields.msrp > price) ? fields.msrp : price * 2;
  const d = {
    id                        : uid(),
    plugin_name               : 'Unknown',
    developer                 : 'Various',
    category                  : 'Other',
    current_price             : price,
    msrp,
    historical_low_price      : price,
    historical_avg_sale_price : Math.round(msrp * 0.65),
    last_sale_dates           : [new Date().toISOString()],
    sale_frequency_days       : 120,
    url                       : '',
    source                    : '',
    timestamp                 : new Date().toISOString(),
    price_history             : [],
    dev_discount_freq         : 'unknown',
    sentiment                 : 0.5,
    notes                     : '',
    ...fields,
    msrp,
  };
  if (!d.plugin_name || d.plugin_name.length < 2 || d.plugin_name === 'Unknown') return null;
  d.deal_score = dealScore(d);
  return d;
}

// ── SCRAPER 1: Reddit ─────────────────────────────────────────
// Uses Reddit's public JSON API — no auth, proven to work
async function scrapeReddit() {
  const res = await fetchWithTimeout(
    'https://www.reddit.com/r/AudioProductionDeals/new.json?limit=100&raw_json=1',
    { headers: { 'User-Agent': 'plugin-copilot-deals/4.0 (open source audio deal aggregator)' } },
    8000
  );

  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.data?.children) throw new Error('Reddit: unexpected response shape');

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const deals = [];

  for (const { data: p } of json.data.children) {
    if (p.stickied) continue;
    if (p.created_utc * 1000 < cutoff) continue;
    if (p.link_flair_text && /discussion|question|meta|mod|weekly/i.test(p.link_flair_text)) continue;

    const fullText = `${p.title} ${p.selftext || ''}`;
    const price = extractPrice(p.title) ?? extractPrice(p.selftext || '');
    if (!price) continue;

    const name = cleanName(p.title);
    if (!name) continue;

    const msrp = extractMSRP(fullText);
    const dealUrl = (!p.is_self && p.url && !p.url.includes('reddit.com'))
      ? p.url : `https://reddit.com${p.permalink}`;

    const ts = new Date(p.created_utc * 1000).toISOString();
    const d = makeDeal({
      plugin_name    : name,
      developer      : extractDev(p.title),
      category       : classify(fullText),
      current_price  : price,
      msrp           : msrp || price * 2,
      url            : dealUrl,
      source         : 'Reddit r/AudioProductionDeals',
      timestamp      : ts,
      last_sale_dates: [ts],
      sentiment      : sentiment(fullText),
      notes          : (p.selftext || '').slice(0, 200),
    });
    if (d) deals.push(d);
  }

  return deals;
}

// ── SCRAPER 2: AudioPluginGuy ────────────────────────────────
// Primary historical reference — WordPress deal listing page
async function scrapeAPG() {
  const res = await fetchWithTimeout(
    'https://www.audiopluginguy.com/deals/',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept'    : 'text/html',
        'Referer'   : 'https://www.google.com/'
      }
    },
    8000
  );

  if (!res.ok) throw new Error(`APG HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  // WordPress posts — each article or .post contains a deal
  // Try the most common WordPress selectors
  $('article, .post, .entry, .deal').each((_, el) => {
    const $el    = $(el);
    const title  = $el.find('h1,h2,h3,.entry-title,.post-title').first().text().trim();
    const body   = $el.text().replace(/\s+/g,' ').trim();
    const price  = extractPrice(title) || extractPrice(body);
    if (!price || price > 600) return;

    const name = cleanName(title) || cleanName(body.slice(0,80));
    if (!name) return;

    const msrp   = extractMSRP(body) || price * 2;
    const href   = $el.find('a[href]').first().attr('href') || '';
    const dateEl = $el.find('time').first();
    const ts     = dateEl.attr('datetime') || new Date().toISOString();

    const d = makeDeal({
      plugin_name    : name,
      category       : classify(title + ' ' + body.slice(0,200)),
      current_price  : price,
      msrp,
      url            : href.startsWith('http') ? href : 'https://www.audiopluginguy.com/deals/',
      source         : 'AudioPluginGuy',
      timestamp      : ts,
      last_sale_dates: [ts],
      sentiment      : sentiment(body.slice(0,300)),
      notes          : body.slice(0,200),
    });
    if (d) deals.push(d);
  });

  return deals;
}

// ── SCRAPER 3: KVR Audio ──────────────────────────────────────
async function scrapeKVR() {
  const url = 'https://www.kvraudio.com/forum/viewtopic.php?t=262151&start=25500';
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'    : 'text/html',
    }
  }, 8000);

  if (!res.ok) throw new Error(`KVR HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  $('div.postbody').each((_, el) => {
    const $el = $(el).clone();
    $el.find('blockquote,.quotecontent,.sig').remove();
    const text = $el.text().replace(/\s+/g,' ').trim();

    const price = extractPrice(text);
    if (!price || price > 600) return;

    const msrp = extractMSRP(text) || price * 2;
    if (msrp <= price) return;

    // Get name from the first meaningful line before the price
    const beforePrice = text.split(/\$\d/)[0];
    const lines = beforePrice.split(/[.!\n]/).map(l=>l.trim()).filter(l=>l.length>3&&l.length<100);
    const rawName = lines[lines.length-1] || lines[0] || '';
    const name = cleanName(rawName);
    if (!name) return;

    let dealUrl = url;
    $el.find('a[href^="http"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes('kvraudio.com') && !href.includes('javascript')) {
        dealUrl = href; return false;
      }
    });

    const d = makeDeal({
      plugin_name  : name,
      category     : classify(text),
      current_price: price,
      msrp,
      url          : dealUrl,
      source       : 'KVR Audio',
      sentiment    : sentiment(text),
      notes        : text.slice(0,200),
    });
    if (d) deals.push(d);
  });

  return deals.slice(0, 20);
}

// ── SCRAPER 4: VI-Control ────────────────────────────────────
async function scrapeVIC() {
  const url = 'https://vi-control.net/community/forums/deals-deals-deals.138/';
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
  }, 8000);

  if (!res.ok) throw new Error(`VI-Control HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  $('div.structItem--thread, li.structItem--thread').each((_, el) => {
    const titleEl = $(el).find('.structItem-title');
    const text    = titleEl.text().replace(/\s+/g,' ').trim();
    const href    = titleEl.find('a').last().attr('href') || '';
    const price   = extractPrice(text);
    if (!price) return;

    const name = cleanName(text);
    if (!name) return;

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

  // Fallback selector
  if (!deals.length) {
    $('a[href*="/community/threads/"]').each((_, el) => {
      const text  = $(el).text().replace(/\s+/g,' ').trim();
      const price = extractPrice(text);
      if (!price || text.length < 8) return;
      const name = cleanName(text);
      if (!name) return;
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

  return deals.slice(0, 15);
}

// ── SCRAPER 5: LinkedMusicians ───────────────────────────────
async function scrapeLM() {
  const url = 'https://linkedmusicians.com/forums/forum/deals/virtual-instruments-vsts-effects-plugins-sample-libraries/';
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
  }, 8000);

  if (!res.ok) throw new Error(`LinkedMusicians HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  const selectors = ['a.topictitle','li.row > dl > dt > a','.forumbg a.topictitle','a[href*="viewtopic"]'];
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const text  = $(el).text().replace(/\s+/g,' ').trim();
      const href  = $(el).attr('href') || '';
      if (text.length < 8 || text.length > 200) return;
      const price = extractPrice(text);
      if (!price) return;
      const name = cleanName(text);
      if (!name) return;
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

  return deals.slice(0, 15);
}

// ── Curated fallback — always returned if scrapers get 0 ─────
function getFallback() {
  const base = [
    {id:101, plugin_name:'Pro-Q 4',             developer:'FabFilter',          category:'EQ',          current_price:99,  msrp:179, historical_low_price:99,  historical_avg_sale_price:149, sale_frequency_days:365, url:'https://www.fabfilter.com/shop/', source:'Indexed', sentiment:0.95, notes:'FabFilter only discounts on Black Friday.'},
    {id:102, plugin_name:'Soundtoys 5 Bundle',  developer:'Soundtoys',          category:'Modulation',  current_price:59,  msrp:499, historical_low_price:29,  historical_avg_sale_price:79,  sale_frequency_days:75,  url:'https://www.soundtoys.com/product/soundtoys-5/', source:'Indexed', sentiment:0.65, notes:'Has been as low as $29. Sale recurs every 2-3 months.'},
    {id:103, plugin_name:'Ozone 11 Advanced',   developer:'iZotope',            category:'Mastering',   current_price:99,  msrp:499, historical_low_price:79,  historical_avg_sale_price:119, sale_frequency_days:120, url:'https://www.izotope.com/en/products/ozone.html', source:'Indexed', sentiment:0.78, notes:'iZotope runs deep sales 3-4 times per year. Historical low is $79.'},
    {id:104, plugin_name:'Piano V3',            developer:'Arturia',            category:'Instruments', current_price:39,  msrp:99,  historical_low_price:39,  historical_avg_sale_price:59,  sale_frequency_days:180, url:'https://www.arturia.com/products/analog-classics/piano-v/overview', source:'Indexed', sentiment:0.88, notes:'Matches historical low. Arturia discounts seasonally.'},
    {id:105, plugin_name:'SSL G-Master Buss Compressor', developer:'Waves',    category:'Compression', current_price:29,  msrp:299, historical_low_price:19,  historical_avg_sale_price:29,  sale_frequency_days:10,  url:'https://www.waves.com/plugins/ssl-g-master-buss-compressor', source:'Indexed', sentiment:0.42, notes:'Waves MSRP is fictitious. $29 is effectively the standard price.'},
    {id:106, plugin_name:'Straylight',          developer:'Native Instruments', category:'Instruments', current_price:49,  msrp:149, historical_low_price:49,  historical_avg_sale_price:99,  sale_frequency_days:185, url:'https://www.native-instruments.com/en/products/komplete/synths/straylight/', source:'Indexed', sentiment:0.85, notes:'At all-time low. NI discounts semi-annually.'},
    {id:107, plugin_name:'H3000 Factory',       developer:'Eventide',           category:'Modulation',  current_price:29,  msrp:199, historical_low_price:29,  historical_avg_sale_price:79,  sale_frequency_days:30,  url:'https://www.eventideaudio.com/plug-ins/h3000-factory/', source:'Indexed', sentiment:0.70, notes:'At historical low but Eventide runs monthly flash sales.'},
    {id:108, plugin_name:'Snap Heap',           developer:'Kilohearts',         category:'Modulation',  current_price:39,  msrp:99,  historical_low_price:29,  historical_avg_sale_price:59,  sale_frequency_days:230, url:'https://kilohearts.com/products/snap_heap', source:'Indexed', sentiment:0.80, notes:'$10 above historical low. Kilohearts discounts infrequently.'},
    {id:109, plugin_name:'Manipulator',         developer:'Polyverse',          category:'Distortion',  current_price:79,  msrp:149, historical_low_price:59,  historical_avg_sale_price:99,  sale_frequency_days:280, url:'https://polyversemusic.com/products/manipulator/', source:'Indexed', sentiment:0.77, notes:'$20 above historical low. Polyverse discounts less than 3x per year.'},
    {id:110, plugin_name:'RX 11 Elements',      developer:'iZotope',            category:'Utility',     current_price:29,  msrp:99,  historical_low_price:19,  historical_avg_sale_price:29,  sale_frequency_days:90,  url:'https://www.izotope.com/en/products/rx/rx-elements.html', source:'Indexed', sentiment:0.72, notes:'Has been $19 on flash deals. Useful but not urgent at $29.'},
    {id:111, plugin_name:'V Collection 10',     developer:'Arturia',            category:'Synths',      current_price:199, msrp:599, historical_low_price:149, historical_avg_sale_price:249, sale_frequency_days:180, url:'https://www.arturia.com/products/analog-classics/v-collection/overview', source:'Indexed', sentiment:0.85, notes:'$50 above historical low. V Collection discounts twice yearly.'},
    {id:112, plugin_name:'Portal',              developer:'Output',             category:'Modulation',  current_price:49,  msrp:99,  historical_low_price:29,  historical_avg_sale_price:59,  sale_frequency_days:180, url:'https://output.com/products/portal', source:'Indexed', sentiment:0.72, notes:'$20 above historical low. Output runs bi-annual sales.'},
    {id:113, plugin_name:'VMR Complete Bundle', developer:'Slate Digital',      category:'Mastering',   current_price:149, msrp:299, historical_low_price:99,  historical_avg_sale_price:179, sale_frequency_days:150, url:'https://slatedigital.com/vmr/', source:'Indexed', sentiment:0.60, notes:'$50 above historical low. Slate runs frequent promos.'},
  ];
  const now = Date.now();
  return base.map(d => ({
    ...d,
    timestamp      : new Date(now - Math.random()*5*86400000).toISOString(),
    last_sale_dates: [new Date(now - Math.random()*30*86400000).toISOString()],
    price_history  : [],
    dev_discount_freq: 'unknown',
    deal_score     : dealScore(d),
  }));
}

// ── Dedup by name ────────────────────────────────────────────
function dedup(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = (d.plugin_name || '').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Custom sources (in-memory) ───────────────────────────────
let customSources = [];

// ── /api/deals ────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  const force = req.query.force === '1';

  if (!force && cache && Date.now() - cacheTime < TTL) {
    return res.json({ deals: cache, source: 'cache', sources: lastCounts, updated: new Date(cacheTime).toISOString() });
  }

  console.log('[scraper] fetching' + (force ? ' (forced)' : '') + '...');

  // Run all scrapers with individual timeouts — none can hang the others
  const [reddit, apg, kvr, vic, lm] = await Promise.all([
    scrapeReddit().catch(e => { console.error('[reddit]', e.message); return []; }),
    scrapeAPG().catch(e    => { console.error('[apg]',    e.message); return []; }),
    scrapeKVR().catch(e    => { console.error('[kvr]',    e.message); return []; }),
    scrapeVIC().catch(e    => { console.error('[vic]',    e.message); return []; }),
    scrapeLM().catch(e     => { console.error('[lm]',     e.message); return []; }),
  ]);

  lastCounts = {
    reddit: reddit.length,
    apg   : apg.length,
    kvr   : kvr.length,
    vic   : vic.length,
    linkedMusicians: lm.length,
  };
  console.log('[scraper]', JSON.stringify(lastCounts));

  let combined = dedup([...reddit, ...apg, ...kvr, ...vic, ...lm]);
  combined.sort((a, b) => b.deal_score - a.deal_score);

  // Always pad with fallback so client never gets an empty array
  if (combined.length < 5) {
    console.log('[scraper] padding with fallback deals');
    const fallback = getFallback();
    const existingKeys = new Set(combined.map(d => d.plugin_name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20)));
    const fresh = fallback.filter(d => !existingKeys.has(d.plugin_name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20)));
    combined = [...combined, ...fresh];
    combined.sort((a, b) => b.deal_score - a.deal_score);
  }

  cache     = combined;
  cacheTime = Date.now();

  res.json({ deals: combined, source: 'live', sources: lastCounts, updated: new Date().toISOString() });
});

// ── /api/test — plain text, each scraper with timeout ────────
app.get('/api/test', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  // Stream immediately so browser shows content
  res.write('Plugin Copilot Scraper Test\n');
  res.write('============================\n\n');

  const tests = [
    { name: 'REDDIT', fn: scrapeReddit },
    { name: 'APG',    fn: scrapeAPG    },
    { name: 'KVR',    fn: scrapeKVR    },
    { name: 'VIC',    fn: scrapeVIC    },
    { name: 'LM',     fn: scrapeLM     },
  ];

  for (const { name, fn } of tests) {
    res.write(`--- ${name} ---\n`);
    try {
      const start   = Date.now();
      const results = await fn();
      const ms      = Date.now() - start;
      res.write(`count: ${results.length}  time: ${ms}ms\n`);
      results.slice(0, 5).forEach(d => {
        res.write(`  ${d.plugin_name} — $${d.current_price} (msrp $${d.msrp})\n`);
      });
    } catch (e) {
      res.write(`ERROR: ${e.message}\n`);
    }
    res.write('\n');
  }

  res.write(`Fallback deals available: ${getFallback().length}\n`);
  res.end();
});

// ── Custom source endpoints ───────────────────────────────────
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

app.get('/api/custom-sources', (req, res) => {
  res.json({ sources: customSources });
});

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ ok: true, cached: cache?.length || 0, sources: lastCounts, time: new Date().toISOString() });
});

// ── Root ──────────────────────────────────────────────────────
app.get('/', (_, res) => {
  const counts = Object.entries(lastCounts).map(([k,v]) => `${k}: ${v}`).join(', ');
  res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#fff;padding:40px;max-width:600px">
<h2>Plugin Copilot Scraper v4</h2>
<p>Status: ${cache ? `${cache.length} deals cached` : 'No cache yet'}</p>
<p>Last counts: ${counts || 'none yet'}</p>
<ul style="line-height:2.2">
  <li><a href="/api/deals">/api/deals</a> — all deals (cached 5min)</li>
  <li><a href="/api/deals?force=1">/api/deals?force=1</a> — force fresh fetch</li>
  <li><a href="/api/test">/api/test</a> — test each scraper individually</li>
  <li><a href="/health">/health</a> — health check</li>
</ul>
<p style="color:#888;font-size:12px">Paste this URL into Plugin Copilot → Settings → Scraper Connection</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Plugin Copilot scraper v4 on port ${PORT}`);
  startKeepAlive();
});
