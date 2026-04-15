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
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || '';

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

// ── APG historical index ─────────────────────────────────────
// Built by scrapeAPGFull() — keyed by normalized plugin name
// Each entry: { prices: [{price, date, discount_pct}], developer, msrp, category }
let apgHistory = {};
let apgHistoryTime = 0;
const APG_HISTORY_TTL = 60 * 60 * 1000; // rebuild hourly

function normalizeKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 25);
}

// Compute real stats from APG price history array
function computeHistoricalStats(prices) {
  if (!prices || !prices.length) return null;

  const sorted = [...prices].sort((a, b) => a.price - b.price);
  const allPrices = prices.map(p => p.price);
  const histLow  = Math.min(...allPrices);
  const histHigh = Math.max(...allPrices);
  const histAvg  = Math.round(allPrices.reduce((s, p) => s + p, 0) / allPrices.length);

  // Sale frequency: days between appearances
  const dates = prices
    .map(p => new Date(p.date).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);

  let saleFreqDays = 120; // default
  if (dates.length >= 2) {
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push((dates[i] - dates[i-1]) / 86400000);
    }
    saleFreqDays = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    saleFreqDays = Math.max(7, Math.min(730, saleFreqDays)); // clamp 7d–2yr
  }

  // Developer discount frequency label
  let devFreq = 'occasional';
  if (prices.length >= 8 || saleFreqDays <= 45)  devFreq = 'frequent';
  if (prices.length <= 2 && saleFreqDays >= 300)  devFreq = 'rare';

  // Price history array for sparkline (oldest first)
  const priceHistory = prices
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(p => p.price);

  // Last sale dates (newest first)
  const lastSaleDates = prices
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(p => new Date(p.date).toISOString())
    .filter(d => d !== 'Invalid Date')
    .slice(0, 5);

  return {
    historical_low_price      : histLow,
    historical_avg_sale_price : histAvg,
    historical_high_price     : histHigh,
    sale_frequency_days       : saleFreqDays,
    sale_count                : prices.length,
    dev_discount_freq         : devFreq,
    price_history             : priceHistory,
    last_sale_dates           : lastSaleDates,
  };
}

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
  'Reverb'      : ['reverb','room verb','plate verb','spring verb','convolution','impulse response',' ir ','hall reverb','ambience plugin','room simulation'],
  'Delay'       : ['delay','tape echo','ping pong','multitap','chorus delay','slapback','dub delay','echo plugin'],
  'Compression' : ['compressor','compression','bus comp','glue comp','1176','la-2a','opto comp','vca comp','transient designer','limiter','multiband comp','sidechain','ssl bus','api 2500','fairchild','teletronix'],
  'EQ'          : ['equalizer','equaliser','pultec','parametric eq','graphic eq','api 550','neve 1073','ssl eq','passive eq','mastering eq','hybrid eq',' eq plugin','linear phase eq'],
  'Distortion'  : ['distortion','saturation','overdrive','fuzz','bitcrusher','waveshaper','harmonic exciter','tape saturation','tube saturation','clipper','analog warmth','vinyl emulation','lo-fi'],
  'Modulation'  : ['chorus','flanger','phaser','tremolo','vibrato','rotary','leslie','auto-pan','ensemble','stereo width','ring mod','frequency shifter','pitch shifter','univibe','modulation fx'],
  'Synths'      : ['synthesizer','wavetable synth','fm synth','analog synth','virtual analog','serum','massive','vital','surge','pigments','subtractive','additive synth','granular synth','modal synthesis','spectral synth','acid bass synth','polyphonic','monophonic synth','arpeggiator'],
  'Drums'       : ['drum machine','drum kit','drum samples','drum loop','drum plugin','808','tr-808','tr-909','beatmaker','beat machine','acoustic drums','electronic drums','rhythm machine','percussion plugin','groove box'],
  'Instruments' : ['piano','electric piano','organ','rhodes','wurlitzer','harpsichord','clavinet','accordion','guitar','bass guitar','upright bass','violin','cello','viola','strings plugin','orchestral','brass','woodwind','flute','oboe','trumpet','trombone','choir','vocal plugin','ethnic','world instrument','kontakt library','sample library','rompler','sample pack','sound library','instrument plugin','virtual instrument'],
  'Mastering'   : ['mastering','master bus','loudness meter','loudness plugin','lufs','true peak','stereo imager','mid-side','brickwall limiter','finalizer','mastering chain','mastering suite','metering','spectrum meter','correlation meter'],
  'Utility'     : ['tuner','pitch detection','spectrum analyzer','audio analyzer','oscilloscope','noise reduction','audio restoration','denoise','declick','dehum','channel strip','gain plugin','routing','midi plugin','midi tool','midi processor','converter','format converter','meter plugin','reference tool']
};

function classify(text) {
  // Word-boundary aware matching
  const lo = (' ' + text.toLowerCase() + ' ').replace(/[^a-z0-9 ]/g, ' ');
  for (const [cat, kws] of Object.entries(CATS)) {
    if (kws.some(k => lo.includes(' ' + k.toLowerCase().replace(/[^a-z0-9 ]/g,' ') + ' ')
                   || lo.includes(k.toLowerCase()))) return cat;
  }
  // Fallback heuristics for common plugin name patterns
  if (/\b(v[ex]rb|hall|plate|shimmer|spring)\b/i.test(text)) return 'Reverb';
  if (/\b(comp|vca|opto|glue|squeeze)\b/i.test(text)) return 'Compression';
  if (/\b(kick|snare|hihat|hi-hat|tom|cymbal|clap|perc)\b/i.test(text)) return 'Drums';
  if (/\b(synth|osc|lfo|envelope|midi)\b/i.test(text)) return 'Synths';
  if (/\b(mix|master|stereo|mono|pan|gain|trim)\b/i.test(text)) return 'Utility';
  return 'Other';
}

// ── Price extraction ─────────────────────────────────────────
function extractPrice(text) {
  if (!text) return null;
  const lo = text.toLowerCase();
  // Detect genuinely free items
  if (/\bfree\b/.test(lo) && !/free trial|free demo|free shipping/i.test(lo)) {
    // Only return 0 if it's clearly free (no paid price nearby)
    if (!lo.includes('$') || /price(d)?\s*:\s*\$0/i.test(lo) || /discounted price is \$0/i.test(lo)) {
      return 0;
    }
  }
  const matches = [...text.matchAll(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/g)]
    .map(m => parseFloat(m[1]))
    .filter(p => {
      if (p < 5 || p > 999) return false;
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
  if (price == null || (price < 5 && price !== 0)) return null;
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
    deal_ends: null,
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

    // Clean Reddit title
    let titleClean = p.title
      .replace(/\s*\(\)\s*/g, ' ')                         // remove empty ()
      .replace(/\s+(?:until|through|thru|ends?|expires?|from|through)\s+\d+\s+\w+/gi, '') // dates
      .replace(/\s+[-–]\s+\$[\d.]+.*$/, '')                // "— $49" suffix
      .replace(/\s+for\s+(?:a\s+)?limited\s+time/gi, '')   // "for limited time"
      .trim();

    // If title has quoted plugin names like "Plugin A" () "Plugin B" ()
    // extract just the first quoted name as the plugin name
    const quotedNames = [...titleClean.matchAll(/"([^"]{3,60})"/g)].map(m => m[1]);
    if (quotedNames.length > 0) {
      titleClean = quotedNames[0]; // Use first quoted plugin name
    }

    const name = cleanName(titleClean);
    if (!name) continue;

    const msrp    = extractMSRP(fullText);
    const dealUrl = (!p.is_self && p.url && !p.url.includes('reddit.com'))
      ? p.url : `https://reddit.com${p.permalink}`;
    const ts = new Date(p.created_utc * 1000).toISOString();

    // Extract any community notes from the post body
    const postBody = (p.selftext || '').replace(/\[.*?\]\(.*?\)/g, '').replace(/\s+/g,' ').trim();
    const comments = [];
    if (postBody.length > 20) comments.push(postBody.slice(0, 180));

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
      notes         : postBody.slice(0, 200),
      comments      : comments,
      comment_count : p.num_comments || 0,
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
    45000
  );

  if (!res.ok) throw new Error(`KVR HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  const deals = [];
  const seen  = new Set();

  // KVR forum structure:
  // .postbody > div.content contains the post text
  // We remove blockquotes and signatures, then look for paragraphs with prices
  $('div.postbody').each((_, el) => {
    // Extract post date from the author line near this post
    // KVR structure: <div class="post"> contains <p class="author"> and <div class="postbody">
    const $postWrap = $(el).closest('div.post, div[class*="post"]');
    const timeEl = $postWrap.find('time').first();
    const postDate = timeEl.attr('datetime') || '';
    let ts = new Date().toISOString();
    if (postDate) {
      try { ts = new Date(postDate).toISOString(); } catch(e) {}
    } else {
      // Try extracting date from text like "Wed Apr 01, 2026"
      const authorText = $postWrap.find('p.author, .author').text();
      const dateMatch = authorText.match(/([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})/);
      if (dateMatch) {
        try { ts = new Date(dateMatch[1]).toISOString(); } catch(e) {}
      }
    }

    const $post = $(el).clone();
    // Remove quoted text, signatures, user info
    $post.find('blockquote, .quotecontent, .sig, .poster, .postprofile').remove();

    const $content = $post.find('div.content');
    if (!$content.length) return;

    // Get all text nodes / paragraphs from the content div
    // The actual deal info is in <p> tags or direct text after bullet lines
    let dealText = '';

    // Try to find paragraphs with substance
    $content.find('p, br').each((_, node) => {
      const t = $(node).text().trim();
      if (t.length > 10) dealText += ' ' + t;
    });

    // Fallback: just get all text
    if (!dealText.trim()) {
      dealText = $content.text();
    }

    dealText = dealText
      .replace(/\*\s*/g, '')           // remove bullet * characters
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (dealText.length < 15) return;

    const price = extractPrice(dealText);
    if (!price || price > 800) return;

    const msrp = extractMSRP(dealText) || price * 2;

    // Extract plugin name from the deal text
    // Pattern: "X% off PLUGIN for $Y" or "PLUGIN now $Y" or "PLUGIN for $Y"
    let name = null;

    // Try: "off PLUGIN" pattern
    const offMatch = dealText.match(/(?:off|discount(?:ed)?)\s+([A-Z][^$\n.]{3,50})(?:\s+for|\s+now|\s*[,$])/i);
    if (offMatch) name = cleanName(offMatch[1]);

    // Try: text before first $ sign
    if (!name) {
      const beforePrice = dealText.split(/\$\d/)[0];
      // Take last meaningful phrase
      const phrases = beforePrice.split(/[,;!]/).map(s => s.trim()).filter(s => s.length > 5);
      for (let i = phrases.length - 1; i >= 0; i--) {
        name = cleanName(phrases[i]);
        if (name) break;
      }
    }

    // Try: first sentence
    if (!name) {
      const firstSentence = dealText.split(/[.!]/)[0];
      name = cleanName(firstSentence.slice(0, 80));
    }

    if (!name || name.length < 3) return;

    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (seen.has(key)) return;
    seen.add(key);

    // Find best URL — prefer external product links
    let dealUrl = 'https://www.kvraudio.com/forum/viewtopic.php?t=262151';
    $content.find('a[href^="http"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes('kvraudio.com') && !href.includes('javascript')) {
        dealUrl = href; return false;
      }
    });

    const d = makeDeal({
      plugin_name    : name,
      category       : classify(dealText),
      current_price  : price, msrp,
      url            : dealUrl,
      source         : 'KVR Audio',
      timestamp      : ts,
      last_sale_dates: [ts],
      sentiment      : sentiment(dealText),
      notes          : dealText.slice(0, 200),
      comments       : dealText.length > 30 ? [dealText.slice(0, 180)] : [],
    });
    if (d) deals.push(d);
  });

  console.log(`[kvr] ${deals.length} deals`);
  return deals.slice(0, 30);
}

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
    // Reject obvious nav/promo banner text that isn't a plugin name
    const nameLo = name.toLowerCase();
    const junkPhrases = [
      'save up to','promo code','your order','sign up','newsletter',
      'easter','click here','free shipping','limited time offer',
      'sale ends','view all','see all','show more','load more'
    ];
    if (junkPhrases.some(p => nameLo.includes(p))) return;
    // Reject if name starts with a number or common promo word
    if (/^(save|get|up to|\d+%)/i.test(name)) return;

    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
    if (seen.has(key)) return;
    seen.add(key);

    // Get post date from XenForo structItem time element
    const timeEl2 = $(el).find('time').first();
    const vicDate = timeEl2.attr('datetime') || '';
    let vicTs = new Date().toISOString();
    if (vicDate) { try { vicTs = new Date(vicDate).toISOString(); } catch(e) {} }

    const d = makeDeal({
      plugin_name    : name,
      category       : classify(text),
      current_price  : price,
      msrp           : extractMSRP(text) || price * 2,
      url            : href.startsWith('http') ? href : `https://vi-control.net${href}`,
      source         : 'VI-Control',
      timestamp      : vicTs,
      last_sale_dates: [vicTs],
      notes          : text,
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
  // Scrape the ENTIRE APG table — all rows, no limit.
  // Every row is a historical deal entry for a plugin.
  // We use this to build real price history, not just today's deals.

  const res = await scrapeFetch(
    'https://www.audiopluginguy.com/deals/',
    45000
  );

  if (!res.ok) throw new Error(`APG HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);

  // Parse all table rows into raw entries
  const allEntries = [];
  let rowsFound = 0;

  $('table tr, tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;

    const descCell     = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    const discountCell = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    const endsCell     = cells.length >= 3 ? $(cells[2]).text().trim() : '';
    const addedCell    = cells.length >= 4 ? $(cells[3]).text().trim() : '';

    if (!descCell || descCell.length < 10) return;
    rowsFound++;

    const price = extractPrice(descCell);
    if (!price || price < 5 || price > 999) return;

    // Extract plugin name
    let name = null;
    const offPat = descCell.match(/Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by\s+\w|\.)/i);
    if (offPat) name = cleanName(offPat[1].trim());

    if (!name) {
      const parts = descCell.split('|');
      if (parts.length >= 2) {
        const m = parts.slice(1).join('|').match(/Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by|\.)/i);
        if (m) name = cleanName(m[1].trim());
      }
    }
    if (!name) name = cleanName(descCell.split(/[.|]/)[0]);
    if (!name || name.length < 2) return;

    // Extract developer
    let developer = 'Various';
    const byMatch = descCell.match(/by\s+([A-Z][a-zA-Z\s&.]{1,30})(?:\.|,|\s*$)/);
    if (byMatch) developer = byMatch[1].trim();
    else {
      const pipeParts = descCell.split('|');
      if (pipeParts.length >= 2) {
        developer = cleanName(pipeParts[0].trim()) || 'Various';
      }
    }

    const discPct = parseInt(discountCell) || 0;
    const msrp    = discPct > 0 ? Math.round(price / (1 - discPct / 100)) : price * 2;

    let deal_ends = null, dateAdded = new Date().toISOString();
    if (endsCell.match(/\d{4}-\d{2}-\d{2}/)) {
      try { deal_ends = new Date(endsCell).toISOString(); } catch(e) {}
    }
    if (addedCell.match(/\d{4}-\d{2}-\d{2}/)) {
      try { dateAdded = new Date(addedCell).toISOString(); } catch(e) {}
    }

    allEntries.push({
      name, developer, price, msrp, discPct,
      deal_ends, dateAdded,
      descCell, category: classify(descCell),
    });
  });

  console.log(`[apg] parsed ${rowsFound} rows, ${allEntries.length} valid entries`);

  // ── Build historical index from ALL entries ────────────────
  const newHistory = {};

  for (const entry of allEntries) {
    const key = normalizeKey(entry.name);
    if (!key) continue;

    if (!newHistory[key]) {
      newHistory[key] = {
        canonical_name: entry.name,
        developer     : entry.developer,
        category      : entry.category,
        msrp          : entry.msrp,
        prices        : [],
      };
    }

    // Update to highest known MSRP (most accurate)
    if (entry.msrp > newHistory[key].msrp) newHistory[key].msrp = entry.msrp;

    newHistory[key].prices.push({
      price       : entry.price,
      discount_pct: entry.discPct,
      date        : entry.dateAdded,
      deal_ends   : entry.deal_ends,
    });
  }

  // Compute stats for every plugin in history
  for (const key of Object.keys(newHistory)) {
    const h     = newHistory[key];
    const stats = computeHistoricalStats(h.prices);
    if (stats) Object.assign(h, stats);
  }

  // Store in global index
  apgHistory     = newHistory;
  apgHistoryTime = Date.now();
  console.log(`[apg] historical index built: ${Object.keys(apgHistory).length} unique plugins`);

  // ── Return only CURRENT deals (those with a deal_ends in future or recently added) ──
  // A "current" deal is one added in the last 60 days or ending in the future
  const now    = Date.now();
  const cutoff = now - 60 * 24 * 60 * 60 * 1000;
  const currentDeals = [];
  const seenCurrent  = new Set();

  for (const entry of allEntries) {
    const dateTs = new Date(entry.dateAdded).getTime();
    const endsTs = entry.deal_ends ? new Date(entry.deal_ends).getTime() : 0;

    // Include if added recently OR still active (ends in future)
    if (dateTs < cutoff && endsTs < now) continue;

    const key = normalizeKey(entry.name);
    if (seenCurrent.has(key)) continue;
    seenCurrent.add(key);

    // Enrich with historical stats
    const hist  = apgHistory[key] || {};
    const stats = hist.prices ? computeHistoricalStats(hist.prices) : null;

    const d = makeDeal({
      plugin_name               : entry.name,
      developer                 : entry.developer,
      category                  : entry.category,
      current_price             : entry.price,
      msrp                      : entry.msrp,
      historical_low_price      : stats ? stats.historical_low_price  : entry.price,
      historical_avg_sale_price : stats ? stats.historical_avg_sale_price : Math.round(entry.msrp * 0.65),
      sale_frequency_days       : stats ? stats.sale_frequency_days   : 120,
      dev_discount_freq         : stats ? stats.dev_discount_freq      : 'unknown',
      price_history             : stats ? stats.price_history           : [],
      last_sale_dates           : stats ? stats.last_sale_dates         : [entry.dateAdded],
      url                       : 'https://www.audiopluginguy.com/deals/',
      source                    : 'AudioPluginGuy',
      timestamp                 : entry.dateAdded,
      deal_ends                 : entry.deal_ends,
      sentiment                 : 0.7,
      notes                     : entry.descCell.slice(0, 200),
    });
    if (d) currentDeals.push(d);
  }

  console.log(`[apg] ${currentDeals.length} current deals from ${Object.keys(apgHistory).length} historical plugins`);
  return currentDeals;
}

async function scrapeLinkedMusicians() {
  const res = await scrapeFetch(
    'https://linkedmusicians.com/forums/forum/deals/virtual-instruments-vsts-effects-plugins-sample-libraries/',
    45000
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
    '.topic-title a',
    'h2 > a[href*="viewtopic"]',
    'h3 > a[href*="viewtopic"]',
    'a[href*="viewtopic"]',
    'a[href*="topic"]',
    // Discourse-style forums
    'a.title.raw-link',
    'a.raw-link',
    '.topic-list-item a[href*="/t/"]',
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

      // Try to get post date from nearby time element
      const lmTimeEl = $(el).closest('li, tr, div').find('time, .lastpost time').first();
      const lmDate = lmTimeEl.attr('datetime') || '';
      let lmTs = new Date().toISOString();
      if (lmDate) { try { lmTs = new Date(lmDate).toISOString(); } catch(e) {} }

      const d = makeDeal({
        plugin_name    : name,
        category       : classify(text),
        current_price  : price,
        msrp           : extractMSRP(text) || price * 2,
        url            : href.startsWith('http') ? href : `https://linkedmusicians.com${href}`,
        source         : 'LinkedMusicians',
        timestamp      : lmTs,
        last_sale_dates: [lmTs],
        notes          : text,
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
  console.log('[apg] history index size:', Object.keys(apgHistory).length);

  // Enrich Reddit/KVR/VIC/LM deals with APG historical data where available
  // This fixes the scoring inflation — real historical lows instead of "price = low"
  function enrichWithAPGHistory(deals) {
    return deals.map(d => {
      const key  = normalizeKey(d.plugin_name);
      const hist = apgHistory[key];
      if (!hist || !hist.prices || hist.prices.length < 2) return d;

      const stats = computeHistoricalStats(hist.prices);
      if (!stats) return d;

      // Only update historical fields — keep current_price and source from scraper
      return {
        ...d,
        historical_low_price      : Math.min(stats.historical_low_price, d.current_price),
        historical_avg_sale_price : stats.historical_avg_sale_price,
        sale_frequency_days       : stats.sale_frequency_days,
        dev_discount_freq         : stats.dev_discount_freq,
        price_history             : stats.price_history,
        last_sale_dates           : stats.last_sale_dates.length
          ? stats.last_sale_dates
          : d.last_sale_dates,
        deal_score: null, // will be recalculated
      };
    }).map(d => {
      // Recalculate score with real historical data
      if (d.deal_score === null) d.deal_score = dealScore(d);
      return d;
    });
  }

  const enrichedReddit = enrichWithAPGHistory(reddit);
  const enrichedKVR    = enrichWithAPGHistory(kvr);
  const enrichedVIC    = enrichWithAPGHistory(vic);
  const enrichedLM     = enrichWithAPGHistory(lm);

  const combined = dedup([...enrichedReddit, ...enrichedKVR, ...enrichedVIC, ...apg, ...enrichedLM]);
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


// ── /api/search — search APG for a specific plugin name ──────
// Called by the frontend search bar after 600ms debounce
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ deals: [] });

  try {
    // Search APG table — their site has a search/filter capability
    // We scrape the deals page and filter rows matching the query
    const apgRes = await scrapeFetch(
      'https://www.audiopluginguy.com/deals/?s=' + encodeURIComponent(q),
      30000
    );

    if (!apgRes.ok) throw new Error(`APG search HTTP ${apgRes.status}`);
    const html = await apgRes.text();
    const $    = cheerio.load(html);
    const deals = [];
    const seen  = new Set();

    $('table tr, tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const descCell     = $(cells[0]).text().replace(/\s+/g, ' ').trim();
      const discountCell = $(cells[1]).text().replace(/\s+/g, ' ').trim();
      const endsCell     = cells.length >= 3 ? $(cells[2]).text().trim() : '';
      const addedCell    = cells.length >= 4 ? $(cells[3]).text().trim() : '';

      if (!descCell || descCell.length < 10) return;

      // Filter to rows matching the search query
      if (!descCell.toLowerCase().includes(q.toLowerCase())) return;

      const price = extractPrice(descCell);
      if (!price || price > 999) return;

      let name = null;
      const offPat = descCell.match(/Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by\s+\w|\.)/i);
      if (offPat) name = cleanName(offPat[1].trim());
      if (!name) {
        const parts = descCell.split('|');
        if (parts.length >= 2) {
          const m = parts.slice(1).join('|').match(/Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by|\.)/i);
          if (m) name = cleanName(m[1].trim());
        }
      }
      if (!name) name = cleanName(descCell.split(/[.|]/)[0]);
      if (!name) return;

      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      if (seen.has(key)) return;
      seen.add(key);

      const discPct = parseInt(discountCell) || 0;
      const msrp = discPct > 0 ? Math.round(price / (1 - discPct / 100)) : price * 2;

      let deal_ends = null, timestamp = new Date().toISOString();
      if (endsCell.match(/\d{4}-\d{2}-\d{2}/)) {
        try { deal_ends = new Date(endsCell).toISOString(); } catch(e) {}
      }
      if (addedCell.match(/\d{4}-\d{2}-\d{2}/)) {
        try { timestamp = new Date(addedCell).toISOString(); } catch(e) {}
      }

      let developer = 'Various';
      const byMatch = descCell.match(/by\s+([A-Z][a-zA-Z\s&.]{1,30})(?:\.|,|$)/);
      if (byMatch) developer = byMatch[1].trim();

      const d = makeDeal({
        plugin_name  : name, developer,
        category     : classify(descCell),
        current_price: price, msrp,
        url          : 'https://www.audiopluginguy.com/deals/',
        source       : 'AudioPluginGuy',
        timestamp, last_sale_dates: [timestamp],
        deal_ends,
        notes        : descCell.slice(0, 200),
        sentiment    : 0.7,
      });
      if (d) deals.push(d);
    });

    console.log(`[search] "${q}" → ${deals.length} APG results`);
    res.json({ deals, query: q });
  } catch(e) {
    console.error('[search]', e.message);
    res.json({ deals: [], error: e.message });
  }
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
