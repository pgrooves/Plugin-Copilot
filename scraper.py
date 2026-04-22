"""
Plugin Copilot — BeautifulSoup Scraper
=======================================
Scrapes audio plugin deals from:
  - Reddit r/AudioProductionDeals (public JSON API)
  - KVR Audio deals thread
  - VI-Control deals forum
  - AudioPluginGuy.com/deals  (master historical reference)
  - LinkedMusicians deals
  - Cakewalk Forum deals

Output: deals.json committed to repo by GitHub Actions

Install:  pip install requests beautifulsoup4 lxml
Run:      python scraper.py
"""

import json
import re
import time
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
})
TIMEOUT = 20
THIRTY_DAYS_AGO = datetime.now(timezone.utc) - timedelta(days=30)
_uid = 1000


def uid():
    global _uid
    _uid += 1
    return _uid


def fetch(url, json_mode=False, retries=2):
    for attempt in range(retries + 1):
        try:
            r = SESSION.get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json() if json_mode else r.text
            log.warning(f"HTTP {r.status_code} for {url}")
            if r.status_code in (403, 429) and attempt < retries:
                time.sleep(3 * (attempt + 1))
        except Exception as e:
            log.warning(f"Fetch error ({url}): {e}")
            if attempt < retries:
                time.sleep(2)
    return None


def soup(html):
    return BeautifulSoup(html, "lxml")


# ── Price helpers ─────────────────────────────────────────────
def extract_price(text):
    if not text:
        return None
    t = text.lower()
    if re.search(r"discounted price is \$0", t):
        return 0
    if re.search(r"\b100\s*%\s*off\b", t) and not re.search(r"\$[1-9]", t):
        return 0
    if re.search(r"\bfree\s+(download|plugin|vst|instrument|sample pack|tool)\b", t) and not re.search(r"\$[1-9]", t):
        return 0
    matches = [float(m) for m in re.findall(r"\$\s*(\d{1,3}(?:\.\d{1,2})?)", text)]
    matches = [p for p in matches if 5 <= p <= 999 and not (p < 10 and "." in f"{p}")]
    return min(matches) if matches else None


def extract_msrp(text):
    if not text:
        return None
    m = re.search(
        r"(?:was|reg(?:ular)?|msrp|rrp|retail|orig(?:inal)?|full price)\s*:?\s*\$\s*(\d{1,3}(?:\.\d{1,2})?)",
        text, re.I
    )
    if m:
        return float(m.group(1))
    m = re.search(r"\$(\d{1,3})\s*/\s*\$(\d{1,3})", text)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        return b if b > a else None
    return None


def clean_name(raw):
    if not raw:
        return None
    name = re.sub(r"^\[.*?\]\s*", "", raw)
    name = re.sub(r"\$[\d,]+(?:\.\d{1,2})?", "", name)
    name = re.sub(r"\d+\s*%\s*off\b", "", name, flags=re.I)
    name = re.sub(r"\((?:reg|was|msrp|retail|save)[^)]{0,30}\)", "", name, flags=re.I)
    name = re.sub(r"\s*\|.*$", "", name)
    name = re.sub(r"[,:!]+$", "", name)
    name = re.sub(r"\s{2,}", " ", name).strip()
    if not name or len(name) < 3:
        return None
    lo = re.sub(r"[^a-z0-9]", "", name.lower())
    junk = {"free","deal","sale","unknown","various","plugin","audio","music",
            "software","app","get","new","now","save","buy","the","and","for"}
    if lo in junk:
        return None
    return name[:80]


# ── Category ──────────────────────────────────────────────────
CATS = {
    "Reverb":      ["reverb","room verb","plate verb","spring verb","convolution","impulse response"],
    "Delay":       ["delay","tape echo","ping pong","echo plugin"],
    "Compression": ["compressor","compression","bus comp","1176","la-2a","limiter","transient"],
    "EQ":          ["equalizer","equaliser","pultec","api 550","neve 1073"," eq "],
    "Distortion":  ["distortion","saturation","overdrive","fuzz","bitcrusher","harmonic exciter","lo-fi"],
    "Modulation":  ["chorus","flanger","phaser","tremolo","vibrato","rotary","leslie","auto-pan"],
    "Synths":      ["synthesizer","wavetable","fm synth","analog synth","serum","massive","vital","surge"],
    "Drums":       ["drum machine","drum kit","drum samples","808","tr-808","tr-909","percussion"],
    "Instruments": ["piano","electric piano","organ","guitar","bass guitar","violin","cello","strings",
                    "orchestral","brass","woodwind","kontakt","sample library","rompler","sample pack"],
    "Mastering":   ["mastering","master bus","loudness","lufs","true peak","stereo imager"],
    "Utility":     ["tuner","spectrum analyzer","noise reduction","restoration","midi tool"],
}


def classify(text):
    lo = " " + text.lower() + " "
    for cat, kws in CATS.items():
        if any(k in lo for k in kws):
            return cat
    if re.search(r"\b(verb|hall|plate|shimmer)\b", lo):    return "Reverb"
    if re.search(r"\b(comp|vca|opto|glue)\b", lo):         return "Compression"
    if re.search(r"\b(kick|snare|hihat|tom|clap)\b", lo):  return "Drums"
    if re.search(r"\b(synth|osc|lfo|arp)\b", lo):          return "Synths"
    return "Other"


def is_free(deal):
    if deal.get("current_price") in (0, None):
        return True
    notes = (deal.get("notes") or "").lower()
    name  = (deal.get("plugin_name") or "").lower()
    if re.search(r"discounted price is \$0", notes):  return True
    if re.search(r"\b100\s*%\s*off\b", notes):        return True
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
    return min(round(disc * 0.3 + vs_low * 0.3 + freq * 0.2 + sent * 0.2), 100)


def make_deal(**kw):
    price = kw.get("current_price")
    if price is None or (price < 5 and price != 0):
        return None
    msrp = kw.get("msrp") or 0
    if msrp <= price:
        msrp = price * 2
    name = kw.get("plugin_name", "")
    if not name or len(name) < 3:
        return None
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
        "notes":                     (kw.get("notes") or "")[:200],
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
            seen.add(key)
            out.append(d)
    return out


# ════════════════════════════════════════════════════════════════
#  SCRAPERS
# ════════════════════════════════════════════════════════════════

def scrape_reddit():
    log.info("[reddit] fetching...")
    data = fetch(
        "https://www.reddit.com/r/AudioProductionDeals/new.json?limit=100&raw_json=1",
        json_mode=True
    )
    if not data:
        log.error("[reddit] failed"); return []

    deals   = []
    cutoff  = THIRTY_DAYS_AGO.timestamp()

    for post in data.get("data", {}).get("children", []):
        p = post["data"]
        if p.get("stickied") or p.get("created_utc", 0) < cutoff:
            continue
        if re.search(r"discussion|question|meta|mod|weekly", p.get("link_flair_text") or "", re.I):
            continue

        full  = f"{p.get('title','')} {p.get('selftext','')}"
        price = extract_price(p.get("title")) or extract_price(p.get("selftext",""))
        if price is None:
            continue

        title = re.sub(r"^\[.*?\]\s*", "", p.get("title",""))
        title = re.sub(r"\s*\(?\)?\s*(?:until|through|ends?)\s+\w+\s+\d+", "", title, flags=re.I)
        name  = clean_name(title)
        if not name:
            continue

        ts  = datetime.fromtimestamp(p["created_utc"], tz=timezone.utc).isoformat()
        url = p["url"] if not p.get("is_self") and "reddit.com" not in p.get("url","") \
              else f"https://reddit.com{p['permalink']}"
        body = (p.get("selftext") or "")[:200]

        dev_match = re.search(r"^\[([^\]]{2,35})\]", p.get("title",""))
        d = make_deal(
            plugin_name   = name,
            developer     = dev_match.group(1) if dev_match else "Various",
            category      = classify(full),
            current_price = price,
            msrp          = extract_msrp(full) or price * 2,
            url           = url,
            source        = "Reddit r/AudioProductionDeals",
            timestamp     = ts,
            last_sale_dates=[ts],
            sentiment     = 0.6,
            notes         = body,
            comments      = [body] if len(body) > 20 else [],
        )
        if d: deals.append(d)

    log.info(f"[reddit] {len(deals)} deals")
    return deals


def scrape_apg():
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
        if len(cells) < 2:
            continue

        desc_cell    = cells[0]
        desc_text    = re.sub(r"\s+", " ", desc_cell.get_text(" ")).strip()
        discount_txt = cells[1].get_text(strip=True) if len(cells) > 1 else ""
        ends_txt     = cells[2].get_text(strip=True) if len(cells) > 2 else ""
        added_txt    = cells[3].get_text(strip=True) if len(cells) > 3 else ""

        if not desc_text or len(desc_text) < 10:
            continue

        # Actual deal link from cell
        deal_link = None
        for a in desc_cell.find_all("a", href=True):
            if a["href"].startswith("http"):
                deal_link = a["href"]; break

        price = extract_price(desc_text)
        if price is None or (price < 5 and price != 0) or price > 999:
            continue

        # Plugin name
        name = None
        m = re.search(r"Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by\s+\w|\.)", desc_text, re.I)
        if m:
            name = clean_name(m.group(1).strip())
        if not name and "|" in desc_text:
            after = desc_text.split("|", 1)[1]
            m2 = re.search(r"Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by|\.)", after, re.I)
            if m2: name = clean_name(m2.group(1).strip())
        if not name:
            name = clean_name(desc_text.split(".")[0])
        if not name or len(name) < 2:
            continue

        developer = "Various"
        bm = re.search(r"by\s+([A-Z][a-zA-Z\s&.]{1,30})(?:\.|,|\s*$)", desc_text)
        if bm:
            developer = bm.group(1).strip()
        elif "|" in desc_text:
            developer = clean_name(desc_text.split("|")[0].strip()) or "Various"

        dn = re.search(r"\d+", discount_txt)
        disc_pct = int(dn.group()) if dn else 0
        msrp = round(price / (1 - disc_pct/100)) if 0 < disc_pct < 100 else price * 2

        deal_ends = None
        if re.search(r"\d{4}-\d{2}-\d{2}", ends_txt):
            try:
                deal_ends = datetime.strptime(ends_txt.strip(), "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
            except ValueError: pass

        ts = now.isoformat()
        if re.search(r"\d{4}-\d{2}-\d{2}", added_txt):
            try:
                ts = datetime.strptime(added_txt.strip(), "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
            except ValueError: pass

        # Build history
        key = re.sub(r"[^a-z0-9]", "", name.lower())[:25]
        if key not in history:
            history[key] = {"canonical_name": name, "developer": developer, "prices": [], "msrp": msrp}
        history[key]["prices"].append({"price": price, "discount_pct": disc_pct, "date": ts, "deal_ends": deal_ends})
        if msrp > history[key]["msrp"]:
            history[key]["msrp"] = msrp

        # Current deal check
        try:
            added_dt = datetime.fromisoformat(ts)
        except ValueError:
            added_dt = now
        ends_dt = None
        if deal_ends:
            try: ends_dt = datetime.fromisoformat(deal_ends)
            except ValueError: pass

        if added_dt < cutoff and (not ends_dt or ends_dt < now):
            continue

        d = make_deal(
            plugin_name   = name,
            developer     = developer,
            category      = classify(desc_text),
            current_price = price,
            msrp          = msrp,
            url           = deal_link or "https://www.audiopluginguy.com/deals/",
            source        = "AudioPluginGuy",
            timestamp     = ts,
            last_sale_dates=[ts],
            deal_ends     = deal_ends,
            sentiment     = 0.7,
            notes         = desc_text[:200],
        )
        if d: current.append(d)

    # Compute stats for history
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

    # Enrich current deals
    enriched = []
    for d in current:
        key = re.sub(r"[^a-z0-9]", "", d["plugin_name"].lower())[:25]
        h   = history.get(key, {})
        if h.get("historical_low"):
            d["historical_low_price"]      = h["historical_low"]
            d["historical_avg_sale_price"] = h["historical_avg"]
            d["sale_frequency_days"]       = h.get("sale_frequency_days", 120)
            d["price_history"]             = [p["price"] for p in h["prices"]]
            d["deal_score"]                = deal_score(d)
        enriched.append(d)

    log.info(f"[apg] {len(enriched)} current deals, {len(history)} plugins in history")
    return enriched, history


def scrape_kvr():
    log.info("[kvr] fetching...")
    html = fetch("https://www.kvraudio.com/forum/viewtopic.php?t=262151&start=25500")
    if not html:
        log.error("[kvr] failed"); return []

    s     = soup(html)
    deals = []
    seen  = set()

    for post_body in s.select("div.postbody"):
        for el in post_body.select("blockquote,.quotecontent,.sig"):
            el.decompose()
        content_el = post_body.select_one("div.content")
        if not content_el: continue
        text = re.sub(r"\s+", " ", content_el.get_text(" ")).strip()

        price = extract_price(text)
        if not price or price > 600: continue
        msrp = extract_msrp(text) or price * 2
        if msrp <= price: continue

        before = text.split("$")[0].strip()
        lines  = [l.strip() for l in re.split(r"[.!\n]", before) if 3 < len(l.strip()) < 100]
        raw    = lines[-1] if lines else before[:80]
        name   = clean_name(re.sub(r"\$[\d.]+", "", raw).strip())
        if not name: continue

        key = re.sub(r"[^a-z0-9]", "", name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        wrap = post_body.parent
        if wrap:
            te = wrap.select_one("time[datetime]")
            if te and te.get("datetime"):
                try: ts = datetime.fromisoformat(te["datetime"].replace("Z","+00:00")).isoformat()
                except ValueError: pass

        deal_url = "https://www.kvraudio.com/forum/viewtopic.php?t=262151"
        for a in content_el.find_all("a", href=True):
            if a["href"].startswith("http") and "kvraudio.com" not in a["href"]:
                deal_url = a["href"]; break

        d = make_deal(
            plugin_name   = name,
            category      = classify(text),
            current_price = price,
            msrp          = msrp,
            url           = deal_url,
            source        = "KVR Audio",
            timestamp     = ts,
            last_sale_dates=[ts],
            sentiment     = 0.6,
            notes         = text[:200],
            comments      = [text[:180]] if len(text) > 30 else [],
        )
        if d: deals.append(d)

    log.info(f"[kvr] {len(deals)} deals")
    return deals[:25]


def scrape_vi_control():
    log.info("[vi-control] fetching...")
    html = fetch("https://vi-control.net/community/forums/deals-deals-deals.138/")
    if not html:
        log.error("[vi-control] failed"); return []

    s     = soup(html)
    deals = []
    seen  = set()
    junk  = {"save up to","promo code","your order","sign up","newsletter","easter"}

    rows = s.select("div.structItem--thread, li.structItem--thread") or \
           s.select("a[href*='/community/threads/']")

    for item in rows:
        title_el = item.select_one(".structItem-title") or item
        text     = re.sub(r"\s+", " ", title_el.get_text(" ")).strip()
        link_el  = title_el.select_one("a") or (item if item.name == "a" else None)
        href     = link_el.get("href","") if link_el else ""

        if any(j in text.lower() for j in junk): continue
        if re.match(r"^(save|get|up to|\d+%)", text, re.I): continue

        price = extract_price(text)
        if price is None: continue
        name = clean_name(text)
        if not name: continue

        key = re.sub(r"[^a-z0-9]", "", name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        te = item.select_one("time[datetime]")
        if te and te.get("datetime"):
            try: ts = datetime.fromisoformat(te["datetime"].replace("Z","+00:00")).isoformat()
            except ValueError: pass

        url = href if href.startswith("http") else f"https://vi-control.net{href}"
        d = make_deal(
            plugin_name   = name,
            category      = classify(text),
            current_price = price,
            msrp          = extract_msrp(text) or price * 2,
            url           = url,
            source        = "VI-Control",
            timestamp     = ts,
            last_sale_dates=[ts],
            notes         = text,
        )
        if d: deals.append(d)

    log.info(f"[vi-control] {len(deals)} deals")
    return deals[:20]


def scrape_linked_musicians():
    log.info("[linkedmusicians] fetching...")
    html = fetch(
        "https://linkedmusicians.com/forums/forum/deals/"
        "virtual-instruments-vsts-effects-plugins-sample-libraries/"
    )
    if not html:
        log.error("[linkedmusicians] failed"); return []

    s       = soup(html)
    deals   = []
    seen    = set()
    links   = []
    for sel in ["a.topictitle","li.row dl dt a","a[href*='viewtopic']",
                ".topic-title a","h2 a","h3 a"]:
        links = s.select(sel)
        if links: break

    for a in links:
        text = re.sub(r"\s+", " ", a.get_text(" ")).strip()
        href = a.get("href","")
        if len(text) < 8 or len(text) > 200: continue
        price = extract_price(text)
        if price is None: continue
        name = clean_name(text)
        if not name: continue
        key = re.sub(r"[^a-z0-9]", "", name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        container = a.find_parent(["li","tr","div"])
        if container:
            te = container.select_one("time[datetime]")
            if te and te.get("datetime"):
                try: ts = datetime.fromisoformat(te["datetime"].replace("Z","+00:00")).isoformat()
                except ValueError: pass

        url = href if href.startswith("http") else f"https://linkedmusicians.com{href}"
        d = make_deal(
            plugin_name   = name,
            category      = classify(text),
            current_price = price,
            msrp          = extract_msrp(text) or price * 2,
            url           = url,
            source        = "LinkedMusicians",
            timestamp     = ts,
            last_sale_dates=[ts],
            notes         = text,
        )
        if d: deals.append(d)

    log.info(f"[linkedmusicians] {len(deals)} deals")
    return deals[:20]


def scrape_cakewalk():
    log.info("[cakewalk] fetching...")
    html = fetch("https://discuss.cakewalk.com/forum/34-deals/")
    if not html:
        log.error("[cakewalk] failed"); return []

    s     = soup(html)
    deals = []
    seen  = set()
    links = []
    for sel in [".ItemLink a",".Title a","a[href*='/discussion/']","h3 a","h4 a"]:
        links = s.select(sel)
        if links: break

    for a in links:
        text = re.sub(r"\s+", " ", a.get_text(" ")).strip()
        href = a.get("href","")
        if len(text) < 8 or len(text) > 200: continue
        if "/discussion/" not in href and "/forum/" not in href: continue
        price = extract_price(text)
        if price is None: continue
        name = clean_name(text)
        if not name: continue
        key = re.sub(r"[^a-z0-9]", "", name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        container = a.find_parent(["li","tr",".Item"])
        if container:
            te = container.select_one("time[datetime],.DateCreated time")
            if te and te.get("datetime"):
                try: ts = datetime.fromisoformat(te["datetime"].replace("Z","+00:00")).isoformat()
                except ValueError: pass

        url = href if href.startswith("http") else f"https://discuss.cakewalk.com{href}"
        d = make_deal(
            plugin_name   = name,
            category      = classify(text),
            current_price = price,
            msrp          = extract_msrp(text) or (price * 2 if price > 0 else 0),
            url           = url,
            source        = "Cakewalk Forum",
            timestamp     = ts,
            last_sale_dates=[ts],
            notes         = text,
        )
        if d: deals.append(d)

    log.info(f"[cakewalk] {len(deals)} deals")
    return deals[:20]


def enrich_with_history(deals, history):
    for d in deals:
        key = re.sub(r"[^a-z0-9]", "", d["plugin_name"].lower())[:25]
        h   = history.get(key, {})
        if h.get("historical_low"):
            d["historical_low_price"]      = min(h["historical_low"], d["current_price"])
            d["historical_avg_sale_price"] = h["historical_avg"]
            d["sale_frequency_days"]       = h.get("sale_frequency_days", 120)
            d["price_history"]             = [p["price"] for p in h.get("prices",[])]
            d["deal_score"]                = deal_score(d)
    return deals


# ════════════════════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════════════════════
def main():
    log.info("=== Plugin Copilot Scraper (BeautifulSoup) ===")
    t0 = time.time()

    apg_deals, history = scrape_apg()
    reddit  = enrich_with_history(scrape_reddit(),           history)
    kvr     = enrich_with_history(scrape_kvr(),              history)
    vic     = enrich_with_history(scrape_vi_control(),       history)
    lm      = enrich_with_history(scrape_linked_musicians(), history)
    cake    = enrich_with_history(scrape_cakewalk(),         history)

    all_deals = dedup([*apg_deals, *reddit, *kvr, *vic, *lm, *cake])
    all_deals.sort(key=lambda d: d.get("timestamp",""), reverse=True)

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

    out_path = Path(__file__).parent / "deals.json"
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    log.info(f"Wrote {len(all_deals)} deals to {out_path}")
    log.info(f"Sources: {sources}")
    log.info(f"Done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
