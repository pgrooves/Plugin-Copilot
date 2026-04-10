/**
 * Plugin Copilot — Scraper Server v3
 * ────────────────────────────────────
 * Render.com deploy:
 *   Build command:  npm install
 *   Start command:  node server.js
 *   Instance type:  Free
 *
 * Key changes in v3:
 *  - AudioPluginGuy.com/deals is the master historical reference
 *  - All deals filtered to last 30 days
 *  - ?force=1 on /api/deals bypasses cache (triggered by user refresh)
 *  - Custom scrape URLs accepted via POST /api/custom-sources
 *  - Plugin name extraction completely rewritten — no more "u" or "three"
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Cache — only used when ?force is absent ─────────────────
let cache      = null;
let cacheTime  = 0;
let lastCounts = {};
const TTL      = 5 * 60 * 1000; // 5 min

// ── AudioPluginGuy historical index ────────────────────────
// Populated on first fetch, used to enrich all other deals
let apgIndex = {}; // keyed by normalized plugin name

// ── Keep-alive (Render free) ────────────────────────────────
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  setInterval(() => {
    fetch(`${url}/health`).catch(() => {});
    console.log('[keep-alive]', new Date().toISOString());
  }, 13 * 60 * 1000);
}

// ── 30-day cutoff ───────────────────────────────────────────
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
function isWithin30Days(isoString) {
  if (!isoString) return true; // unknown date — include it
  return (Date.now() - new Date(isoString).getTime()) <= THIRTY_DAYS_MS;
}

// ── Category classifier ─────────────────────────────────────
const CATS = {
  'Reverb'      : ['reverb','room reverb','hall reverb','plate reverb','spring reverb','convolution ir','impulse response'],
  'Delay'       : [' delay',' echo ','tape delay','ping pong delay'],
  'Compression' : ['compressor','compression',' limiter','bus comp','1176','la-2a','ssl bus','vca comp','optical comp'],
  'EQ'          : ['equalizer','equaliser','pultec','api 550','neve 1073','parametric eq','graphic eq',' eq '],
  'Distortion'  : ['distortion','saturation','overdrive',' fuzz ','clipper','harmonic exciter','tape saturation','waveshaper'],
  'Modulation'  : ['chorus','flanger','phaser','tremolo','vibrato','rotary speaker','leslie','ensemble','auto-pan'],
  'Synths'      : ['synthesizer','wavetable synth','fm synth','analog synth','serum','massive','vital','subtractive synth'],
  'Instruments' : ['piano','electric piano',' guitar','bass guitar','drum kit','orchestral','string library','brass','woodwind','kontakt library','sample library','rompler'],
  'Mastering'   : ['mastering','master bus','loudness meter','stereo imager','lufs','true peak','mid-side','brickwall'],
  'Utility'     : ['tuner','pitch shifter','spectrum analyzer','noise reduction','audio restoration','midi tool']
};

function classify(text) {
  const lo = (' ' + text + ' ').toLowerCase();
  for (const [cat, kws] of Object.entries(CATS))
    if (kws.some(k => lo.includes(k))) return cat;
  return 'Other';
}

// ── Price extraction ────────────────────────────────────────
function extractSalePrice(text) {
  if (!text) return null;
  // Match dollar amounts $3–$999, ignore cents-only like $0.99
  const matches = [...text.matchAll(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/g)]
    .map(m => parseFloat(m[1]))
    .filter(p => p >= 3 && p <= 999);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  return Math.min(...matches);
}

function extractMSRP(text) {
  if (!text) return null;
  const kw = text.match(
    /(?:was|reg(?:ular)?|msrp|rrp|retail price|orig(?:inal)?(?:\s+price)?|norm(?:ally)?|full price|valued? at|list(?:ed)? (?:at|price))\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)/i
  );
  if (kw) return parseFloat(kw[1]);
  const off = text.match(/\$(\d{1,3})\s+off\s+\$(\d{1,3})/i);
  if (off) return parseFloat(off[2]);
  const slash = text.match(/\$(\d{1,3})\s*[\/|]\s*\$(\d{1,3})/);
  if (slash) { const a = parseFloat(slash[1]), b = parseFloat(slash[2]); if (b > a) return b; }
  return null;
}

// ── Plugin name extraction ──────────────────────────────────
// This is the most critical function — must never return single letters,
// numbers, or common English words as plugin names.

const JUNK_NAMES = new Set([
  'u','v','w','x','y','z','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t',
  'one','two','three','four','five','six','seven','eight','nine','ten',
  'free','deal','sale','off','new','now','get','buy','the','and','for','its','has','via',
  'plugin','plugins','vst','vsti','au','aax','clap','daw','pro','plus','max','lite',
  'unknown','various','other','see','check','out','here','this','that'
]);

function isValidName(name) {
  if (!name) return false;
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
  if (clean.length < 3) return false;
  if (JUNK_NAMES.has(clean)) return false;
  // Reject if it's just numbers
  if (/^\d+$/.test(clean)) return false;
  // Reject if it's a single word under 3 chars
  if (clean.split(/\s+/).length === 1 && clean.length < 3) return false;
  return true;
}

function extractDeveloper(title) {
  // [Developer] format
  const bracket = title.match(/^\[([^\]]{2,40})\]/);
  if (bracket && bracket[1].length > 2) return bracket[1].trim();
  // "Developer - Plugin" or "Developer: Plugin"
  const dash = title.match(/^([A-Z][a-zA-Z\s&]{2,28})\s*[-–:]/);
  if (dash && dash[1].trim().length > 2) return dash[1].trim();
  return 'Various';
}

function cleanPluginName(raw) {
  if (!raw) return null;
  let name = raw
    // Remove bracketed developer prefix
    .replace(/^\s*\[.*?\]\s*/,'')
    // Remove price patterns anywhere in string
    .replace(/\$[\d,]+(?:\.\d{1,2})?/g,'')
    // Remove "X% off" patterns
    .replace(/\d+\s*%\s*off/gi,'')
    // Remove parenthetical price/discount notes
    .replace(/\((?:reg|was|msrp|retail|save|originally|now|only|just|on sale)[^)]*\)/gi,'')
    // Remove trailing dash/pipe and everything after
    .replace(/\s*[-–|—]\s*.{0,80}$/,'')
    // Remove leading/trailing punctuation
    .replace(/^[\s\-–|:,]+|[\s\-–|:,]+$/g,'')
    // Collapse whitespace
    .replace(/\s{2,}/g,' ')
    .trim();

  if (!isValidName(name)) return null;
  return name;
}

// ── Normalize name for matching/dedup ───────────────────────
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,25);
}

// ── Sentiment ───────────────────────────────────────────────
function sentiment(text) {
  const lo = text.toLowerCase();
  let s = 0.5;
  ['great','excellent','best','worth it','buy this','steal','hot deal','love','finally','recommended','essential','incredible']
    .forEach(w => { if (lo.includes(w)) s += 0.04; });
  ['avoid','skip','bad deal','meh','buggy','overpriced','not worth','disappointing','broken','crashes','garbage']
    .forEach(w => { if (lo.includes(w)) s -= 0.06; });
  return parseFloat(Math.max(0.1, Math.min(0.95, s)).toFixed(2));
}

// ── Deal score ──────────────────────────────────────────────
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

let _uid = 2000;
function uid() { return ++_uid; }

// Build a normalized deal object, enriched from APG index if available
function buildDeal(fields) {
  const price = fields.current_price;
  if (!price || price < 1) return null;

  // Look up this plugin in AudioPluginGuy historical data
  const apgKey = normalizeName(fields.plugin_name);
  const apg    = apgIndex[apgKey] || {};

  const msrp = fields.msrp && fields.msrp > price
    ? fields.msrp
    : apg.msrp && apg.msrp > price
      ? apg.msrp
      : price * 2;

  const histLow = apg.historical_low_price
    ? Math.min(apg.historical_low_price, price)
    : price;

  const histAvg = apg.historical_avg_sale_price
    || Math.round((histLow + msrp) * 0.5);

  const saleFreq = apg.sale_frequency_days || 120;

  const priceHistory = apg.price_history?.length >= 3
    ? apg.price_history
    : [msrp, Math.round(msrp * 0.8), price];

  const d = {
    id                        : uid(),
    plugin_name               : 'Unknown',
    developer                 : 'Various',
    category                  : 'Other',
    current_price             : price,
    msrp,
    historical_low_price      : histLow,
    historical_avg_sale_price : histAvg,
    last_sale_dates           : [new Date().toISOString()],
    sale_frequency_days       : saleFreq,
    url                       : '',
    source                    : '',
    timestamp                 : new Date().toISOString(),
    price_history             : priceHistory,
    price_history_dates       : apg.price_history_dates || [],
    dev_discount_freq         : apg.dev_discount_freq || 'unknown',
    sentiment                 : 0.5,
    notes                     : apg.notes || '',
    apg_url                   : apg.apg_url || null,
    ...fields,
    // These always come from APG enrichment, not overridden by fields
    msrp,
    historical_low_price      : histLow,
    historical_avg_sale_price : histAvg,
    sale_frequency_days       : saleFreq,
    price_history             : priceHistory,
    price_history_dates       : apg.price_history_dates || [],
  };

  if (!isValidName(d.plugin_name)) return null;
  d.deal_score = dealScore(d);
  return d;
}

// ── MASTER SOURCE: AudioPluginGuy.com/deals ─────────────────
// This is the primary historical reference. Scraped once per session
// or on force refresh. Populates apgIndex used to enrich all other deals.
async function scrapeAudioPluginGuy() {
  console.log('[apg] fetching AudioPluginGuy.com/deals...');
  const url = 'https://www.audiopluginguy.com/deals/';
  const res = await fetch(url, {
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'         : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer'        : 'https://www.google.com/'
    }
  });

  if (!res.ok) throw new Error(`APG HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];
  const newIndex = {};

  // AudioPluginGuy uses WordPress with deal cards
  // Each deal is typically an article or div with price info
  // Try multiple selectors for their layout
  const cardSelectors = [
    'article',
    '.deal-card',
    '.entry-content',
    '.post',
    '.deals-list article',
    '.elementor-post',
    '.jet-listing-grid__item'
  ];

  let found = false;
  for (const sel of cardSelectors) {
    const cards = $(sel);
    if (!cards.length) continue;

    cards.each((_, card) => {
      const $card = $(card);
      const fullText = $card.text().replace(/\s+/g,' ').trim();
      if (fullText.length < 20) return;

      // Get the title/heading
      const titleEl = $card.find('h1,h2,h3,h4,.entry-title,.post-title,.deal-title').first();
      let rawTitle = titleEl.text().trim() || fullText.slice(0, 80);

      const name = cleanPluginName(rawTitle);
      if (!name) return;

      const price = extractSalePrice(fullText);
      if (!price) return;

      const msrp = extractMSRP(fullText) ?? price * 2;

      // Get the deal link
      const linkEl = $card.find('a[href]').first();
      const dealUrl = linkEl.attr('href') || url;

      // Get date if present
      const dateEl = $card.find('time,.date,.post-date,.entry-date').first();
      const dateStr = dateEl.attr('datetime') || dateEl.text().trim();
      const timestamp = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

      if (!isWithin30Days(timestamp)) return;

      const deal = {
        name, price, msrp, dealUrl, timestamp,
        developer: extractDeveloper(rawTitle),
        category : classify(rawTitle + ' ' + fullText.slice(0, 200)),
        notes    : fullText.slice(0, 300)
      };

      deals.push(deal);

      // Index by normalized name for enrichment
      const key = normalizeName(name);
      if (key && !newIndex[key]) {
        newIndex[key] = {
          msrp,
          historical_low_price     : price,
          historical_avg_sale_price: Math.round((price + msrp) / 2),
          sale_frequency_days      : 120,
          price_history            : [msrp, Math.round(msrp*.8), price],
          price_history_dates      : [timestamp],
          dev_discount_freq        : 'unknown',
          apg_url                  : dealUrl
        };
      }
      found = true;
    });

    if (found) break;
  }

  // If card approach found nothing, fall back to link extraction
  if (!deals.length) {
    console.log('[apg] card selectors found nothing, trying link fallback');
    $('a[href*="audiopluginguy"]').each((_, el) => {
      const title = $(el).text().replace(/\s+/g,' ').trim();
      const href  = $(el).attr('href') || '';
      if (title.length < 5) return;
      const price = extractSalePrice(title);
      if (!price) return;
      const name = cleanPluginName(title);
      if (!name) return;
      const key = normalizeName(name);
      if (key && !newIndex[key]) {
        newIndex[key] = {
          msrp                     : price * 2,
          historical_low_price     : price,
          historical_avg_sale_price: Math.round(price * 1.5),
          sale_frequency_days      : 120,
          price_history            : [price * 2, price],
          price_history_dates      : [new Date().toISOString()],
          apg_url                  : href
        };
      }
    });
  }

  // Merge new data into global index
  Object.assign(apgIndex, newIndex);

  console.log(`[apg] indexed ${Object.keys(newIndex).length} plugins, ${deals.length} current deals`);

  // Return as deal objects for the current deals list
  return deals.map(d => buildDeal({
    plugin_name  : d.name,
    developer    : d.developer,
    category     : d.category,
    current_price: d.price,
    msrp         : d.msrp,
    url          : d.dealUrl,
    source       : 'AudioPluginGuy',
    timestamp    : d.timestamp,
    last_sale_dates: [d.timestamp],
    sentiment    : sentiment(d.notes),
    notes        : d.notes
  })).filter(Boolean);
}

// ── SCRAPER: Reddit ─────────────────────────────────────────
async function scrapeReddit() {
  const res = await fetch(
    'https://www.reddit.com/r/AudioProductionDeals/new.json?limit=100&raw_json=1',
    {
      headers: {
        'User-Agent': 'web:plugin-copilot-deals-aggregator:v3.0 (open source deal tracker)',
        'Accept'    : 'application/json'
      }
    }
  );

  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.data?.children?.length) throw new Error('Reddit: no children in response');

  const deals = [];
  for (const { data: p } of json.data.children) {
    if (p.stickied) continue;
    if (p.link_flair_text && /discussion|question|meta|mod|weekly|monthly/i.test(p.link_flair_text)) continue;

    const postDate = new Date(p.created_utc * 1000).toISOString();
    if (!isWithin30Days(postDate)) continue;

    const fullText = `${p.title} ${p.selftext || ''}`;
    const price    = extractSalePrice(p.title) ?? extractSalePrice(p.selftext || '');
    if (!price) continue;

    const rawName = cleanPluginName(p.title);
    if (!rawName) continue;

    const msrp    = extractMSRP(fullText);
    const dealUrl = (!p.is_self && p.url && !p.url.includes('reddit.com'))
      ? p.url : `https://reddit.com${p.permalink}`;

    const d = buildDeal({
      plugin_name  : rawName,
      developer    : extractDeveloper(p.title),
      category     : classify(fullText),
      current_price: price,
      msrp         : msrp || price * 2,
      url          : dealUrl,
      source       : 'Reddit r/AudioProductionDeals',
      timestamp    : postDate,
      last_sale_dates: [postDate],
      sentiment    : sentiment(fullText),
      notes        : (p.selftext || '').slice(0, 300)
    });
    if (d) deals.push(d);
  }

  return deals;
}

// ── SCRAPER: KVR Audio ──────────────────────────────────────
async function scrapeKVR() {
  const url = 'https://www.kvraudio.com/forum/viewtopic.php?t=262151&start=25500';
  const res = await fetch(url, {
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'         : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  if (!res.ok) throw new Error(`KVR HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  $('div.postbody').each((_, postBody) => {
    const clone = $(postBody).clone();
    clone.find('blockquote, .quotecontent, .sig').remove();

    const contentEl = clone.find('div.content');
    const text = (contentEl.length ? contentEl : clone).text().replace(/\s+/g,' ').trim();

    const price = extractSalePrice(text);
    if (!price || price > 600) return;

    const msrp = extractMSRP(text) ?? price * 2;
    if (msrp <= price) return;

    // Find plugin name — look for capitalized product-looking phrases
    // that appear before the price mention
    const beforePrice = text.split(/\$\d/)[0].trim();
    const sentences   = beforePrice.split(/[.!\n]/).map(s=>s.trim()).filter(s=>s.length>3&&s.length<120);
    let rawName = sentences[sentences.length-1] || sentences[0] || '';

    // Strip any remaining price artifacts from the name
    rawName = rawName.replace(/\$[\d.]+/g,'').replace(/\s{2,}/g,' ').trim();
    const name = cleanPluginName(rawName);
    if (!name) return;

    let dealUrl = url;
    (contentEl.length ? contentEl : clone).find('a[href^="http"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes('kvraudio.com') && !href.includes('reddit.com') && !href.includes('javascript')) {
        dealUrl = href;
        return false;
      }
    });

    const d = buildDeal({
      plugin_name  : name,
      category     : classify(text),
      current_price: price,
      msrp,
      url          : dealUrl,
      source       : 'KVR Audio',
      sentiment    : sentiment(text),
      notes        : text.slice(0, 300)
    });
    if (d) deals.push(d);
  });

  return deals.slice(0, 25);
}

// ── SCRAPER: VI-Control ─────────────────────────────────────
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

  $('div.structItem--thread, li.structItem--thread').each((_, item) => {
    const titleEl = $(item).find('.structItem-title');
    const allText = titleEl.text().replace(/\s+/g,' ').trim();
    const href    = titleEl.find('a').last().attr('href') || '';
    const price   = extractSalePrice(allText);
    if (!price) return;

    const name = cleanPluginName(allText);
    if (!name) return;

    // Get post date if available
    const dateEl  = $(item).find('time').first();
    const dateStr = dateEl.attr('datetime') || '';
    if (dateStr && !isWithin30Days(dateStr)) return;

    const d = buildDeal({
      plugin_name  : name,
      category     : classify(allText),
      current_price: price,
      msrp         : extractMSRP(allText) ?? price * 2,
      url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
      source       : 'VI-Control',
      timestamp    : dateStr || new Date().toISOString(),
      last_sale_dates: [dateStr || new Date().toISOString()],
      notes        : allText
    });
    if (d) deals.push(d);
  });

  if (!deals.length) {
    $('a[href*="/community/threads/"]').each((_, el) => {
      const title = $(el).text().replace(/\s+/g,' ').trim();
      if (title.length < 8) return;
      const price = extractSalePrice(title);
      if (!price) return;
      const name = cleanPluginName(title);
      if (!name) return;
      const href = $(el).attr('href') || '';
      const d = buildDeal({
        plugin_name  : name,
        category     : classify(title),
        current_price: price,
        msrp         : extractMSRP(title) ?? price * 2,
        url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
        source       : 'VI-Control',
        notes        : title
      });
      if (d) deals.push(d);
    });
  }

  return deals.slice(0, 20);
}

// ── SCRAPER: LinkedMusicians ────────────────────────────────
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

  const selectors = ['a.topictitle','li.row > dl > dt > a','.forumbg a.topictitle','h2 > a[href*="viewtopic"]','a[href*="viewtopic"]'];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const title = $(el).text().replace(/\s+/g,' ').trim();
      const href  = $(el).attr('href') || '';
      if (title.length < 8 || title.length > 200) return;
      const price = extractSalePrice(title);
      if (!price) return;
      const name = cleanPluginName(title);
      if (!name) return;
      const d = buildDeal({
        plugin_name  : name,
        category     : classify(title),
        current_price: price,
        msrp         : extractMSRP(title) ?? price * 2,
        url          : href.startsWith('http') ? href : `https://linkedmusicians.com${href}`,
        source       : 'LinkedMusicians',
        notes        : title
      });
      if (d) deals.push(d);
    });
    if (deals.length) break;
  }

  return deals.slice(0, 20);
}

// ── SCRAPER: Custom user-added URLs ─────────────────────────
// Stored in memory — persists until Render restarts
let customSources = [];

async function scrapeCustomUrl(sourceConfig) {
  const { url, name, selector } = sourceConfig;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'    : 'text/html'
    }
  });

  if (!res.ok) throw new Error(`Custom source ${url} HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  // Use user-provided selector, or try common patterns
  const sel = selector || 'article,h2 a,.post-title a,a[href*="deal"],a[href*="sale"]';
  $(sel).each((_, el) => {
    const text = $(el).text().replace(/\s+/g,' ').trim();
    if (text.length < 5) return;
    const price = extractSalePrice(text);
    if (!price) return;
    const pluginName = cleanPluginName(text);
    if (!pluginName) return;
    const href = $(el).attr('href') || $(el).find('a').first().attr('href') || url;
    const d = buildDeal({
      plugin_name  : pluginName,
      category     : classify(text),
      current_price: price,
      msrp         : extractMSRP(text) ?? price * 2,
      url          : href.startsWith('http') ? href : new URL(href, url).href,
      source       : name || url,
      notes        : text.slice(0, 300)
    });
    if (d) deals.push(d);
  });

  return deals.slice(0, 30);
}

// ── Deduplicate ─────────────────────────────────────────────
function dedup(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = normalizeName(d.plugin_name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── /api/deals ──────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';

  // Serve cache unless force refresh
  if (!force && cache && Date.now() - cacheTime < TTL) {
    return res.json({
      deals  : cache,
      source : 'cache',
      sources: lastCounts,
      updated: new Date(cacheTime).toISOString(),
      window : '30 days'
    });
  }

  if (force) console.log('[scraper] force refresh requested');
  console.log('[scraper] fetching all sources...');

  // Always scrape APG first — it populates the index used by all other scrapers
  const apgDeals = await scrapeAudioPluginGuy().catch(e => {
    console.error('[apg]', e.message);
    return [];
  });

  // Then scrape all other sources in parallel
  const [reddit, kvr, vic, lm, ...customResults] = await Promise.all([
    scrapeReddit().catch(e        => { console.error('[reddit]', e.message); return []; }),
    scrapeKVR().catch(e           => { console.error('[kvr]',    e.message); return []; }),
    scrapeVIControl().catch(e     => { console.error('[vic]',    e.message); return []; }),
    scrapeLinkedMusicians().catch(e=> { console.error('[lm]',    e.message); return []; }),
    ...customSources.map(src => scrapeCustomUrl(src).catch(e => {
      console.error(`[custom:${src.name}]`, e.message); return [];
    }))
  ]);

  lastCounts = {
    apg           : apgDeals.length,
    reddit        : reddit.length,
    kvr           : kvr.length,
    vic           : vic.length,
    linkedMusicians: lm.length,
    custom        : customResults.reduce((s,r) => s + r.length, 0)
  };
  console.log('[scraper]', JSON.stringify(lastCounts));

  // APG deals take priority (most reliable), then others
  const combined = dedup([...apgDeals, ...reddit, ...kvr, ...vic, ...lm, ...customResults.flat()]);
  combined.sort((a, b) => b.deal_score - a.deal_score);

  cache     = combined;
  cacheTime = Date.now();

  res.json({
    deals  : combined,
    source : 'live',
    sources: lastCounts,
    updated: new Date().toISOString(),
    window : '30 days'
  });
});

// ── /api/custom-sources — add a URL to scrape ───────────────
// POST { url, name, selector? }
app.post('/api/custom-sources', (req, res) => {
  const { url, name, selector } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }

  const existing = customSources.find(s => s.url === url);
  if (existing) return res.json({ ok: true, message: 'already exists', sources: customSources });

  customSources.push({ url, name: name || url, selector: selector || null });
  console.log('[custom-sources] added:', url);
  cache = null; // invalidate cache so next fetch includes new source
  res.json({ ok: true, sources: customSources });
});

// ── /api/custom-sources DELETE ──────────────────────────────
app.delete('/api/custom-sources', (req, res) => {
  const { url } = req.body || {};
  customSources = customSources.filter(s => s.url !== url);
  cache = null;
  res.json({ ok: true, sources: customSources });
});

// ── /api/custom-sources GET ─────────────────────────────────
app.get('/api/custom-sources', (req, res) => {
  res.json({ sources: customSources });
});

// ── /api/debug ──────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const src = req.query.source || 'apg';
  let result = [];
  try {
    if (src === 'apg')    result = await scrapeAudioPluginGuy();
    if (src === 'reddit') result = await scrapeReddit();
    if (src === 'kvr')    result = await scrapeKVR();
    if (src === 'vic')    result = await scrapeVIControl();
    if (src === 'lm')     result = await scrapeLinkedMusicians();
  } catch(e) {
    return res.json({ error: e.message, stack: e.stack?.slice(0,500) });
  }
  res.json({
    source : src,
    count  : result.length,
    names  : result.map(d => `${d.plugin_name} — $${d.current_price} (msrp $${d.msrp})`),
    first3 : result.slice(0,3)
  });
});

// ── /api/apg-index ──────────────────────────────────────────
app.get('/api/apg-index', (req, res) => {
  res.json({ count: Object.keys(apgIndex).length, sample: Object.entries(apgIndex).slice(0,5) });
});

// ── /health ─────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ ok: true, cached: cache?.length || 0, apgIndexed: Object.keys(apgIndex).length, sources: lastCounts, time: new Date().toISOString() });
});

// ── / root ──────────────────────────────────────────────────
app.get('/', (_, res) => {
  res.send(`<html><body style="font-family:monospace;background:#0e0d0b;color:#c4b49a;padding:40px;max-width:640px;margin:0 auto">
<h2 style="color:#d4784a;letter-spacing:.1em">PLUGIN COPILOT SCRAPER v3</h2>
<p style="color:#7a7268;margin-bottom:24px">Running on Render.com · AudioPluginGuy.com as master reference</p>
<ul style="line-height:2.4;color:#c4b49a">
  <li><a href="/api/deals" style="color:#d4784a">/api/deals</a> — all deals (cached)</li>
  <li><a href="/api/deals?force=1" style="color:#d4784a">/api/deals?force=1</a> — force fresh scrape</li>
  <li><a href="/health" style="color:#d4784a">/health</a> — status + cache count</li>
  <li><a href="/api/apg-index" style="color:#d4784a">/api/apg-index</a> — AudioPluginGuy index</li>
  <li><a href="/api/debug?source=apg" style="color:#d4784a">/api/debug?source=apg</a></li>
  <li><a href="/api/debug?source=reddit" style="color:#d4784a">/api/debug?source=reddit</a></li>
  <li><a href="/api/debug?source=kvr" style="color:#d4784a">/api/debug?source=kvr</a></li>
  <li><a href="/api/debug?source=vic" style="color:#d4784a">/api/debug?source=vic</a></li>
  <li><a href="/api/debug?source=lm" style="color:#d4784a">/api/debug?source=lm</a></li>
  <li><a href="/api/custom-sources" style="color:#d4784a">/api/custom-sources</a> — GET/POST/DELETE</li>
</ul>
<p style="color:#484440;margin-top:32px;font-size:12px">Paste base URL into Plugin Copilot → Settings → Scraper Connection</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Plugin Copilot scraper v3 on port ${PORT}`);
  startKeepAlive();
});
