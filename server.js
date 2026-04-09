/**
 * Plugin Copilot — Scraper Server v3
 * ─────────────────────────────────────
 * Render deploy: Build = "npm install", Start = "node server.js"
 *
 * Key design decisions:
 * - audiopluginguy.com/deals is the MASTER REFERENCE for price history,
 *   historical lows, sale frequency, and trend data.
 * - Live feeds (Reddit, KVR, VI-Control, LinkedMusicians + custom URLs)
 *   provide the current deals, validated against APG history.
 * - Cache is bypassed when ?fresh=1 is passed (refresh button).
 * - Custom user-added scrape URLs are accepted via POST /api/sources.
 * - Only deals from the last 30 days are returned by default.
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── In-memory state ─────────────────────────────────────────
let dealsCache    = null;
let dealsCacheTime = 0;
let apgCache      = null;   // audiopluginguy history — longer TTL (1hr)
let apgCacheTime  = 0;
let customSources = [];     // user-added URLs: [{url, label}]

const DEALS_TTL = 5  * 60 * 1000;   // 5 min
const APG_TTL   = 60 * 60 * 1000;   // 1 hr

// ── Keep-alive (Render free tier) ──────────────────────────
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  setInterval(() => fetch(`${url}/health`).catch(()=>{}), 13 * 60 * 1000);
}

// ── Utilities ───────────────────────────────────────────────
const CATS = {
  'Reverb'      : ['reverb','room reverb','hall reverb','plate reverb','spring reverb','convolution','impulse response'],
  'Delay'       : ['delay',' echo ',' echo,','tape delay','ping pong delay'],
  'Compression' : ['compressor','compression',' limiter ','bus comp','1176','la-2a','ssl bus','vca comp','optical comp','glue comp'],
  'EQ'          : ['equalizer','equaliser','pultec','api 550','neve 1073','parametric eq','graphic eq',' eq '],
  'Distortion'  : ['distortion','saturation','overdrive','fuzz','clipper','harmonic exciter','tape sat','waveshaper','amp sim'],
  'Modulation'  : ['chorus','flanger','phaser','tremolo','vibrato','rotary','leslie','ensemble','auto-pan','modulator'],
  'Synths'      : ['synthesizer','wavetable','fm synth','analog synth','serum','massive','vital','subtractive synth','vst synth'],
  'Instruments' : ['piano','electric piano','guitar','bass guitar','drum kit','orchestral','strings','brass','woodwind','kontakt','sample library','rompler','sample pack'],
  'Mastering'   : ['mastering','master bus','loudness','stereo imager','lufs','true peak','mid-side','brickwall'],
  'Utility'     : ['tuner','pitch shift','spectrum analyzer','noise reduction','audio restoration','midi tool','audio editor']
};

function classify(t) {
  const lo = ' '+t.toLowerCase()+' ';
  for (const [c,kws] of Object.entries(CATS)) if (kws.some(k=>lo.includes(k))) return c;
  return 'Other';
}

// Price extraction — returns the most likely SALE price from text
function extractSalePrice(text) {
  if (!text) return null;
  // Match $X or $X.XX — must be 3–999
  const all = [...text.matchAll(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/g)]
    .map(m=>parseFloat(m[1])).filter(p=>p>=3&&p<=999);
  if (!all.length) return null;
  // Free deal: "free" or "$0" in text
  if (/\bfree\b/i.test(text)) return 0;
  return all.length===1 ? all[0] : Math.min(...all);
}

function extractMSRP(text) {
  if (!text) return null;
  const kw = text.match(/(?:was|reg(?:ular)?|msrp|rrp|retail|orig(?:inal)?|norm(?:ally)?|full price|valued? at|worth)\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)/i);
  if (kw) return parseFloat(kw[1]);
  const off = text.match(/\$(\d{1,3})\s+off\s+\$(\d{1,3})/i);
  if (off) return parseFloat(off[2]);
  const slash = text.match(/\$(\d{1,3})\s*[\/|]\s*\$(\d{1,3})/);
  if (slash){ const a=parseFloat(slash[1]),b=parseFloat(slash[2]); if(b>a) return b; }
  return null;
}

function extractDeveloper(title) {
  const br = title.match(/^\[([^\]]{2,40})\]/); if(br) return br[1].trim();
  const da = title.match(/^([A-Z][^-–|$\d]{2,25})\s*[-–]/); if(da) return da[1].trim();
  return 'Various';
}

// Clean plugin name — NEVER truncate, let UI wrap
function cleanName(title) {
  if (!title) return 'Unknown Plugin';
  let n = title
    .replace(/^\[.*?\]\s*/,'')
    .replace(/\$[\d.,]+[^\s]*/g,'')
    .replace(/\((?:reg|was|msrp|retail|save|off|free|deal)[^)]*\)/gi,'')
    .replace(/[-–|].*$/,'')
    .replace(/\s{2,}/g,' ')
    .trim();
  // Reject garbage names: single char, all digits, common noise words
  if (!n || n.length < 3 || /^\d+$/.test(n) || /^(the|a|an|and|or|for|in|on|at|to|of|u|i)$/i.test(n.trim())) {
    // Try to salvage — take first meaningful segment of original title
    const parts = title.split(/[-–|]/);
    for (const p of parts) {
      const cleaned = p.replace(/\$[\d.,]+[^\s]*/g,'').replace(/\[.*?\]/g,'').trim();
      if (cleaned.length >= 3 && !/^(the|a|an|u|i|\d+)$/i.test(cleaned)) return cleaned;
    }
    return title.slice(0,80).trim() || 'Unknown Plugin';
  }
  return n; // NO slice — full name always
}

function sentiment(text) {
  const lo = text.toLowerCase();
  let s=0.5;
  ['great','excellent','best','worth','steal','deal','love','finally','recommended','essential','must have'].forEach(w=>{if(lo.includes(w))s+=0.04;});
  ['avoid','skip','bad','meh','buggy','overpriced','not worth','disappointing','broken','crashes'].forEach(w=>{if(lo.includes(w))s-=0.06;});
  return parseFloat(Math.max(0.1,Math.min(0.95,s)).toFixed(2));
}

let _uid = 2000;
function uid() { return ++_uid; }

// ── 30-day filter ───────────────────────────────────────────
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
function isWithin30Days(isoDate) {
  if (!isoDate) return true; // unknown date — include it
  return (Date.now() - new Date(isoDate).getTime()) <= THIRTY_DAYS;
}

// ── Build a normalized deal object ──────────────────────────
function buildDeal(f, apgHistory) {
  const price = f.current_price;
  const msrp  = (f.msrp && f.msrp > price) ? f.msrp : price * 2;

  // Look up this plugin in audiopluginguy history
  const hist = apgHistory ? lookupAPGHistory(f.plugin_name, f.developer, apgHistory) : null;

  const historicalLow  = hist ? hist.lowest_price  : price;
  const historicalAvg  = hist ? hist.avg_sale_price : Math.round(msrp * 0.65);
  const saleDates      = hist ? hist.sale_dates     : [f.timestamp || new Date().toISOString()];
  const saleFreqDays   = hist ? hist.freq_days      : 120;
  const priceHistory   = hist ? hist.price_history  : [msrp, price];
  const devFreq        = hist ? hist.dev_freq       : 'unknown';

  const d = {
    id                        : f.id || uid(),
    plugin_name               : f.plugin_name || 'Unknown Plugin',
    developer                 : f.developer   || 'Various',
    category                  : f.category    || classify(f.plugin_name || ''),
    current_price             : price,
    msrp,
    historical_low_price      : Math.min(historicalLow, price),
    historical_avg_sale_price : historicalAvg,
    last_sale_dates           : saleDates,
    sale_frequency_days       : saleFreqDays,
    url                       : f.url || '',
    source                    : f.source || '',
    timestamp                 : f.timestamp || new Date().toISOString(),
    price_history             : priceHistory,
    dev_discount_freq         : devFreq,
    sentiment                 : f.sentiment || 0.5,
    notes                     : f.notes || '',
    apg_verified              : !!hist   // flag: did we find this in APG history?
  };

  // Compute deal score
  const disc    = msrp > 0 ? Math.min((msrp-price)/msrp*100,100) : 0;
  const vsLow   = price <= d.historical_low_price ? 100 : price <= historicalAvg ? 60 : 20;
  const rarity  = Math.min(saleFreqDays/365,1)*100;
  const days    = saleDates.length ? (Date.now()-new Date(saleDates[0]))/86400000 : 999;
  const recency = Math.min(days/(saleFreqDays||90),1)*100;
  const sent    = d.sentiment*100;
  d.deal_score  = Math.min(Math.round(disc*.3+vsLow*.3+rarity*.2+recency*.1+sent*.1),100);

  return d;
}

// ── APG history lookup ──────────────────────────────────────
// Match a scraped deal to APG history by fuzzy plugin name
function lookupAPGHistory(name, developer, apgDeals) {
  if (!name || !apgDeals || !apgDeals.length) return null;
  const nLo = name.toLowerCase().replace(/[^a-z0-9]/g,'');
  // Try exact match first, then partial
  let match = apgDeals.find(a => {
    const aLo = (a.plugin_name||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    return aLo === nLo || (nLo.length > 4 && (aLo.includes(nLo) || nLo.includes(aLo)));
  });
  return match || null;
}

// ══════════════════════════════════════════════════════════════
// SCRAPER 1: audiopluginguy.com/deals — MASTER HISTORY SOURCE
// ══════════════════════════════════════════════════════════════
// APG has structured deal listings with: plugin name, developer,
// current price, original price, deal dates, and sometimes
// historical sale data. This is our ground truth.
async function scrapeAPG() {
  if (apgCache && Date.now()-apgCacheTime < APG_TTL) {
    console.log('[apg] serving from cache');
    return apgCache;
  }

  console.log('[apg] fetching audiopluginguy.com/deals...');
  const res = await fetch('https://www.audiopluginguy.com/deals/', {
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept'         : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control'  : 'no-cache'
    }
  });

  if (!res.ok) throw new Error(`APG HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];

  // APG uses WordPress with a deals archive.
  // Each deal post is typically an article or a card element.
  // Try multiple selectors to be resilient to theme changes.
  const selectors = [
    'article',
    '.deal-item',
    '.post',
    '.entry',
    '.product-item',
    '.item-deal'
  ];

  // Try parsing structured article cards first
  $('article, .deal-card, .post-item').each((_, el) => {
    const $el = $(el);

    // Title / plugin name
    const titleEl = $el.find('h1,h2,h3,h4').first();
    const rawTitle = titleEl.text().replace(/\s+/g,' ').trim();
    if (!rawTitle || rawTitle.length < 3) return;

    // Prices
    const fullText = $el.text().replace(/\s+/g,' ');
    const salePrice = extractSalePrice(fullText);
    if (!salePrice && salePrice !== 0) return;

    const msrp = extractMSRP(fullText);

    // Date — look for post date meta
    const dateStr = $el.find('time').attr('datetime')
      || $el.find('.entry-date,.post-date,.date,.published').first().text().trim();
    const timestamp = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

    // Deal URL
    const dealUrl = $el.find('a').first().attr('href') || '';

    // Developer — often in a subtitle or category tag
    const devEl = $el.find('.developer,.brand,.subtitle,.category-name').first().text().trim();
    const developer = devEl || extractDeveloper(rawTitle);

    const name = cleanName(rawTitle);

    deals.push({
      plugin_name   : name,
      developer,
      category      : classify(rawTitle + ' ' + fullText.slice(0,200)),
      current_price : salePrice,
      msrp          : msrp || (salePrice * 2),
      url           : dealUrl.startsWith('http') ? dealUrl : `https://www.audiopluginguy.com${dealUrl}`,
      timestamp,
      source        : 'AudioPluginGuy',
      // These become the historical reference
      lowest_price  : salePrice,
      avg_sale_price: msrp ? Math.round(msrp * 0.65) : salePrice,
      sale_dates    : [timestamp],
      freq_days     : 120,
      price_history : msrp ? [msrp, salePrice] : [salePrice],
      dev_freq      : 'unknown'
    });
  });

  // Fallback: parse any deal links with prices
  if (deals.length < 5) {
    $('a').each((_, el) => {
      const $el    = $(el);
      const title  = $el.text().replace(/\s+/g,' ').trim();
      const href   = $el.attr('href') || '';
      if (title.length < 5 || !href.includes('audiopluginguy')) return;
      const price = extractSalePrice(title);
      if (!price) return;
      deals.push({
        plugin_name   : cleanName(title),
        developer     : 'Various',
        category      : classify(title),
        current_price : price,
        msrp          : price * 2,
        url           : href,
        timestamp     : new Date().toISOString(),
        source        : 'AudioPluginGuy',
        lowest_price  : price,
        avg_sale_price: Math.round(price * 1.4),
        sale_dates    : [new Date().toISOString()],
        freq_days     : 120,
        price_history : [price * 2, price],
        dev_freq      : 'unknown'
      });
    });
  }

  console.log(`[apg] found ${deals.length} deals`);
  apgCache     = deals;
  apgCacheTime = Date.now();
  return deals;
}

// ══════════════════════════════════════════════════════════════
// SCRAPER 2: Reddit r/AudioProductionDeals
// ══════════════════════════════════════════════════════════════
async function scrapeReddit() {
  const res = await fetch(
    'https://www.reddit.com/r/AudioProductionDeals/new.json?limit=100&raw_json=1',
    { headers: {
        'User-Agent': 'web:plugin-copilot-deals-aggregator:v3.0 (open source deal tracker)',
        'Accept'    : 'application/json'
      }
    }
  );
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.data?.children?.length) throw new Error('Reddit: no children');

  const deals = [];
  for (const { data: p } of json.data.children) {
    if (p.stickied) continue;
    if (p.link_flair_text && /discussion|question|meta|mod|weekly/i.test(p.link_flair_text)) continue;

    // Only include posts from last 30 days
    const postDate = new Date(p.created_utc * 1000);
    if (!isWithin30Days(postDate.toISOString())) continue;

    const text  = `${p.title} ${p.selftext||''}`;
    const price = extractSalePrice(p.title) ?? extractSalePrice(p.selftext||'');
    if (!price && price !== 0) continue;

    const msrp     = extractMSRP(text);
    const dealUrl  = (!p.is_self && p.url && !p.url.includes('reddit.com')) ? p.url : `https://reddit.com${p.permalink}`;
    const name     = cleanName(p.title);

    if (!name || name.length < 3) continue;

    deals.push({
      plugin_name  : name,
      developer    : extractDeveloper(p.title),
      category     : classify(text),
      current_price: price,
      msrp         : msrp || price * 2,
      url          : dealUrl,
      source       : 'Reddit r/AudioProductionDeals',
      timestamp    : postDate.toISOString(),
      sentiment    : sentiment(text),
      notes        : (p.selftext||'').slice(0,300)
    });
  }
  console.log(`[reddit] ${deals.length} deals (last 30d)`);
  return deals;
}

// ══════════════════════════════════════════════════════════════
// SCRAPER 3: KVR Audio
// ══════════════════════════════════════════════════════════════
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

  $('div.postbody').each((_,postBody) => {
    const $pb = $(postBody).clone();
    $pb.find('blockquote,.quotecontent').remove();
    const contentEl = $pb.find('div.content');
    const $content  = contentEl.length ? contentEl : $pb;
    const text = $content.text().replace(/\s+/g,' ').trim();

    const price = extractSalePrice(text);
    if (!price || price > 600) return;
    const msrp = extractMSRP(text);
    if (msrp && msrp <= price) return;

    // Post date from nearby element
    const postDate = $(postBody).closest('div.post').find('p.author time').attr('datetime')
      || new Date().toISOString();
    if (!isWithin30Days(postDate)) return;

    const lines = text.split(/[.!\n]/).map(l=>l.trim()).filter(l=>l.length>4&&l.length<120);
    let name = cleanName(lines[0] || text);
    if (!name || name.length < 3) return;

    let dealUrl = url;
    $content.find('a[href^="http"]').each((_,a) => {
      const href = $(a).attr('href')||'';
      if (!href.includes('kvraudio.com') && !href.includes('reddit.com')) { dealUrl=href; return false; }
    });

    deals.push({
      plugin_name  : name,
      category     : classify(text),
      current_price: price,
      msrp         : msrp || price * 2,
      url          : dealUrl,
      source       : 'KVR Audio',
      timestamp    : postDate,
      sentiment    : sentiment(text),
      notes        : text.slice(0,300)
    });
  });

  console.log(`[kvr] ${deals.length} deals`);
  return deals.slice(0,25);
}

// ══════════════════════════════════════════════════════════════
// SCRAPER 4: VI-Control
// ══════════════════════════════════════════════════════════════
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

  $('div.structItem--thread, li.structItem--thread').each((_,item) => {
    const $item   = $(item);
    const titleEl = $item.find('.structItem-title');
    const allText = titleEl.text().replace(/\s+/g,' ').trim();
    const linkEl  = titleEl.find('a').last();
    const href    = linkEl.attr('href') || '';

    // Date
    const dateEl = $item.find('time').attr('datetime') || new Date().toISOString();
    if (!isWithin30Days(dateEl)) return;

    const price = extractSalePrice(allText);
    if (!price) return;
    const name = cleanName(allText);
    if (!name || name.length < 3) return;

    deals.push({
      plugin_name  : name,
      category     : classify(allText),
      current_price: price,
      msrp         : extractMSRP(allText) || price * 2,
      url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
      source       : 'VI-Control',
      timestamp    : dateEl,
      notes        : allText
    });
  });

  // Fallback
  if (!deals.length) {
    $('a[href*="/community/threads/"]').each((_,el) => {
      const title = $(el).text().replace(/\s+/g,' ').trim();
      if (title.length < 8) return;
      const price = extractSalePrice(title);
      if (!price) return;
      const name = cleanName(title);
      if (!name || name.length < 3) return;
      const href = $(el).attr('href')||'';
      deals.push({
        plugin_name  : name,
        category     : classify(title),
        current_price: price,
        msrp         : extractMSRP(title) || price * 2,
        url          : href.startsWith('http') ? href : `https://vi-control.net${href}`,
        source       : 'VI-Control',
        timestamp    : new Date().toISOString(),
        notes        : title
      });
    });
  }

  console.log(`[vic] ${deals.length} deals`);
  return deals.slice(0,20);
}

// ══════════════════════════════════════════════════════════════
// SCRAPER 5: LinkedMusicians
// ══════════════════════════════════════════════════════════════
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

  const selectors = ['a.topictitle','li.row > dl > dt > a','.forumbg a.topictitle','td.topic a.topictitle','h2 > a[href*="viewtopic"]','h3 > a[href*="viewtopic"]','a[href*="viewtopic"]'];
  for (const sel of selectors) {
    $(sel).each((_,el) => {
      const title = $(el).text().replace(/\s+/g,' ').trim();
      const href  = $(el).attr('href')||'';
      if (title.length < 8 || title.length > 200) return;
      const price = extractSalePrice(title);
      if (!price) return;
      const name = cleanName(title);
      if (!name || name.length < 3) return;
      deals.push({
        plugin_name  : name,
        category     : classify(title),
        current_price: price,
        msrp         : extractMSRP(title) || price * 2,
        url          : href.startsWith('http') ? href : `https://linkedmusicians.com${href}`,
        source       : 'LinkedMusicians',
        timestamp    : new Date().toISOString(),
        notes        : title
      });
    });
    if (deals.length) break;
  }

  console.log(`[lm] ${deals.length} deals`);
  return deals.slice(0,20);
}

// ══════════════════════════════════════════════════════════════
// SCRAPER 6: Custom user-added URLs
// ══════════════════════════════════════════════════════════════
async function scrapeCustomUrl(sourceObj) {
  const { url, label } = sourceObj;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept'    : 'text/html'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $    = cheerio.load(html);
    const deals = [];

    // Generic extraction: find any link containing a price
    $('a, h1, h2, h3, h4, p').each((_,el) => {
      const text = $(el).text().replace(/\s+/g,' ').trim();
      if (text.length < 6 || text.length > 300) return;
      const price = extractSalePrice(text);
      if (!price) return;
      const name = cleanName(text);
      if (!name || name.length < 3) return;
      const href = $(el).attr('href') || url;
      deals.push({
        plugin_name  : name,
        category     : classify(text),
        current_price: price,
        msrp         : extractMSRP(text) || price * 2,
        url          : href.startsWith('http') ? href : url,
        source       : label || new URL(url).hostname,
        timestamp    : new Date().toISOString(),
        notes        : text.slice(0,200)
      });
    });

    console.log(`[custom:${label}] ${deals.length} deals`);
    return deals.slice(0,20);
  } catch(e) {
    console.error(`[custom:${label}]`, e.message);
    return [];
  }
}

// ── Deduplicate ─────────────────────────────────────────────
function dedup(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = d.plugin_name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,22);
    if (!key || key==='unknownplugin' || key==='unknown' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main aggregation ─────────────────────────────────────────
async function aggregateAll(fresh=false) {
  // Bust cache on fresh=true (user hit refresh)
  if (!fresh && dealsCache && Date.now()-dealsCacheTime < DEALS_TTL) {
    return { deals: dealsCache, cached: true, sources: dealsCache._src || {} };
  }

  // 1. Get APG history first — used to enrich all other deals
  let apgDeals = [];
  try { apgDeals = await scrapeAPG(); } catch(e) { console.error('[apg]', e.message); }

  // 2. Scrape live sources in parallel
  const customResults = await Promise.all(customSources.map(s => scrapeCustomUrl(s)));

  const [reddit, kvr, vic, lm] = await Promise.all([
    scrapeReddit().catch(e        => { console.error('[reddit]',e.message); return []; }),
    scrapeKVR().catch(e           => { console.error('[kvr]',e.message);    return []; }),
    scrapeVIControl().catch(e     => { console.error('[vic]',e.message);    return []; }),
    scrapeLinkedMusicians().catch(e=> { console.error('[lm]',e.message);    return []; })
  ]);

  const customFlat = customResults.flat();

  // 3. APG deals from last 30 days are also included as current deals
  const apgCurrent = apgDeals.filter(d => isWithin30Days(d.timestamp));

  const counts = {
    apg: apgCurrent.length, reddit: reddit.length, kvr: kvr.length,
    vic: vic.length, lm: lm.length, custom: customFlat.length
  };

  // 4. Merge — APG first (most authoritative), then live feeds
  const rawAll = [...apgCurrent, ...reddit, ...kvr, ...vic, ...lm, ...customFlat];

  // 5. Build normalized deal objects enriched with APG history
  const enriched = rawAll.map(raw => buildDeal(raw, apgDeals));

  // 6. Deduplicate, filter 30 days, sort by score
  const final = dedup(enriched)
    .filter(d => isWithin30Days(d.timestamp))
    .sort((a,b) => b.deal_score - a.deal_score);

  console.log(`[aggregate] final: ${final.length} | counts:`, JSON.stringify(counts));

  final._src = counts;
  dealsCache     = final;
  dealsCacheTime = Date.now();

  return { deals: final, cached: false, sources: counts };
}

// ── Routes ──────────────────────────────────────────────────

// Main deals endpoint — ?fresh=1 bypasses cache
app.get('/api/deals', async (req, res) => {
  try {
    const fresh = req.query.fresh === '1';
    const result = await aggregateAll(fresh);
    res.json({ ...result, updated: new Date().toISOString() });
  } catch(e) {
    console.error('[/api/deals]', e.message);
    res.status(500).json({ error: e.message, deals: [], sources: {} });
  }
});

// APG history only — for looking up a specific plugin
app.get('/api/history', async (req, res) => {
  try {
    const query = (req.query.q||'').toLowerCase();
    const apg   = await scrapeAPG();
    const matches = query
      ? apg.filter(d => d.plugin_name.toLowerCase().includes(query) || (d.developer||'').toLowerCase().includes(query))
      : apg;
    res.json({ count: matches.length, results: matches });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Custom sources management
app.get('/api/sources', (req, res) => {
  res.json({ sources: customSources });
});

app.post('/api/sources', (req, res) => {
  const { url, label } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid URL' }); }
  if (customSources.find(s=>s.url===url)) return res.json({ ok: true, message: 'already exists', sources: customSources });
  customSources.push({ url, label: label || new URL(url).hostname });
  dealsCache = null; // bust cache so new source is picked up immediately
  console.log('[sources] added:', url);
  res.json({ ok: true, sources: customSources });
});

app.delete('/api/sources', (req, res) => {
  const { url } = req.body;
  customSources = customSources.filter(s=>s.url!==url);
  dealsCache = null;
  res.json({ ok: true, sources: customSources });
});

// Debug individual source
app.get('/api/debug', async (req, res) => {
  const src = req.query.source || 'reddit';
  let result = [];
  try {
    if (src==='apg')    result = await scrapeAPG();
    if (src==='reddit') result = await scrapeReddit();
    if (src==='kvr')    result = await scrapeKVR();
    if (src==='vic')    result = await scrapeVIControl();
    if (src==='lm')     result = await scrapeLinkedMusicians();
  } catch(e) { return res.json({ error: e.message }); }
  res.json({
    source : src,
    count  : result.length,
    names  : result.map(d=>`${d.plugin_name} — $${d.current_price} (msrp ~$${d.msrp||'?'})`),
    first3 : result.slice(0,3)
  });
});

app.get('/health', (_, res) => {
  res.json({ ok:true, cached: dealsCache?dealsCache.length:0, customSources: customSources.length, time:new Date().toISOString() });
});

app.get('/', (_, res) => {
  res.send(`<html><body style="font-family:monospace;background:#0e0d0b;color:#c4b49a;padding:40px;max-width:640px;margin:0 auto">
  <h2 style="color:#d4784a;letter-spacing:.1em">PLUGIN COPILOT SCRAPER v3</h2>
  <p style="color:#7a7268;margin-bottom:20px">AudioPluginGuy as master reference · 30-day window · Custom sources</p>
  <ul style="line-height:2.4;color:#c4b49a">
    <li><a href="/api/deals" style="color:#d4784a">/api/deals</a> — all deals (cached)</li>
    <li><a href="/api/deals?fresh=1" style="color:#d4784a">/api/deals?fresh=1</a> — force fresh scrape</li>
    <li><a href="/api/history" style="color:#d4784a">/api/history?q=ozone</a> — APG history search</li>
    <li><a href="/api/sources" style="color:#d4784a">/api/sources</a> — list custom sources</li>
    <li><a href="/health" style="color:#d4784a">/health</a> — status</li>
    <li><a href="/api/debug?source=apg" style="color:#d4784a">/api/debug?source=apg</a> — test APG</li>
    <li><a href="/api/debug?source=reddit" style="color:#d4784a">/api/debug?source=reddit</a></li>
    <li><a href="/api/debug?source=kvr" style="color:#d4784a">/api/debug?source=kvr</a></li>
    <li><a href="/api/debug?source=vic" style="color:#d4784a">/api/debug?source=vic</a></li>
    <li><a href="/api/debug?source=lm" style="color:#d4784a">/api/debug?source=lm</a></li>
  </ul>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`Plugin Copilot scraper v3 on port ${PORT}`);
  startKeepAlive();
});
