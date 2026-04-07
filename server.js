/**
 * Plugin Copilot — Render.com Scraper
 * ─────────────────────────────────────
 * Deploy to Render free tier:
 *   1. Push this file + package.json to a GitHub repo
 *   2. render.com → New → Web Service → connect that repo
 *   3. Build command:  npm install
 *   4. Start command:  node server.js
 *   5. Instance type:  Free
 *   6. Deploy — your URL will be https://your-name.onrender.com
 *
 * Paste that URL into Plugin Copilot → Settings → Scraper Connection.
 * The app appends /api/deals automatically.
 *
 * Render free tier spins down after 15 minutes of inactivity.
 * First request after sleep takes 30–60 seconds.
 * Plugin Copilot handles this — just wait or refresh once if needed.
 * The self-ping below keeps it alive between active sessions.
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));

// ── Self-ping keep-alive ────────────────────────────────────
// Pings /health every 13 minutes while running.
// Render.com sets RENDER_EXTERNAL_URL automatically — we use it
// to know our own public URL without hardcoding anything.
function startKeepAlive() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/health`
    : null;

  if (!selfUrl) {
    console.log('[keep-alive] not on Render, skipping self-ping');
    return;
  }

  setInterval(async () => {
    try {
      await fetch(selfUrl);
      console.log('[keep-alive] pinged', new Date().toISOString());
    } catch(e) {
      console.log('[keep-alive] ping failed:', e.message);
    }
  }, 13 * 60 * 1000);
}

// ── Cache — 5 minute TTL ────────────────────────────────────
let cache     = null;
let cacheTime = 0;
const TTL     = 5 * 60 * 1000;

// ── Category classifier ─────────────────────────────────────
const CATS = {
  'Reverb'      : ['reverb',' verb ','room reverb','hall reverb','plate reverb','spring reverb','convolution'],
  'Delay'       : ['delay','echo','tape delay','ping pong'],
  'Compression' : ['compressor','compression','limiter','transient','1176','la-2a','vca comp','bus comp','ssl bus'],
  'EQ'          : [' eq ',' eq,','equalizer','equaliser','pultec','api 550','neve 1073','parametric'],
  'Distortion'  : ['distortion','saturation','overdrive','fuzz','clipper','harmonic exciter','tape sat','waveshaper'],
  'Modulation'  : ['chorus','flanger','phaser','tremolo','vibrato','modulation','rotary','leslie','ensemble','auto-pan'],
  'Synths'      : ['synth','synthesizer','wavetable','fm synth','analog synth','serum','massive','vital','subtractive'],
  'Instruments' : ['piano','guitar','bass','drum','orchestr','strings','brass','woodwind','kontakt','sample library','rompler'],
  'Mastering'   : ['mastering','master bus','loudness','metering','stereo imager','lufs','true peak','mid-side'],
  'Utility'     : ['tuner','pitch shift','utility','spectrum analyzer','noise reduction','restoration','midi tool']
};

function classify(text) {
  const lo = (' ' + text + ' ').toLowerCase();
  for (const [cat, kws] of Object.entries(CATS))
    if (kws.some(k => lo.includes(k))) return cat;
  return 'Other';
}

function extractPrice(text) {
  const all = [...text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)]
    .map(m => parseFloat(m[1]))
    .filter(p => p > 0 && p < 1000);
  return all.length ? Math.min(...all) : null;
}

function extractMSRP(text) {
  const m = text.match(
    /(?:was|reg(?:ular)?|msrp|rrp|retail|valued? at|worth)\s*:?\s*\$\s*(\d+(?:\.\d{1,2})?)/i
  );
  return m ? parseFloat(m[1]) : null;
}

function sentiment(text) {
  const lo = text.toLowerCase();
  let s = 0.5;
  ['great','excellent','best','worth','buy','steal','deal','love','finally','perfect','recommended']
    .forEach(w => { if (lo.includes(w)) s += 0.04; });
  ['avoid','skip','bad','meh','buggy','overpriced','not worth','disappointing','broken']
    .forEach(w => { if (lo.includes(w)) s -= 0.06; });
  return parseFloat(Math.max(0, Math.min(1, s)).toFixed(2));
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

// ── Reddit ──────────────────────────────────────────────────
async function scrapeReddit() {
  const res  = await fetch(
    'https://www.reddit.com/r/AudioProductionDeals/new.json?limit=50',
    { headers: { 'User-Agent': 'PluginCopilot/1.0 render-scraper' } }
  );
  const json = await res.json();

  return json.data.children.map(({ data: p }) => {
    const text  = `${p.title} ${p.selftext || ''}`;
    const price = extractPrice(p.title) ?? extractPrice(p.selftext || '');
    if (!price || price < 1) return null;

    const msrp = extractMSRP(text) ?? price * 2;
    const name = p.title.replace(/[\[\]()]/g,'').split(/[–\-:|@\/]/)[0].trim().slice(0, 60);

    const d = {
      id                        : uid(),
      plugin_name               : name,
      developer                 : 'Various',
      category                  : classify(text),
      current_price             : price,
      msrp,
      historical_low_price      : price,
      historical_avg_sale_price : Math.round(msrp * 0.65),
      last_sale_dates           : [new Date(p.created_utc * 1000).toISOString()],
      sale_frequency_days       : 120,
      url                       : `https://reddit.com${p.permalink}`,
      source                    : 'Reddit r/AudioProductionDeals',
      timestamp                 : new Date(p.created_utc * 1000).toISOString(),
      price_history             : [msrp, Math.round(msrp * 0.8), price],
      dev_discount_freq         : 'unknown',
      sentiment                 : sentiment(text),
      notes                     : (p.selftext || '').slice(0, 200)
    };
    d.deal_score = dealScore(d);
    return d;
  }).filter(Boolean);
}

// ── KVR Audio ───────────────────────────────────────────────
async function scrapeKVR() {
  const url = 'https://www.kvraudio.com/forum/viewtopic.php?t=262151&start=25500';
  const res  = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept'    : 'text/html,application/xhtml+xml'
    }
  });
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  $('div.content').each((_, el) => {
    const text  = $(el).text().replace(/\s+/g, ' ').trim();
    const price = extractPrice(text);
    if (!price || price < 1 || price > 600) return;

    const lines = text.split(/[\n.!]/);
    const name  = (lines.find(l => l.trim().length > 4 && l.trim().length < 80) || text).trim().slice(0, 60);
    const msrp  = extractMSRP(text) ?? price * 2;
    const link  = $(el).find('a[href*="http"]').first().attr('href') || url;

    const d = {
      id                        : uid(),
      plugin_name               : name,
      developer                 : 'Various',
      category                  : classify(text),
      current_price             : price,
      msrp,
      historical_low_price      : price,
      historical_avg_sale_price : Math.round(msrp * 0.6),
      last_sale_dates           : [new Date().toISOString()],
      sale_frequency_days       : 90,
      url                       : link.startsWith('http') ? link : `https://kvraudio.com${link}`,
      source                    : 'KVR Audio',
      timestamp                 : new Date().toISOString(),
      price_history             : [msrp, price],
      dev_discount_freq         : 'unknown',
      sentiment                 : sentiment(text),
      notes                     : text.slice(0, 200)
    };
    d.deal_score = dealScore(d);
    deals.push(d);
  });

  return deals.slice(0, 20);
}

// ── VI-Control ──────────────────────────────────────────────
async function scrapeVIControl() {
  const url = 'https://vi-control.net/community/forums/deals-deals-deals.138/';
  const res  = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PluginCopilot/1.0)' }
  });
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  $('a.structItem-title').each((_, el) => {
    const title = $(el).text().trim();
    const href  = $(el).attr('href') || '';
    const price = extractPrice(title);
    if (!price || price < 1) return;

    const msrp = extractMSRP(title) ?? price * 2;

    const d = {
      id                        : uid(),
      plugin_name               : title.slice(0, 60),
      developer                 : 'Various',
      category                  : classify(title),
      current_price             : price,
      msrp,
      historical_low_price      : price,
      historical_avg_sale_price : Math.round(msrp * 0.6),
      last_sale_dates           : [new Date().toISOString()],
      sale_frequency_days       : 150,
      url                       : href.startsWith('http') ? href : `https://vi-control.net${href}`,
      source                    : 'VI-Control',
      timestamp                 : new Date().toISOString(),
      price_history             : [msrp, price],
      dev_discount_freq         : 'unknown',
      sentiment                 : 0.6,
      notes                     : title
    };
    d.deal_score = dealScore(d);
    deals.push(d);
  });

  return deals.slice(0, 15);
}

// ── LinkedMusicians ─────────────────────────────────────────
async function scrapeLinkedMusicians() {
  const url = 'https://linkedmusicians.com/forums/forum/deals/virtual-instruments-vsts-effects-plugins-sample-libraries/';
  const res  = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept'    : 'text/html'
    }
  });
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  const selectors = [
    'a.topictitle', '.topic-title a', 'td.topic a',
    'h2.topic-title a', 'a[href*="/viewtopic"]', '.post-title a', 'li.row a'
  ];

  let found = false;
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const title = $(el).text().trim();
      const href  = $(el).attr('href') || '';
      if (title.length < 5) return;
      const price = extractPrice(title);
      if (!price || price < 1) return;
      found = true;

      const msrp = extractMSRP(title) ?? price * 2;

      const d = {
        id                        : uid(),
        plugin_name               : title.slice(0, 60),
        developer                 : 'Various',
        category                  : classify(title),
        current_price             : price,
        msrp,
        historical_low_price      : price,
        historical_avg_sale_price : Math.round(msrp * 0.6),
        last_sale_dates           : [new Date().toISOString()],
        sale_frequency_days       : 160,
        url                       : href.startsWith('http') ? href : `https://linkedmusicians.com${href}`,
        source                    : 'LinkedMusicians',
        timestamp                 : new Date().toISOString(),
        price_history             : [msrp, price],
        dev_discount_freq         : 'unknown',
        sentiment                 : 0.6,
        notes                     : title
      };
      d.deal_score = dealScore(d);
      deals.push(d);
    });
    if (found) break;
  }

  return deals.slice(0, 15);
}

// ── Deduplicate ─────────────────────────────────────────────
function dedup(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = d.plugin_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Routes ──────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  if (cache && Date.now() - cacheTime < TTL) {
    return res.json({ deals: cache, source: 'cache', updated: new Date(cacheTime).toISOString() });
  }

  console.log('[scraper] fetching all sources...');

  const [reddit, kvr, vic, lm] = await Promise.all([
    scrapeReddit().catch(e         => { console.error('[reddit]', e.message); return []; }),
    scrapeKVR().catch(e            => { console.error('[kvr]',    e.message); return []; }),
    scrapeVIControl().catch(e      => { console.error('[vic]',    e.message); return []; }),
    scrapeLinkedMusicians().catch(e => { console.error('[lm]',    e.message); return []; })
  ]);

  const combined = dedup([...reddit, ...kvr, ...vic, ...lm]);
  combined.sort((a, b) => b.deal_score - a.deal_score);

  console.log(`[scraper] reddit:${reddit.length} kvr:${kvr.length} vic:${vic.length} lm:${lm.length} total:${combined.length}`);

  cache     = combined;
  cacheTime = Date.now();

  res.json({
    deals  : combined,
    source : 'live',
    sources: { reddit: reddit.length, kvr: kvr.length, vic: vic.length, linkedMusicians: lm.length },
    updated: new Date().toISOString()
  });
});

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'plugin-copilot-scraper', time: new Date().toISOString() });
});

app.get('/', (_, res) => {
  res.send(`
    <html><body style="font-family:monospace;background:#0e0d0b;color:#c4b49a;padding:40px;max-width:600px">
    <h2 style="color:#d4784a">Plugin Copilot Scraper</h2>
    <p>Running on Render. Endpoints:</p>
    <ul style="line-height:2">
      <li><a href="/api/deals" style="color:#d4784a">/api/deals</a> — live deal data</li>
      <li><a href="/health"   style="color:#d4784a">/health</a> — status check</li>
    </ul>
    <p style="color:#7a7268;margin-top:24px">
      Copy this page's base URL and paste it into<br>
      Plugin Copilot → Settings → Scraper Connection
    </p>
    </body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`Plugin Copilot scraper running on port ${PORT}`);
  startKeepAlive();
});
