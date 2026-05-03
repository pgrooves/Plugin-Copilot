"""
Plugin Copilot — Scraper v2
============================
Strategy per source:
  APG          — direct requests (no blocking, structured table)
  Reddit       — official public JSON API (no blocking)
  KVR Audio    — RSS feed (bypasses bot detection)
  VI-Control   — RSS feed (XenForo built-in)
  LinkedMusicians — RSS feed (phpBB built-in)
  Cakewalk     — RSS feed (Vanilla Forums built-in)

RSS feeds are designed for feed readers (automated clients) so
forum software doesn't block them the way it blocks HTML scrapers.

Install:  pip install requests beautifulsoup4 lxml
Run:      python scraper.py
Output:   deals.json
"""

import json, re, time, logging, xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from pathlib import Path
from email.utils import parsedate_to_datetime

import requests
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

TIMEOUT     = 20
THIRTY_DAYS = datetime.now(timezone.utc) - timedelta(days=30)
_uid        = 1000

def uid():
    global _uid; _uid += 1; return _uid

SESSION = requests.Session()
SESSION.headers.update({
    # Identify as a legitimate feed reader — this is what RSS clients send
    "User-Agent":      "FeedReader/1.0 (Plugin Copilot deal aggregator; +https://github.com/pgrooves/Plugin-Copilot)",
    "Accept":          "application/rss+xml, application/xml, text/xml, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
})

def fetch(url, json_mode=False, retries=3):
    for attempt in range(retries):
        try:
            r = SESSION.get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json() if json_mode else r.text
            log.warning(f"HTTP {r.status_code}: {url}")
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
        except Exception as e:
            log.warning(f"Fetch error ({url}): {e}")
            if attempt < retries - 1:
                time.sleep(2)
    return None

def parse_rss(xml_text):
    """Parse RSS/Atom feed, return list of {title, link, date, description}."""
    if not xml_text:
        return []
    items = []
    try:
        # Strip namespace prefixes for easier parsing
        xml_text = re.sub(r' xmlns[^=]*="[^"]*"', '', xml_text)
        # namespace stripping handled by BeautifulSoup fallback below
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        # Fall back to BeautifulSoup for malformed XML
        s = BeautifulSoup(xml_text, "lxml-xml")
        for item in s.find_all(["item", "entry"]):
            title = item.find(["title"])
            link  = item.find(["link"])
            date  = item.find(["pubDate", "published", "updated", "dc:date"])
            desc  = item.find(["description", "summary", "content"])
            if title:
                items.append({
                    "title":       title.get_text(strip=True),
                    "link":        link.get("href") or link.get_text(strip=True) if link else "",
                    "date":        date.get_text(strip=True) if date else "",
                    "description": desc.get_text(" ", strip=True)[:500] if desc else "",
                })
        return items

    ns = {"atom": "http://www.w3.org/2005/Atom"}
    # RSS 2.0
    for item in root.findall(".//item"):
        t = item.findtext("title", "")
        l = item.findtext("link", "")
        d = item.findtext("pubDate", "") or item.findtext("date", "")
        desc = item.findtext("description", "")
        items.append({"title": t, "link": l, "date": d, "description": desc[:500]})
    # Atom
    if not items:
        for entry in root.findall(".//{http://www.w3.org/2005/Atom}entry"):
            t = entry.findtext("{http://www.w3.org/2005/Atom}title", "")
            l_el = entry.find("{http://www.w3.org/2005/Atom}link")
            l = l_el.get("href", "") if l_el is not None else ""
            d = entry.findtext("{http://www.w3.org/2005/Atom}published", "") or \
                entry.findtext("{http://www.w3.org/2005/Atom}updated", "")
            desc = entry.findtext("{http://www.w3.org/2005/Atom}summary", "") or \
                   entry.findtext("{http://www.w3.org/2005/Atom}content", "")
            items.append({"title": t, "link": l, "date": d, "description": (desc or "")[:500]})
    return items

def parse_date(date_str):
    """Parse various date formats into ISO string."""
    if not date_str:
        return datetime.now(timezone.utc).isoformat()
    date_str = date_str.strip()
    # RFC 2822 (RSS standard: "Mon, 21 Apr 2026 10:00:00 +0000")
    try:
        return parsedate_to_datetime(date_str).isoformat()
    except Exception:
        pass
    # ISO 8601
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(date_str[:19], fmt[:len(date_str)])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except ValueError:
            pass
    return datetime.now(timezone.utc).isoformat()

def soup(html):
    return BeautifulSoup(html, "lxml")

# ── Price helpers ─────────────────────────────────────────────
def extract_price(text):
    if not text: return None
    t = text.lower()
    if re.search(r"discounted price is \$0", t): return 0
    if re.search(r"\b100\s*%\s*off\b", t) and not re.search(r"\$[1-9]", t): return 0
    if re.search(r"\bfree\s+(download|plugin|vst|instrument|sample pack)\b", t) \
       and not re.search(r"\$[1-9]", t): return 0
    matches = [float(m) for m in re.findall(r"\$\s*(\d{1,3}(?:\.\d{1,2})?)", text)]
    matches = [p for p in matches if 5 <= p <= 999 and not (p < 10 and "." in f"{p}")]
    return min(matches) if matches else None

def extract_msrp(text):
    if not text: return None
    m = re.search(
        r"(?:was|reg(?:ular)?|msrp|rrp|retail|orig(?:inal)?|full price)\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)",
        text, re.I)
    if m: return float(m.group(1))
    m = re.search(r"\$(\d{1,3})\s*/\s*\$(\d{1,3})", text)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        return b if b > a else None
    return None

def clean_name(raw):
    if not raw: return None
    name = re.sub(r"^\[.*?\]\s*", "", raw)
    name = re.sub(r"\$[\d,]+(?:\.\d{1,2})?", "", name)
    name = re.sub(r"\d+\s*%\s*off\b", "", name, flags=re.I)
    name = re.sub(r"\((?:reg|was|msrp|retail|save)[^)]{0,30}\)", "", name, flags=re.I)
    name = re.sub(r"\s*\|.*$", "", name)
    name = re.sub(r"[,:!]+$", "", name)
    name = re.sub(r"\s{2,}", " ", name).strip()
    if not name or len(name) < 3: return None
    lo = re.sub(r"[^a-z0-9]", "", name.lower())
    junk = {"free","deal","sale","unknown","various","plugin","audio","music",
            "software","app","get","new","now","save","buy","the","and","for"}
    return None if lo in junk else name[:80]

CATS = {
    "Reverb":      ["reverb","room verb","plate verb","spring verb","convolution","impulse response"],
    "Delay":       ["delay","tape echo","ping pong","echo plugin"],
    "Compression": ["compressor","compression","bus comp","1176","la-2a","limiter","transient"],
    "EQ":          ["equalizer","equaliser","pultec","api 550","neve 1073"," eq "],
    "Distortion":  ["distortion","saturation","overdrive","fuzz","bitcrusher","harmonic exciter","lo-fi"],
    "Modulation":  ["chorus","flanger","phaser","tremolo","vibrato","rotary","leslie","auto-pan"],
    "Synths":      ["synthesizer","wavetable","fm synth","analog synth","serum","massive","vital","surge"],
    "Drums":       ["drum machine","drum kit","drum samples","808","tr-808","tr-909","percussion"],
    "Instruments": ["piano","electric piano","organ","guitar","bass guitar","violin","strings",
                    "orchestral","brass","woodwind","kontakt","sample library","rompler","sample pack"],
    "Mastering":   ["mastering","master bus","loudness","lufs","true peak","stereo imager"],
    "Utility":     ["tuner","spectrum analyzer","noise reduction","restoration","midi tool"],
}

def classify(text):
    lo = " " + text.lower() + " "
    for cat, kws in CATS.items():
        if any(k in lo for k in kws): return cat
    if re.search(r"\b(verb|hall|plate|shimmer)\b", lo):   return "Reverb"
    if re.search(r"\b(comp|vca|opto|glue)\b", lo):        return "Compression"
    if re.search(r"\b(kick|snare|hihat|tom|clap)\b", lo): return "Drums"
    if re.search(r"\b(synth|osc|lfo|arp)\b", lo):         return "Synths"
    return "Other"

def is_free(deal):
    if deal.get("current_price") in (0, None): return True
    notes = (deal.get("notes") or "").lower()
    name  = (deal.get("plugin_name") or "").lower()
    if re.search(r"discounted price is \$0", notes): return True
    if re.search(r"\b100\s*%\s*off\b", notes):       return True
    if re.search(r"\bfree\b", name) and not re.search(r"free\s*trial|drm.?free|free\s*update", name):
        return True
    if re.search(r"\b(giveaway|freebie|free\s+download|free\s+vst|free\s+plugin)\b", notes):
        return True
    return False

def deal_score(d):
    msrp  = d.get("msrp") or 0
    price = d.get("current_price") or 0
    disc  = min((msrp - price) / msrp * 100, 100) if msrp > 0 else 0
    hist_low = d.get("historical_low_price") or price
    hist_avg = d.get("historical_avg_sale_price") or msrp * 0.65
    vs_low   = 100 if price <= hist_low else (60 if price <= hist_avg else 20)
    freq     = min((d.get("sale_frequency_days") or 120) / 365, 1) * 100
    sent     = (d.get("sentiment") or 0.5) * 100
    return min(round(disc*.3 + vs_low*.3 + freq*.2 + sent*.2), 100)

def make_deal(**kw):
    price = kw.get("current_price")
    if price is None or (price < 5 and price != 0): return None
    msrp  = kw.get("msrp") or 0
    if msrp <= price: msrp = price * 2
    name = kw.get("plugin_name", "")
    if not name or len(name) < 3: return None
    d = {
        "id":                        uid(),
        "plugin_name":               name,
        "developer":                 kw.get("developer", "Various"),
        "category":                  kw.get("category", "Other"),
        "current_price":             price,
        "msrp":                      msrp,
        "historical_low_price":      price,
        "historical_avg_sale_price": round(msrp * 0.65),
        "sale_frequency_days":       120,
        "last_sale_dates":           kw.get("last_sale_dates", []),
        "url":                       kw.get("url", ""),
        "source":                    kw.get("source", ""),
        "timestamp":                 kw.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "deal_ends":                 kw.get("deal_ends"),
        "price_history":             [],
        "dev_discount_freq":         "unknown",
        "sentiment":                 kw.get("sentiment", 0.5),
        "notes":                     (kw.get("notes") or "")[:300],
        "comments":                  kw.get("comments", []),
    }
    d["deal_score"] = deal_score(d)
    d["is_free"]    = is_free(d)
    return d

def dedup(deals):
    seen, out = set(), []
    for d in deals:
        key = re.sub(r"[^a-z0-9]", "", (d["plugin_name"] or "").lower())[:20]
        if key and key not in seen:
            seen.add(key); out.append(d)
    return out

def enrich(deals, history):
    for d in deals:
        key = re.sub(r"[^a-z0-9]", "", d["plugin_name"].lower())[:25]
        h   = history.get(key, {})
        if h.get("historical_low"):
            d["historical_low_price"]      = min(h["historical_low"], d["current_price"])
            d["historical_avg_sale_price"] = h["historical_avg"]
            d["sale_frequency_days"]       = h.get("sale_frequency_days", 120)
            d["price_history"]             = [p["price"] for p in h.get("prices", [])]
            d["deal_score"]                = deal_score(d)
    return deals

# ════════════════════════════════════════════════════════════════
#  SCRAPERS
# ════════════════════════════════════════════════════════════════

def scrape_reddit():
    """Reddit public JSON API — works from any IP, no auth needed."""
    log.info("[reddit] fetching public JSON...")
    data = fetch(
        "https://www.reddit.com/r/AudioProductionDeals/new.json?limit=100&raw_json=1",
        json_mode=True
    )
    if not data:
        log.error("[reddit] failed"); return []

    deals  = []
    cutoff = THIRTY_DAYS.timestamp()

    for post in data.get("data", {}).get("children", []):
        p = post["data"]
        if p.get("stickied") or p.get("created_utc", 0) < cutoff: continue
        if re.search(r"discussion|question|meta|mod|weekly",
                     p.get("link_flair_text") or "", re.I): continue

        full  = f"{p.get('title','')} {p.get('selftext','')}"
        price = extract_price(p.get("title")) or extract_price(p.get("selftext",""))
        if price is None: continue

        title = re.sub(r"^\[.*?\]\s*", "", p.get("title",""))
        title = re.sub(r"\s*\(?\)?\s*(?:until|through|ends?)\s+\w+\s+\d+",
                       "", title, flags=re.I)
        name  = clean_name(title)
        if not name: continue

        ts  = datetime.fromtimestamp(p["created_utc"], tz=timezone.utc).isoformat()
        url = (p["url"] if not p.get("is_self") and "reddit.com" not in p.get("url","")
               else f"https://reddit.com{p['permalink']}")
        body = (p.get("selftext") or "")[:300]
        dev  = re.search(r"^\[([^\]]{2,35})\]", p.get("title",""))

        d = make_deal(
            plugin_name=name,
            developer=dev.group(1) if dev else "Various",
            category=classify(full),
            current_price=price,
            msrp=extract_msrp(full) or price * 2,
            url=url, source="Reddit r/AudioProductionDeals",
            timestamp=ts, last_sale_dates=[ts],
            sentiment=0.6, notes=body,
            comments=[body] if len(body) > 20 else [],
        )
        if d: deals.append(d)

    log.info(f"[reddit] {len(deals)} deals")
    return deals


def scrape_apg():
    """AudioPluginGuy — master reference, direct HTTP works fine."""
    log.info("[apg] fetching...")
    html = fetch("https://www.audiopluginguy.com/deals/")
    if not html:
        log.error("[apg] failed"); return [], {}

    s       = soup(html)
    history = {}
    current = []
    now     = datetime.now(timezone.utc)
    cutoff  = now - timedelta(days=60)

    for row in s.select("table tr, tbody tr"):
        cells = row.find_all("td")
        if len(cells) < 2: continue

        desc_cell    = cells[0]
        desc_text    = re.sub(r"\s+", " ", desc_cell.get_text(" ")).strip()
        discount_txt = cells[1].get_text(strip=True) if len(cells) > 1 else ""
        ends_txt     = cells[2].get_text(strip=True) if len(cells) > 2 else ""
        added_txt    = cells[3].get_text(strip=True) if len(cells) > 3 else ""

        if not desc_text or len(desc_text) < 10: continue

        deal_link = next(
            (a["href"] for a in desc_cell.find_all("a", href=True)
             if a["href"].startswith("http")), None)

        price = extract_price(desc_text)
        if price is None or (price < 5 and price != 0) or price > 999: continue

        name = None
        m = re.search(r"Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by\s+\w|\.)", desc_text, re.I)
        if m: name = clean_name(m.group(1).strip())
        if not name and "|" in desc_text:
            after = desc_text.split("|", 1)[1]
            m2 = re.search(r"Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by|\.)", after, re.I)
            if m2: name = clean_name(m2.group(1).strip())
        if not name: name = clean_name(desc_text.split(".")[0])
        if not name or len(name) < 2: continue

        developer = "Various"
        bm = re.search(r"by\s+([A-Z][a-zA-Z\s&.]{1,30})(?:\.|,|\s*$)", desc_text)
        if bm: developer = bm.group(1).strip()
        elif "|" in desc_text:
            developer = clean_name(desc_text.split("|")[0].strip()) or "Various"

        dn = re.search(r"\d+", discount_txt)
        disc_pct = int(dn.group()) if dn else 0
        msrp = round(price / (1 - disc_pct/100)) if 0 < disc_pct < 100 else price * 2

        deal_ends = None
        if re.search(r"\d{4}-\d{2}-\d{2}", ends_txt):
            try: deal_ends = datetime.strptime(ends_txt.strip(), "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
            except ValueError: pass

        ts = now.isoformat()
        if re.search(r"\d{4}-\d{2}-\d{2}", added_txt):
            try: ts = datetime.strptime(added_txt.strip(), "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
            except ValueError: pass

        key = re.sub(r"[^a-z0-9]", "", name.lower())[:25]
        if key not in history:
            history[key] = {"canonical_name": name, "developer": developer,
                            "prices": [], "msrp": msrp}
        history[key]["prices"].append({"price": price, "discount_pct": disc_pct,
                                        "date": ts, "deal_ends": deal_ends})
        if msrp > history[key]["msrp"]: history[key]["msrp"] = msrp

        try: added_dt = datetime.fromisoformat(ts)
        except ValueError: added_dt = now
        ends_dt = None
        if deal_ends:
            try: ends_dt = datetime.fromisoformat(deal_ends)
            except ValueError: pass
        if added_dt < cutoff and (not ends_dt or ends_dt < now): continue

        d = make_deal(
            plugin_name=name, developer=developer,
            category=classify(desc_text),
            current_price=price, msrp=msrp,
            url=deal_link or "https://www.audiopluginguy.com/deals/",
            source="AudioPluginGuy", timestamp=ts,
            last_sale_dates=[ts], deal_ends=deal_ends,
            sentiment=0.7, notes=desc_text[:300],
        )
        if d: current.append(d)

    # Compute history stats
    for h in history.values():
        prices = [p["price"] for p in h["prices"]]
        if prices:
            h["historical_low"] = min(prices)
            h["historical_avg"] = round(sum(prices) / len(prices))
            h["sale_count"]     = len(prices)
            dates = sorted([p["date"] for p in h["prices"] if p["date"]])
            if len(dates) >= 2:
                gaps = []
                for i in range(1, len(dates)):
                    try:
                        a = datetime.fromisoformat(dates[i-1])
                        b = datetime.fromisoformat(dates[i])
                        gaps.append(abs((b - a).days))
                    except ValueError: pass
                h["sale_frequency_days"] = round(sum(gaps)/len(gaps)) if gaps else 120
            else:
                h["sale_frequency_days"] = 120

    for d in current:
        key = re.sub(r"[^a-z0-9]", "", d["plugin_name"].lower())[:25]
        h   = history.get(key, {})
        if h.get("historical_low"):
            d["historical_low_price"]      = h["historical_low"]
            d["historical_avg_sale_price"] = h["historical_avg"]
            d["sale_frequency_days"]       = h.get("sale_frequency_days", 120)
            d["price_history"]             = [p["price"] for p in h["prices"]]
            d["deal_score"]                = deal_score(d)

    log.info(f"[apg] {len(current)} current deals, {len(history)} in history")
    return current, history


def scrape_rss_source(name, rss_urls, source_label, base_url):
    """
    Generic RSS scraper. Tries each URL until one works.
    RSS feeds bypass bot detection — designed for automated readers.
    """
    log.info(f"[{name}] fetching RSS...")
    xml_text = None
    for url in rss_urls:
        xml_text = fetch(url)
        if xml_text and ('<item' in xml_text or '<entry' in xml_text):
            log.info(f"[{name}] RSS working: {url}")
            break
        else:
            log.warning(f"[{name}] RSS failed or empty: {url}")
            xml_text = None

    if not xml_text:
        log.error(f"[{name}] all RSS URLs failed")
        return []

    items = parse_rss(xml_text)
    log.info(f"[{name}] parsed {len(items)} RSS items")

    deals = []
    seen  = set()
    junk  = {"save up to","promo code","your order","sign up","newsletter"}

    for item in items:
        title = re.sub(r"\s+", " ", item.get("title", "")).strip()
        desc  = re.sub(r"\s+", " ", item.get("description", "")).strip()
        link  = item.get("link", "") or base_url
        date  = item.get("date", "")

        # Skip junk titles
        if any(j in title.lower() for j in junk): continue
        if len(title) < 5: continue

        # Try to find price in title first, then description
        full_text = f"{title} {desc}"
        price = extract_price(title) or extract_price(desc)
        if price is None: continue

        name_str = clean_name(title)
        if not name_str: continue

        key = re.sub(r"[^a-z0-9]", "", name_str.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = parse_date(date)

        # Skip if older than 30 days
        try:
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt < THIRTY_DAYS:
                continue
        except ValueError:
            pass

        # Extract best URL from description links
        best_url = link
        if desc:
            links_in_desc = re.findall(r'href="(https?://[^"]+)"', desc)
            external = [u for u in links_in_desc if base_url.split("/")[2] not in u]
            if external:
                best_url = external[0]

        d = make_deal(
            plugin_name   = name_str,
            category      = classify(full_text),
            current_price = price,
            msrp          = extract_msrp(full_text) or price * 2,
            url           = best_url,
            source        = source_label,
            timestamp     = ts,
            last_sale_dates=[ts],
            sentiment     = 0.6,
            notes         = BeautifulSoup(desc, "lxml").get_text(" ", strip=True)[:300] if desc else title,
            comments      = [BeautifulSoup(desc, "lxml").get_text(" ", strip=True)[:200]] if desc and len(desc) > 30 else [],
        )
        if d: deals.append(d)

    log.info(f"[{name}] {len(deals)} deals from RSS")
    return deals


def scrape_kvr():
    return scrape_rss_source(
        name         = "kvr",
        rss_urls     = [
            "https://www.kvraudio.com/forum/feed.php?t=262151",
            "https://www.kvraudio.com/forum/feed.php?t=262151&start=0",
        ],
        source_label = "KVR Audio",
        base_url     = "https://www.kvraudio.com",
    )


def scrape_vi_control():
    return scrape_rss_source(
        name         = "vi-control",
        rss_urls     = [
            "https://vi-control.net/community/forums/deals-deals-deals.138/index.rss",
            "https://vi-control.net/community/forums/-/index.rss",
        ],
        source_label = "VI-Control",
        base_url     = "https://vi-control.net",
    )


def scrape_linked_musicians():
    # phpBB RSS: need the forum ID — common values to try
    return scrape_rss_source(
        name         = "linkedmusicians",
        rss_urls     = [
            "https://linkedmusicians.com/forums/feed.php",
            "https://linkedmusicians.com/forums/feed.php?f=23",
            "https://linkedmusicians.com/forums/feed.php?f=34",
        ],
        source_label = "LinkedMusicians",
        base_url     = "https://linkedmusicians.com",
    )


def scrape_cakewalk():
    return scrape_rss_source(
        name         = "cakewalk",
        rss_urls     = [
            "https://discuss.cakewalk.com/discussions/feed.rss?categoryID=34",
            "https://discuss.cakewalk.com/discussions/feed",
            "https://discuss.cakewalk.com/discussions/feed.rss",
        ],
        source_label = "Cakewalk Forum",
        base_url     = "https://discuss.cakewalk.com",
    )


# ════════════════════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════════════════════
def main():
    log.info("=== Plugin Copilot Scraper v2 (RSS + BeautifulSoup) ===")
    t0 = time.time()

    # APG first — builds history index for enrichment
    apg_deals, history = scrape_apg()

    reddit = enrich(scrape_reddit(),           history)
    kvr    = enrich(scrape_kvr(),              history)
    vic    = enrich(scrape_vi_control(),       history)
    lm     = enrich(scrape_linked_musicians(), history)
    cake   = enrich(scrape_cakewalk(),         history)

    all_deals = dedup([*apg_deals, *reddit, *kvr, *vic, *lm, *cake])
    all_deals.sort(key=lambda d: d.get("timestamp", ""), reverse=True)

    sources = {
        "apg":             len(apg_deals),
        "reddit":          len(reddit),
        "kvr":             len(kvr),
        "vic":             len(vic),
        "linkedMusicians": len(lm),
        "cakewalk":        len(cake),
        "total":           len(all_deals),
    }

    output = {
        "deals":   all_deals,
        "sources": sources,
        "updated": datetime.now(timezone.utc).isoformat(),
        "source":  "live",
    }

    out = Path(__file__).parent / "deals.json"
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    log.info(f"Wrote {len(all_deals)} deals → {out}")
    log.info(f"Sources: {sources}")
    log.info(f"Done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
