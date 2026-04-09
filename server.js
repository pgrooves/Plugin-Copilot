/**
 * Plugin Copilot — Render.com Scraper (v2)
 * ─────────────────────────────────────────
 * Render deploy settings:
 *   Build command:  npm install
 *   Start command:  node server.js
 *   Instance type:  Free
 *
 * After deploy paste your Render URL into
 * Plugin Copilot → Settings → Scraper Connection
 *
 * Debug endpoint: /api/debug?source=reddit|kvr|vic|lm
 * Use this to verify each scraper is working independently.
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));

// ── Cache ───────────────────────────────────────────────────
let cache     = null;
let cacheTime = 0;
let lastCounts = {};
const TTL     = 5 * 60 * 1000;

// ── Keep-alive ──────────────────────────────────────────────
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  setInterval(() => {
    fetch(`${url}/health`).catch(() => {});
    console.log('[keep-alive]', new Date().toISOString());
  }, 13 * 60 * 1000);
}

// ── Category classifier ─────────────────────────────────────
const CATS = {
  'Reverb'      : ['reverb','room reverb','hall reverb','plate reverb','spring reverb','convolution ir','impulse response'],
  'Delay'       : ['delay','echo','tape delay','ping pong delay'],
  'Compression' : ['compressor','compression',' limiter','bus comp','1176','la-2a','ssl bus','vca comp','optical comp'],
  'EQ'          : ['equalizer','equaliser','pultec','api 550','neve 1073','parametric eq','graphic eq',' eq '],
  'Distortion'  : ['distortion','saturation','overdrive','fuzz','clipper','harmonic exciter','tape saturation','waveshaper'],
  'Modulation'  : ['chorus','flanger','phaser','tremolo','vibrato','rotary','leslie','ensemble','auto-pan'],
  'Synths'      : ['synthesizer','wavetable synth','fm synth','analog synth','serum','massive','vital','subtractive'],
  'Instruments' : ['piano','electric piano','guitar','bass guitar','drum kit','orchestral','strings','brass','woodwind','kontakt','sample library','rompler'],
  'Mastering'   : ['mastering','master bus','loudness meter','stereo imager','lufs','true peak','mid-side','brickwall'],
  'Utility'     : ['tuner','pitch shifter','spectrum analyzer','noise reduction','audio restoration','midi tool']
};

function classify(text) {
  const lo = (' ' + text + ' ').toLowerCase();
  for (const [cat, kws] of Object.entries(CATS))
    if (kws.some(k => lo.includes(k))) return cat;
  return 'Other';
}

// ── Price parsing ───────────────────────────────────────────
function extractSalePrice(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/g)]
    .map(m => parseFloat(m[1]))
    .filter(p => p >= 3 && p <= 999);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  // With multiple prices, sale price is the smallest valid one
  return Math.min(...matches);
}

function extractMSRP(text) {
  if (!text) return null;
  // Explicit keyword
  const kw = text.match(
    /(?:was|reg(?:ular)?|msrp|rrp|retail|orig(?:inal)?|norm(?:ally)?|full price|valued? at)\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)/i
  );
  if (kw) return parseFloat(kw[1]);
  // "$X off $Y" pattern
  const off = text.match(/\$(\d{1,3})\s+off\s+\$(\d{1,3})/i);
  if (off) return parseFloat(off[2]);
  // "$sale/$msrp" slash pattern
  const slash = text.match(/\$(\d{1,3})\s*[\/|]\s*\$(\d{1,3})/);
  if (slash) {
    const a = parseFloat(slash[1]), b = parseFloat(slash[2]);
    if (b > a) return b;
  }
  return null;
}

function extractDeveloper(title) {
  const bracket = title.match(/^\[([^\]]{2,40})\]/);
  if (bracket) return bracket[1].trim();
  const dash = title.match(/^([A-Z][^-–|$\d]{2,25})\s*[-–]/);
  if (dash) return dash[1].trim();
  return 'Various';
}

function cleanName(title) {
  return title
    .replace(/^\[.*?\]\s*/,'')
    .replace(/\$[\d.,]+[^\s]*/g,'')
    .replace(/\((?:reg|was|msrp|retail|save|off)[^)]*\)/gi,'')
    .replace(/[-–|].*$/,'')
    .replace(/\s{2,}/g,' ')
    .trim()
    .slice(0, 60) || title.slice(0, 60);
}

function sentiment(text) {
  const lo = text.toLowerCase();
  let s = 0.5;
  ['great','excellent','best','worth it','buy','steal','deal','love','finally','recommended','essential']
    .forEach(w => { if (lo.includes(w)) s += 0.04; });
  ['avoid','skip','bad','meh','buggy','overpriced','not worth','disappointing','broken','crashes']
    .forEach(w => { if (lo.includes(w)) s -= 0.06; });
  return parseFloat(Math.max(0.1, Math.min(0.95, s)).toFixed(2));
}

function dealScore(d) {
  const disc    = d.msrp > 0 ? Math.min((d.msrp - d.current_price) / d.msrp * 100, 100) : 0;
  const vsLow   = d.current_price <= d.historical_low_price ? 100
    : d.current_price <= d.historical_avg_sale_price ? 60 : 20;
  const rarity  = Math.min(d.sale_frequency_days / 365, 1) * 100;
  const days    = d.last_sale_dates.length
    ? (Date.now() - new Date(d.last_sale_dates[0])) / 86400000 : 999;
  const recency = Math.min(days / (d.sale_frequency_days || 90), 1) * 100;
  const sent    = (d.sentiment || 0.5) * 100;
  return Math.min(Math.round(disc*.3 + vsLow*.3 + rarity*.2 + recency*.1 + sent*.1), 100);
}

let _uid = 1000;
function uid() { return ++_uid; }

function buildDeal(fields) {
  const price = fields.current_price;
  const msrp  = fields.msrp && fields.msrp > price ? fields.msrp : price * 2;
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
    price_history             : [msrp, price],
    dev_discount_freq         : 'unknown',
    sentiment                 : 0.5,
    notes                     : '',
    ...fields,
    msrp
  };
  d.deal_score = dealScore(d);
  return d;
}

// ── SCRAPER 1: Reddit ───────────────────────────────────────
async function scrapeReddit() {
  const res = await fetch(
    'https://www.reddit.com/r/AudioProductionDeals/new.json?limit=50&raw_json=1',
    {
      headers: {
        'User-Agent': 'web:plugin-copilot-deals-aggregator:v2.0 (open source deal tracker)',
        'Accept'    : 'application/json'
      }
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Reddit HTTP ${res.status}: ${body.slice(0,200)}`);
  }

  const json = await res.json();

  if (!json?.data?.children?.length) {
    throw new Error(`Reddit returned no children: ${JSON.stringify(json).slice(0,200)}`);
  }

  const deals = [];
  for (const { data: p } of json.data.children) {
    if (p.stickied) continue;
    if (p.link_flair_text && /discussion|question|meta|mod|weekly/i.test(p.link_flair_text)) continue;

    const text  = `${p.title} ${p.selftext || ''}`;
    const price = extractSalePrice(p.title) ?? extractSalePrice(p.selftext || '');
    if (!price) continue;

    const msrp = extractMSRP(text);

    // For link posts (not self posts), p.url is the actual deal page
    const dealUrl = (!p.is_self && p.url && !p.url.includes('reddit.com'))
      ? p.url
      : `https://reddit.com${p.permalink}`;

    deals.push(buildDeal({
      plugin_name  : cleanName(p.title),
      developer    : extractDeveloper(p.title),
      category     : classify(text),
      current_price: price,
      msrp         : msrp || price * 2,
      url          : dealUrl,
      source       : 'Reddit r/AudioProductionDeals',
      timestamp    : new Date(p.created_utc * 1000).toISOString(),
      last_sale_dates: [new Date(p.created_utc * 1000).toISOString()],
      sentiment    : sentiment(text),
      notes        : (p.selftext || '').slice(0, 300)
    }));
  }

  return deals;
}

// ── SCRAPER 2: KVR Audio ────────────────────────────────────
async function scrapeKVR() {
  const url = 'https://www.kvraudio.com/forum/viewtopic.php?t=262151&start=25500';
  const res = await fetch(url, {
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'         : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control'  : 'no-cache'
    }
  });

  if (!res.ok) throw new Error(`KVR HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  $('div.postbody').each((_, postBody) => {
    // Remove quoted content to avoid picking up prices from quotes
    const clone = $(postBody).clone();
    clone.find('blockquote, .quotecontent').remove();

    const contentEl = clone.find('div.content');
    const text = (contentEl.length ? contentEl : clone).text().replace(/\s+/g,' ').trim();

    const price = extractSalePrice(text);
    if (!price || price > 600) return;

    const msrp = extractMSRP(text) ?? price * 2;
    if (msrp <= price) return; // skip if we can't establish a real discount

    // First line that looks like a product name
    const lines = text.split(/[.!\n]/).map(l=>l.trim()).filter(l=>l.length>4&&l.length<100);
    let name = (lines[0] || text).replace(/\$[\d.]+/g,'').replace(/\s{2,}/g,' ').trim().slice(0,60);

    // Find best URL — prefer direct product links over KVR internal
    let dealUrl = url;
    (contentEl.length ? contentEl : clone).find('a[href^="http"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes('kvraudio.com') && !href.includes('reddit.com')) {
        dealUrl = href;
        return false;
      }
    });

    deals.push(buildDeal({
      plugin_name  : name,
      category     : classify(text),
      current_price: price,
      msrp,
      url          : dealUrl,
      source       : 'KVR Audio',
      sentiment    : sentiment(text),
      notes        : text.slice(0, 300)
    }));
  });

  return deals.slice(0, 25);
}

// ── SCRAPER 3: VI-Control ───────────────────────────────────
async function scrapeVIControl() {
  const url = 'https://vi-control.net/community/forums/deals-deals-deals.138/';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'    : 'text/html'
    }
  });

  if (!res.ok) throw new Error(`VI-Control HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  // XenForo 2: each thread row is .structItem--thread
  $('div.structItem--thread, li.structItem--thread').each((_, item) => {
    const titleEl  = $(item).find('.structItem-title');
    const allText  = titleEl.text().replace(/\s+/g,' ').trim();
    const linkEl   = titleEl.find('a').last();
    const href     = linkEl.attr('href') || '';
    const price    = extractSalePrice(allText);
    if (!price) return;

    const msrp = extractMSRP(allText) ?? price * 2;
    deals.push(buildDeal({
      plugin_name  : cleanName(allText),
      category     : classify(allText),
      current_price: price,
      msrp,
      url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
      source       : 'VI-Control',
      notes        : allText
    }));
  });

  // Fallback: any thread link containing a price
  if (!deals.length) {
    $('a[href*="/community/threads/"]').each((_, el) => {
      const title = $(el).text().replace(/\s+/g,' ').trim();
      if (title.length < 8) return;
      const price = extractSalePrice(title);
      if (!price) return;
      const href = $(el).attr('href') || '';
      deals.push(buildDeal({
        plugin_name  : cleanName(title),
        category     : classify(title),
        current_price: price,
        msrp         : extractMSRP(title) ?? price * 2,
        url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
        source       : 'VI-Control',
        notes        : title
      }));
    });
  }

  return deals.slice(0, 20);
}

// ── SCRAPER 4: LinkedMusicians ──────────────────────────────
async function scrapeLinkedMusicians() {
  const url = 'https://linkedmusicians.com/forums/forum/deals/virtual-instruments-vsts-effects-plugins-sample-libraries/';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'    : 'text/html'
    }
  });

  if (!res.ok) throw new Error(`LinkedMusicians HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  // Try selectors in priority order
  const selectors = [
    'a.topictitle',
    'li.row > dl > dt > a',
    '.forumbg a.topictitle',
    'td.topic a.topictitle',
    'h2 > a[href*="viewtopic"]',
    'h3 > a[href*="viewtopic"]',
    'a[href*="viewtopic"]'
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const title = $(el).text().replace(/\s+/g,' ').trim();
      const href  = $(el).attr('href') || '';
      if (title.length < 8 || title.length > 200) return;
      const price = extractSalePrice(title);
      if (!price) return;
      deals.push(buildDeal({
        plugin_name  : cleanName(title),
        category     : classify(title),
        current_price: price,
        msrp         : extractMSRP(title) ?? price * 2,
        url          : href.startsWith('http') ? href : `https://linkedmusicians.com${href}`,
        source       : 'LinkedMusicians',
        notes        : title
      }));
    });
    if (deals.length) break;
  }

  return deals.slice(0, 20);
}

// ── Deduplicate ─────────────────────────────────────────────
function dedup(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = d.plugin_name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
    if (!key || key === 'unknown' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Routes ──────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  if (cache && Date.now() - cacheTime < TTL) {
    return res.json({ deals: cache, source: 'cache', sources: lastCounts, updated: new Date(cacheTime).toISOString() });
  }

  console.log('[scraper] fetching all sources...');

  const [reddit, kvr, vic, lm] = await Promise.all([
    scrapeReddit().catch(e        => { console.error('[reddit]', e.message); return []; }),
    scrapeKVR().catch(e           => { console.error('[kvr]',    e.message); return []; }),
    scrapeVIControl().catch(e     => { console.error('[vic]',    e.message); return []; }),
    scrapeLinkedMusicians().catch(e=> { console.error('[lm]',     e.message); return []; })
  ]);

  lastCounts = { reddit: reddit.length, kvr: kvr.length, vic: vic.length, linkedMusicians: lm.length };
  console.log('[scraper]', JSON.stringify(lastCounts));

  const combined = dedup([...reddit, ...kvr, ...vic, ...lm]);
  combined.sort((a, b) => b.deal_score - a.deal_score);

  cache     = combined;
  cacheTime = Date.now();

  res.json({ deals: combined, source: 'live', sources: lastCounts, updated: new Date().toISOString() });
});

app.get('/api/debug', async (req, res) => {
  const src = req.query.source || 'reddit';
  let result = [];
  try {
    if (src === 'reddit') result = await scrapeReddit();
    if (src === 'kvr')    result = await scrapeKVR();
    if (src === 'vic')    result = await scrapeVIControl();
    if (src === 'lm')     result = await scrapeLinkedMusicians();
  } catch(e) {
    return res.json({ error: e.message });
  }
  res.json({ source: src, count: result.length, first3: result.slice(0,3), names: result.map(d=>`${d.plugin_name} — $${d.current_price} (msrp $${d.msrp})`) });
});

app.get('/health', (_, res) => {
  res.json({ ok: true, cached: cache ? cache.length : 0, sources: lastCounts, time: new Date().toISOString() });
});

app.get('/', (_, res) => {
  res.send(`<html><body style="font-family:monospace;background:#0e0d0b;color:#c4b49a;padding:40px;max-width:600px;margin:0 auto">
    <h2 style="color:#d4784a">PLUGIN COPILOT SCRAPER v2</h2>
    <p style="color:#7a7268;margin-bottom:24px">Running on Render.com</p>
    <ul style="line-height:2.4">
      <li><a href="/api/deals" style="color:#d4784a">/api/deals</a> — all deals</li>
      <li><a href="/health" style="color:#d4784a">/health</a> — status</li>
      <li><a href="/api/debug?source=reddit" style="color:#d4784a">/api/debug?source=reddit</a></li>
      <li><a href="/api/debug?source=kvr" style="color:#d4784a">/api/debug?source=kvr</a></li>
      <li><a href="/api/debug?source=vic" style="color:#d4784a">/api/debug?source=vic</a></li>
      <li><a href="/api/debug?source=lm" style="color:#d4784a">/api/debug?source=lm</a></li>
    </ul>
    <p style="color:#484440;margin-top:32px;font-size:12px">Paste base URL into Plugin Copilot → Settings → Scraper Connection</p>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`Plugin Copilot scraper v2 on port ${PORT}`);
  startKeepAlive();
});
