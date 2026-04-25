"""
Plugin Copilot — Scraper
========================
Uses:
  - requests + BeautifulSoup for APG (works fine from any IP)
  - Reddit public JSON API with a real User-Agent (no auth needed)
  - Playwright headless browser for KVR, VI-Control, LinkedMusicians, Cakewalk
    (browser connections bypass IP blocks that reject raw HTTP)

GitHub Actions install:
  pip install requests beautifulsoup4 lxml playwright
  playwright install chromium --with-deps

Output: deals.json
"""

import json, re, time, os, sys, logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
import requests
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

TIMEOUT        = 25
THIRTY_DAYS    = datetime.now(timezone.utc) - timedelta(days=30)
_uid           = 1000
BROWSER        = None   # shared Playwright browser instance

def uid():
    global _uid; _uid += 1; return _uid

# ── HTTP session (for APG + Reddit which don't block Azure) ──
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent":      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
})

def fetch_direct(url, json_mode=False):
    """Simple requests fetch — works for APG and Reddit JSON."""
    for attempt in range(3):
        try:
            r = SESSION.get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json() if json_mode else r.text
            log.warning(f"HTTP {r.status_code}: {url}")
            time.sleep(2 * (attempt + 1))
        except Exception as e:
            log.warning(f"Fetch error: {e}")
            time.sleep(2)
    return None

def fetch_browser(url):
    """
    Use Playwright headless Chromium to fetch pages that block cloud IPs.
    Returns HTML string or None.
    """
    global BROWSER
    try:
        from playwright.sync_api import sync_playwright
        if BROWSER is None:
            log.info("[browser] launching Chromium...")
            _pw = sync_playwright().start()
            BROWSER = _pw.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-setuid-sandbox",
                      "--disable-dev-shm-usage", "--disable-gpu"]
            )
        page = BROWSER.new_page(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            }
        )
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)   # let JS render
        html = page.content()
        page.close()
        return html
    except Exception as e:
        log.error(f"[browser] failed for {url}: {e}")
        return None

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

def get_ts(el, attr="datetime"):
    """Extract ISO timestamp from a time element."""
    if not el: return None
    val = el.get(attr) or el.get_text(strip=True)
    if not val: return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None

# ════════════════════════════════════════════════════════════════
#  SCRAPERS
# ════════════════════════════════════════════════════════════════

# ── Reddit — public JSON, no auth, works from any IP ─────────
def scrape_reddit():
    log.info("[reddit] fetching via public JSON API...")
    data = fetch_direct(
        "https://www.reddit.com/r/AudioProductionDeals/new.json"
        "?limit=100&raw_json=1",
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
        url = (p["url"] if not p.get("is_self")
               and "reddit.com" not in p.get("url","")
               else f"https://reddit.com{p['permalink']}")
        body = (p.get("selftext") or "")[:200]
        dev  = (re.search(r"^\[([^\]]{2,35})\]", p.get("title","")) or [None,None])
        d = make_deal(
            plugin_name=name,
            developer=dev[1] if dev[1] else "Various",
            category=classify(full),
            current_price=price,
            msrp=extract_msrp(full) or price*2,
            url=url, source="Reddit r/AudioProductionDeals",
            timestamp=ts, last_sale_dates=[ts],
            sentiment=0.6, notes=body,
            comments=[body] if len(body) > 20 else [],
        )
        if d: deals.append(d)

    log.info(f"[reddit] {len(deals)} deals")
    return deals

# ── AudioPluginGuy — works fine via requests ─────────────────
def scrape_apg():
    log.info("[apg] fetching...")
    html = fetch_direct("https://www.audiopluginguy.com/deals/")
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
        discount_txt = cells[1].get_text(strip=True) if len(cells)>1 else ""
        ends_txt     = cells[2].get_text(strip=True) if len(cells)>2 else ""
        added_txt    = cells[3].get_text(strip=True) if len(cells)>3 else ""

        if not desc_text or len(desc_text) < 10: continue

        deal_link = next(
            (a["href"] for a in desc_cell.find_all("a", href=True)
             if a["href"].startswith("http")), None)

        price = extract_price(desc_text)
        if price is None or (price < 5 and price != 0) or price > 999: continue

        name = None
        m = re.search(r"Get\s+\d+%\s+off\s+([^.]+?)(?:\s+by\s+\w|\.)",
                      desc_text, re.I)
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
        msrp = round(price/(1-disc_pct/100)) if 0 < disc_pct < 100 else price*2

        deal_ends = None
        if re.search(r"\d{4}-\d{2}-\d{2}", ends_txt):
            try: deal_ends = datetime.strptime(ends_txt.strip(),"%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
            except ValueError: pass

        ts = now.isoformat()
        if re.search(r"\d{4}-\d{2}-\d{2}", added_txt):
            try: ts = datetime.strptime(added_txt.strip(),"%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
            except ValueError: pass

        key = re.sub(r"[^a-z0-9]", "", name.lower())[:25]
        if key not in history:
            history[key] = {"canonical_name":name,"developer":developer,
                            "prices":[],"msrp":msrp}
        history[key]["prices"].append({"price":price,"discount_pct":disc_pct,
                                        "date":ts,"deal_ends":deal_ends})
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
            sentiment=0.7, notes=desc_text[:200],
        )
        if d: current.append(d)

    # Compute history stats
    for h in history.values():
        prices = [p["price"] for p in h["prices"]]
        if prices:
            h["historical_low"] = min(prices)
            h["historical_avg"] = round(sum(prices)/len(prices))
            h["sale_count"]     = len(prices)
            dates = sorted([p["date"] for p in h["prices"] if p["date"]])
            if len(dates) >= 2:
                gaps = []
                for i in range(1, len(dates)):
                    try:
                        a = datetime.fromisoformat(dates[i-1])
                        b = datetime.fromisoformat(dates[i])
                        gaps.append(abs((b-a).days))
                    except ValueError: pass
                h["sale_frequency_days"] = round(sum(gaps)/len(gaps)) if gaps else 120
            else:
                h["sale_frequency_days"] = 120

    # Enrich current deals with their own history
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

# ── KVR Audio — needs browser ─────────────────────────────────
def scrape_kvr():
    log.info("[kvr] fetching via browser...")
    html = fetch_browser("https://www.kvraudio.com/forum/viewtopic.php?t=262151&start=25500")
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
        msrp = extract_msrp(text) or price*2
        if msrp <= price: continue

        before = text.split("$")[0].strip()
        lines  = [l.strip() for l in re.split(r"[.!\n]", before)
                  if 3 < len(l.strip()) < 100]
        raw    = lines[-1] if lines else before[:80]
        name   = clean_name(re.sub(r"\$[\d.]+","",raw).strip())
        if not name: continue

        key = re.sub(r"[^a-z0-9]","",name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        wrap = post_body.parent
        if wrap:
            te = wrap.select_one("time[datetime]")
            if te:
                ts = get_ts(te) or ts

        deal_url = "https://www.kvraudio.com/forum/viewtopic.php?t=262151"
        for a in content_el.find_all("a", href=True):
            if a["href"].startswith("http") and "kvraudio.com" not in a["href"]:
                deal_url = a["href"]; break

        d = make_deal(
            plugin_name=name, category=classify(text),
            current_price=price, msrp=msrp,
            url=deal_url, source="KVR Audio",
            timestamp=ts, last_sale_dates=[ts],
            sentiment=0.6, notes=text[:200],
            comments=[text[:180]] if len(text)>30 else [],
        )
        if d: deals.append(d)

    log.info(f"[kvr] {len(deals)} deals")
    return deals[:25]

# ── VI-Control — needs browser ────────────────────────────────
def scrape_vi_control():
    log.info("[vi-control] fetching via browser...")
    html = fetch_browser("https://vi-control.net/community/forums/deals-deals-deals.138/")
    if not html:
        log.error("[vi-control] failed"); return []

    s     = soup(html)
    deals = []
    seen  = set()
    junk  = {"save up to","promo code","your order","sign up","newsletter","easter"}

    rows = s.select("div.structItem--thread,li.structItem--thread") or \
           s.select("a[href*='/community/threads/']")

    for item in rows:
        title_el = item.select_one(".structItem-title") or item
        text     = re.sub(r"\s+"," ",title_el.get_text(" ")).strip()
        link_el  = title_el.select_one("a") or (item if item.name=="a" else None)
        href     = link_el.get("href","") if link_el else ""

        if any(j in text.lower() for j in junk): continue
        if re.match(r"^(save|get|up to|\d+%)", text, re.I): continue

        price = extract_price(text)
        if price is None: continue
        name = clean_name(text)
        if not name: continue

        key = re.sub(r"[^a-z0-9]","",name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        te = item.select_one("time[datetime]")
        if te: ts = get_ts(te) or ts

        url = href if href.startswith("http") else f"https://vi-control.net{href}"
        d = make_deal(
            plugin_name=name, category=classify(text),
            current_price=price, msrp=extract_msrp(text) or price*2,
            url=url, source="VI-Control",
            timestamp=ts, last_sale_dates=[ts], notes=text,
        )
        if d: deals.append(d)

    log.info(f"[vi-control] {len(deals)} deals")
    return deals[:20]

# ── LinkedMusicians — needs browser ──────────────────────────
def scrape_linked_musicians():
    log.info("[linkedmusicians] fetching via browser...")
    html = fetch_browser(
        "https://linkedmusicians.com/forums/forum/deals/"
        "virtual-instruments-vsts-effects-plugins-sample-libraries/"
    )
    if not html:
        log.error("[linkedmusicians] failed"); return []

    s     = soup(html)
    deals = []
    seen  = set()
    links = []
    for sel in ["a.topictitle","li.row dl dt a","a[href*='viewtopic']",
                ".topic-title a","h2 a","h3 a"]:
        links = s.select(sel)
        if links: break

    for a in links:
        text = re.sub(r"\s+"," ",a.get_text(" ")).strip()
        href = a.get("href","")
        if len(text)<8 or len(text)>200: continue
        price = extract_price(text)
        if price is None: continue
        name = clean_name(text)
        if not name: continue

        key = re.sub(r"[^a-z0-9]","",name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        container = a.find_parent(["li","tr","div"])
        if container:
            te = container.select_one("time[datetime]")
            if te: ts = get_ts(te) or ts

        url = href if href.startswith("http") else f"https://linkedmusicians.com{href}"
        d = make_deal(
            plugin_name=name, category=classify(text),
            current_price=price, msrp=extract_msrp(text) or price*2,
            url=url, source="LinkedMusicians",
            timestamp=ts, last_sale_dates=[ts], notes=text,
        )
        if d: deals.append(d)

    log.info(f"[linkedmusicians] {len(deals)} deals")
    return deals[:20]

# ── Cakewalk — needs browser ──────────────────────────────────
def scrape_cakewalk():
    log.info("[cakewalk] fetching via browser...")
    html = fetch_browser("https://discuss.cakewalk.com/forum/34-deals/")
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
        text = re.sub(r"\s+"," ",a.get_text(" ")).strip()
        href = a.get("href","")
        if len(text)<8 or len(text)>200: continue
        if "/discussion/" not in href and "/forum/" not in href: continue
        price = extract_price(text)
        if price is None: continue
        name = clean_name(text)
        if not name: continue

        key = re.sub(r"[^a-z0-9]","",name.lower())[:18]
        if key in seen: continue
        seen.add(key)

        ts = datetime.now(timezone.utc).isoformat()
        container = a.find_parent(["li","tr",".Item"])
        if container:
            te = container.select_one("time[datetime],.DateCreated time")
            if te: ts = get_ts(te) or ts

        url = href if href.startswith("http") else f"https://discuss.cakewalk.com{href}"
        d = make_deal(
            plugin_name=name, category=classify(text),
            current_price=price, msrp=extract_msrp(text) or (price*2 if price>0 else 0),
            url=url, source="Cakewalk Forum",
            timestamp=ts, last_sale_dates=[ts], notes=text,
        )
        if d: deals.append(d)

    log.info(f"[cakewalk] {len(deals)} deals")
    return deals[:20]

# ════════════════════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════════════════════
def main():
    global BROWSER
    log.info("=== Plugin Copilot Scraper (BeautifulSoup + Playwright) ===")
    t0 = time.time()

    apg_deals, history = scrape_apg()
    reddit = enrich(scrape_reddit(),           history)
    kvr    = enrich(scrape_kvr(),              history)
    vic    = enrich(scrape_vi_control(),       history)
    lm     = enrich(scrape_linked_musicians(), history)
    cake   = enrich(scrape_cakewalk(),         history)

    # Close browser
    if BROWSER:
        try: BROWSER.close()
        except: pass

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

    out = Path(__file__).parent / "deals.json"
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    log.info(f"Wrote {len(all_deals)} deals → {out}")
    log.info(f"Sources: {sources}")
    log.info(f"Done in {time.time()-t0:.1f}s")

if __name__ == "__main__":
    main()
