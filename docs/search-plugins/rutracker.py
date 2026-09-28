#!/usr/bin/env python3
# havvn-network: 1
"""
RuTracker search plugin for Havvn.

RuTracker is login-gated and has no public API, so this plugin logs in with YOUR
account, searches, and returns magnet links. It uses only the Python standard
library (no `pip install` needed).

CREDENTIALS — set in Havvn, NOT in this file:
    Add a provider of type "Python Script" pointing at this file, then fill in the
    Login and Password fields. Havvn passes them to this script as the
    environment variables TH_USERNAME / TH_PASSWORD (your real password is stored
    encrypted by the OS keychain, never in plaintext on disk).

    Captcha fallback: if RuTracker demands a captcha on login (common from a new
    IP), log in via your browser, copy the value of the `bb_session` cookie, and
    put `cookie:<that-value>` in the Password field — the plugin will use the
    cookie directly and skip the login form.

NOTES:
    - RuTracker pages are windows-1251 encoded and often gzipped — handled here.
    - It's blocked by some ISPs; the plugin tries .org / .net / .nl in turn.
      Havvn's DNS-over-HTTPS does NOT apply to this separate Python process.
      Python needs working system connectivity (or an HTTPS_PROXY environment).
    - The search results page has no infohash, so the plugin fetches the top
      results' topic pages (concurrently) to extract their magnet links. Result
      count is capped to stay within Havvn's 25 s / 8 MB script limits.
    - Only run plugins you trust; this one talks only to rutracker mirrors.
"""

import sys
import os
import re
import json
import gzip
import io
import html
import subprocess
import http.cookiejar
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

MIRRORS = [
    "https://rutracker.net/forum",
]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
MAX_RESULTS = 20          # topic pages we'll fetch for magnets (cost vs. timeout)
REQ_TIMEOUT = 4           # leave time to try mirrors within Havvn's limit
SEARCH_TIMEOUT = 21       # hard deadline, including DNS/TLS and worker shutdown
MAGNET_WORKERS = 10

MAGNET_RE = re.compile(r'href="(magnet:\?xt=urn:btih:[^"]+)"', re.IGNORECASE)


def _err(msg):
    print(f"rutracker: {msg}", file=sys.stderr)


def _build_opener():
    jar = http.cookiejar.CookieJar()
    if os.environ.get("HAVVN_NETWORK_URL"):
        opener = urllib.request.OpenerDirector()
        opener.add_handler(urllib.request.HTTPCookieProcessor(jar))
        return opener, jar
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def _request(opener, url, data=None):
    """GET (or POST if data) a URL, returning decoded (cp1251) text."""
    headers = {
        "User-Agent": UA,
        "Accept-Encoding": "gzip",
        "Accept-Language": "ru,en;q=0.8",
    }
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data, encoding="cp1251").encode("cp1251")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers)
    if os.environ.get("HAVVN_NETWORK_URL"):
        from havvn_network import request, browser_html
        if body is None:
            return browser_html(url)
        # Preserve explicitly supplied cookie:<value> without exporting the jar.
        for handler in opener.handlers:
            if isinstance(handler, urllib.request.HTTPCookieProcessor):
                handler.cookiejar.add_cookie_header(req)
        raw = request(url, data=body, headers=dict(req.header_items()))
        return raw.decode("cp1251", "replace")
    with opener.open(req, timeout=REQ_TIMEOUT) as resp:
        raw = resp.read()
        if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    return raw.decode("cp1251", "replace")


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
def _is_login_page(html):
    return 'name="login_username"' in html and 'name="login_password"' in html


def _has_captcha(html):
    return "cap_sid" in html or bool(re.search(r"<(?:input|img|iframe|div)\b[^>]*(?:captcha|recaptcha)", html, re.I))


def _login(opener, base, username, password):
    """Log in via the form. Returns True on success. Raises on captcha."""
    html = _request(opener, base + "/login.php", data={
        "login_username": username,
        "login_password": password,
        "login": "вход",  # the submit button's value (cp1251-encoded on send)
    })
    if _has_captcha(html) and _is_login_page(html):
        raise RuntimeError(
            "RuTracker requires a captcha. Log in via your browser, copy the "
            "'bb_session' cookie, and put cookie:<value> in the Password field."
        )
    # Success if we're no longer shown the login form.
    return not _is_login_page(html)


def _set_session_cookie(jar, base, value):
    host = urllib.parse.urlparse(base).hostname
    jar.set_cookie(http.cookiejar.Cookie(
        version=0, name="bb_session", value=value, port=None, port_specified=False,
        domain=host, domain_specified=True, domain_initial_dot=False, path="/",
        path_specified=True, secure=True, expires=None, discard=False,
        comment=None, comment_url=None, rest={},
    ))


# --------------------------------------------------------------------------
# Parsing (pure functions — exercised by --selftest)
# --------------------------------------------------------------------------
def parse_search_rows(page):
    """Extract result rows from a tracker.php results page.

    Each row yields: topic id, title, size (bytes), seeds, leechers, category.
    The TITLE is the topic link (href=viewtopic.php?t=ID); the CATEGORY is the
    forum link (href=tracker.php?f=ID). NOTE: RuTracker puts data-topic_id on the
    <tr> itself, so the title must be matched by the viewtopic href — not by
    data-topic_id, which would grab the first <a> in the row (the forum link)."""
    rows = []
    for block in re.split(r'<tr[^>]*\bid="trs-tr-', page)[1:]:
        block = block.split('</tr>', 1)[0]  # keep this row only

        # Title: the topic-title link. Prefer the one inside the t-title cell;
        # fall back to any viewtopic.php?t= link carrying the tLink class.
        mt = re.search(r'class="t-title"[^>]*>.*?<a[^>]*href="[^"]*viewtopic\.php\?t=(\d+)[^"]*"[^>]*>(.*?)</a>', block, re.DOTALL)
        if not mt:
            mt = re.search(r'<a[^>]*class="[^"]*tLink[^"]*"[^>]*href="[^"]*viewtopic\.php\?t=(\d+)[^"]*"[^>]*>(.*?)</a>', block, re.DOTALL)
        if not mt:
            mt = re.search(r'<a[^>]*href="[^"]*viewtopic\.php\?t=(\d+)[^"]*"[^>]*>(.*?)</a>', block, re.DOTALL)
        if not mt:
            continue
        topic_id = mt.group(1)
        title = _clean(mt.group(2))
        if not title:
            continue

        # Size in bytes (data-ts_text on the size cell), else humanized text.
        size = 0
        ms = re.search(r'class="[^"]*tor-size[^"]*"[^>]*data-ts_text="(-?\d+)"', block)
        if ms:
            size = max(0, int(ms.group(1)))
        else:
            mh = re.search(r'class="[^"]*tor-size[^"]*"[^>]*>\s*([\d.,]+)\s*([KMGT]?B)', block)
            if mh:
                size = _human_to_bytes(mh.group(1), mh.group(2))
        seeds = _first_int(re.search(r'class="[^"]*seedmed[^"]*"[^>]*>\s*(\d+)', block))
        leech = _first_int(re.search(r'class="[^"]*leechmed[^"]*"[^>]*>\s*(\d+)', block))
        cat = ""
        mc = re.search(r'class="[^"]*f-name[^"]*"[^>]*>\s*<a[^>]*>(.*?)</a>', block, re.DOTALL)
        if mc:
            cat = _clean(mc.group(1))
        rows.append({"id": topic_id, "title": title, "size": size,
                     "seeds": seeds, "leech": leech, "category": cat})
    return rows


def parse_magnet(page):
    m = MAGNET_RE.search(page)
    return html.unescape(m.group(1)) if m else None


def _clean(s):
    """Strip tags and decode HTML entities (handles &amp;, &radic;, &#NNN;, …)."""
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def _first_int(match):
    try:
        return int(match.group(1)) if match else 0
    except (ValueError, TypeError):
        return 0


_UNIT = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}


def _human_to_bytes(num, unit):
    try:
        return int(float(num.replace(",", ".")) * _UNIT.get(unit.upper(), 1))
    except ValueError:
        return 0


# --------------------------------------------------------------------------
# Main search
# --------------------------------------------------------------------------
LAST_WORKING_MIRROR = None


class SourceError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def search(query):
    global LAST_WORKING_MIRROR
    LAST_WORKING_MIRROR = None
    username = os.environ.get("TH_USERNAME", "").strip()
    password = os.environ.get("TH_PASSWORD", "")
    shared_session = bool(os.environ.get("HAVVN_NETWORK_URL"))
    if not shared_session and not username and not password.startswith("cookie:"):
        raise RuntimeError("Set your RuTracker Login and Password in the provider settings.")

    last_err = None
    configured = json.loads(os.environ.get("HAVVN_SOURCE_MIRRORS", "[]"))
    for base in (configured or MIRRORS):
        try:
            opener, jar = _build_opener()
            if shared_session:
                pass  # The user signs in manually in the isolated source window.
            elif password.startswith("cookie:"):
                _set_session_cookie(jar, base, password[len("cookie:"):].strip())
            elif not _login(opener, base, username, password):
                raise RuntimeError("Login failed (wrong username/password?)")

            url = base + "/tracker.php?nm=" + urllib.parse.quote(query, encoding="cp1251")
            html = _request(opener, url)
            if _has_captcha(html):
                raise SourceError('captcha', "Captcha required. Open Sign in in the source connection settings.")
            if _is_login_page(html):
                raise SourceError('auth', "Session expired or missing. Open Sign in in the source connection settings.")
            if shared_session and not re.search(r"(?:tracker\.php\?logout|login\.php\?logout|name=[\"\']logout|id=[\"\']tor-tbl|id=[\"\']search-results)", html, re.I):
                raise SourceError('invalid-response', "Source returned an unrecognized page. Open Sign in and check access.")

            LAST_WORKING_MIRROR = base
            if os.environ.get('HAVVN_CHECK_ONLY') == '1':
                return []  # Validate search access without fetching topic pages.
            rows = parse_search_rows(html)[:MAX_RESULTS]
            if not rows:
                return []  # logged in fine, just no hits

            # Fetch each topic page concurrently to pull its magnet link.
            def fetch_magnet(row):
                try:
                    page = _request(opener, base + "/viewtopic.php?t=" + row["id"])
                    if _has_captcha(page):
                        raise SourceError('captcha', 'Captcha required on the topic page')
                    if _is_login_page(page):
                        raise SourceError('auth', 'Session expired on the topic page')
                    return row, parse_magnet(page)
                except RuntimeError:
                    raise
                except Exception:
                    return row, None

            results = []
            with ThreadPoolExecutor(max_workers=MAGNET_WORKERS) as pool:
                for row, magnet in pool.map(fetch_magnet, rows):
                    if not magnet:
                        continue
                    results.append({
                        "title": row["title"],
                        "magnetUri": magnet,
                        "detailsUrl": base + "/viewtopic.php?t=" + row["id"],
                        "size": row["size"],
                        "seeds": row["seeds"],
                        "leechers": row["leech"],
                        "category": row["category"] or "RuTracker",
                    })
            if not results:
                raise SourceError('invalid-response',
                    "Topic pages returned no magnet links. Check connectivity, "
                    "session cookie and whether RuTracker requires a captcha."
                )
            return results
        except RuntimeError:
            raise  # credential/captcha problems are not mirror-specific
        except Exception as exc:
            last_err = exc
            continue

    if shared_session and last_err is not None:
        raise SourceError(getattr(last_err, 'code', 'network'), 'All configured mirrors failed') from last_err
    raise RuntimeError(
        "All RuTracker mirrors failed. Check system/VPN or HTTPS_PROXY connectivity; "
        "Havvn DNS-over-HTTPS does not apply to Python plugins."
    ) from last_err


def _selftest():
    """Offline parser check — no network, no credentials. Mirrors RuTracker's
    real layout: data-topic_id on the <tr>, a status cell (√), the forum link
    BEFORE the title — so it catches the old bug of grabbing the forum as title."""
    sample_search = '''
      <table id="tor-tbl"><tbody>
      <tr id="trs-tr-6543210" data-topic_id="6543210" class="tCenter hl-tr">
        <td class="row1 t-ico"><span class="tor-icon">&radic;</span></td>
        <td class="row1 f-name-col"><div class="f-name"><a class="gen f" href="tracker.php?f=123">Linux</a></div></td>
        <td class="row4 med tLeft t-title-col tt">
          <div class="t-title"><a data-topic_id="6543210" class="tLink hl-tags bold" href="viewtopic.php?t=6543210">Ubuntu 24.04 LTS amd64 &amp; tools</a></div></td>
        <td class="row4 small nowrap tor-size" data-ts_text="1610612736"><a class="small tr-dl dl-stub">1.5&nbsp;GB&nbsp;↓</a></td>
        <td class="row4 nowrap"><b class="seedmed">42</b></td>
        <td class="row4 leechmed">7</td>
      </tr></tbody></table>'''
    sample_topic = '<a class="magnet-link" href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Ubuntu">M</a>'
    rows = parse_search_rows(sample_search)
    assert len(rows) == 1, rows
    r = rows[0]
    assert r["id"] == "6543210", r
    assert r["title"] == "Ubuntu 24.04 LTS amd64 & tools", r   # the topic title, entities decoded
    assert "√" not in r["title"] and "Linux" not in r["title"], r  # NOT the forum/status
    assert r["size"] == 1610612736, r
    assert r["seeds"] == 42 and r["leech"] == 7, r
    assert r["category"] == "Linux", r                          # the forum is the category
    magnet = parse_magnet(sample_topic)
    assert magnet and magnet.startswith("magnet:?xt=urn:btih:0123456789abcdef"), magnet
    print("selftest OK:", json.dumps(rows, ensure_ascii=False))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        _selftest()
        return
    # A separate process gives the whole search a real deadline, even if DNS,
    # TLS or ThreadPoolExecutor shutdown outlives individual socket timeouts.
    if len(sys.argv) > 1 and sys.argv[1] == "--search-worker":
        try:
            rows = search(sys.argv[2] if len(sys.argv) > 2 else "")
            output = {'results': rows, 'mirror': LAST_WORKING_MIRROR} if os.environ.get('HAVVN_NETWORK_URL') else rows
            json.dump(output, sys.stdout, ensure_ascii=False)
            return 0
        except Exception as exc:
            if getattr(exc, 'code', None):
                print('HAVVN_DIAGNOSTIC ' + json.dumps({'code': exc.code}), file=sys.stderr)
            _err(str(exc))
            return 1
    query = sys.argv[1] if len(sys.argv) > 1 else ""
    # argv[2] is the category (Newznab id) — RuTracker search is global, so unused.
    try:
        result = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "--search-worker", query],
            capture_output=True, encoding="utf-8", timeout=SEARCH_TIMEOUT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        print('HAVVN_DIAGNOSTIC ' + json.dumps({'code': 'timeout'}), file=sys.stderr)
        _err("Search exceeded 21 seconds. Check system/VPN or HTTPS_PROXY connectivity; "
             "Havvn DNS-over-HTTPS does not apply to Python plugins.")
        return 1
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
