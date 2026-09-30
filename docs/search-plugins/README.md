# Havvn search plugins

A **script provider** lets Havvn search any source by running a small local
program you point it at. No script provider is enabled by default — you choose
and add a script, including the examples in this directory. This lets you add indexers
without hosting a Jackett/Prowlarr server.

## How it works

When you run a search, Havvn invokes your script like this:

```
<python> <your_script.py> "<query>" "<category>"
```

- `<python>` is the Python 3 interpreter Havvn auto-detects on your system.
- `"<query>"` is what you typed in the search box.
- `"<category>"` is a [Newznab category id](https://newznab.readthedocs.io/en/latest/misc/api/#predefined-categories)
  (`2000` movies, `5000` TV, `3000` music, `4000` software, `6000` XXX) or an
  **empty string** for searches from the current UI. The argument is retained for
  plugin compatibility; the old source-category selector was removed. The
  **Add to category** control assigns downloads to your own groups instead.

Your script must **print a JSON array of results to stdout** and exit. Anything on
stderr is reserved for diagnostics, not search results.

On failure, exit with a non-zero status and write a short diagnostic to stderr;
Havvn displays that diagnostic. Do not include passwords or session cookies.

### Output format

```json
[
  {
    "title": "Some Release Name 1080p",
    "magnetUri": "magnet:?xt=urn:btih:...",
    "torrentUrl": "https://example.org/download/123.torrent",
    "infoHash": "0123456789abcdef0123456789abcdef01234567",
    "size": 1610612736,
    "seeds": 42,
    "leechers": 3,
    "publishDate": "2026-06-17",
    "category": "Movies/HD"
  }
]
```

Field rules:

| Field         | Required | Notes                                                        |
|---------------|----------|-------------------------------------------------------------|
| `title`       | **yes**  | Display name.                                                |
| `magnetUri`   | one of these three | Magnet link.                                      |
| `torrentUrl`  | one of these three | Direct `.torrent` URL.                            |
| `infoHash`    | one of these three | 40-char hex (Havvn rebuilds the magnet).          |
| `size`        | no       | Bytes (integer). Defaults to 0.                             |
| `seeds`       | no       | Integer. Defaults to 0; used in sorting and preferences.     |
| `leechers`    | no       | Integer. Defaults to 0.                                      |
| `publishDate` | no       | Any string.                                                 |
| `category`    | no       | Free-text label shown in the results table.                 |

A row with no `title`, or with none of `magnetUri` / `torrentUrl` / `infoHash`,
is dropped.

A `{ "results": [ ... ] }` wrapper object is also accepted, so the same script can
serve both this provider and the "Custom JSON" HTTP provider.

## Credentials (for indexers that need a login)

Some scripts require an account. Put the login in the provider's
**Login** / **Password** fields in Havvn instead of hard-coding it in the
script — the password is stored **encrypted** by the OS keychain (DPAPI / Keychain
/ libsecret), never in plaintext. Havvn passes them to the script as
environment variables:

| Env var           | From the provider field |
|-------------------|-------------------------|
| `TH_USERNAME`     | Login                   |
| `TH_PASSWORD`     | Password                |
| `TH_APIKEY`       | API Key                 |
| `TH_PROVIDER_URL` | Provider URL/path (the `.py` path for script providers) |

Read them with `os.environ.get("TH_USERNAME")` etc.

For the current RuTracker example with a saved shared connection, use **Sign in**
in the source card instead. Login/password fields and `cookie:` are used only in
Legacy/standalone mode; they are not filled into the source browser automatically.

## Limits & safety

- The script runs **on your machine with your permissions** — only add scripts you
  trust and have read.
- It must finish within **25 seconds** and print at most **8 MB** / **500 results**.
- It is launched with `execFile` (no shell), so the query is never interpreted by a
  shell — no injection risk from what you type.
- Only `.py` files are accepted.

## Files here

- [`example_indexer.py`](example_indexer.py) — a minimal, runnable template.
- [`qbittorrent_adapter.py`](qbittorrent_adapter.py) — run your existing
  **qBittorrent search plugins** through this provider (see its header).
- [`rutracker.py`](rutracker.py) — **RuTracker** search. Add a Python Script
  provider pointing at it, save a shared connection and mirror, then sign in through
  Havvn's source browser. Stdlib-only, with the bundled Havvn Network SDK for shared
  connections; Legacy/standalone mode supports Login/Password and `cookie:<bb_session>`.
  Verify the parser offline with `python rutracker.py --selftest`.

### RuTracker connection troubleshooting

With a saved shared connection, check the source card's System/Direct/proxy route,
configured mirrors and **Sign in** session. For RuTracker, the mirror must include
`/forum`. Havvn does not import your everyday browser's login or extension settings.
Do not disable TLS certificate verification.

In Legacy/standalone mode, RuTracker uses Python's network stack: Havvn's
DNS-over-HTTPS setting does not change it. Check the system network/VPN or configure
Python's `HTTPS_PROXY` environment before launching Havvn. A valid
`cookie:<bb_session>` can avoid the login captcha, but cannot fix connectivity.

The complete plugin worker has a 21-second deadline, below Havvn's 25-second limit.
Ordinary HTTP requests have a 4-second deadline; shared browser HTML navigation has
a 12-second deadline per page. Network and authentication errors produce a non-zero
exit status instead of a successful empty result. If a browser check appears, solve
it manually in **Sign in**. The plugin does not automatically solve challenges.

Offline regression checks: `python -m unittest discover -s docs/search-plugins -p test_rutracker.py`.


### Per-source connections (Havvn Network SDK v1)

Open the source card → Connection. Select System, Direct, or create/reuse an HTTP or SOCKS5 proxy profile. Proxies requiring credentials are currently rejected. This controls search and .torrent retrieval, independently of peer traffic. Existing providers keep Legacy connection until changed.

For the updated RuTracker plugin, set the mirror base URL including /forum, for example https://rutracker.net/forum. Add only mirrors you trust and can access; availability is not guaranteed. Mirror origins are allowed automatically. Other required origins can be entered separately. The last successful configured mirror is preferred. This does not import the official browser extension's proxy configuration.

A compatible Python plugin declares the comment # havvn-network: 1 within its first 4096 characters. When a source connection is configured, Havvn supplies HAVVN_NETWORK_URL, HAVVN_NETWORK_TOKEN and the SDK import path. Use from havvn_network import request; request(url, data=optional_bytes, headers=optional_dict) returns response bytes. Do not gzip-decompress this result: Chromium already decoded the HTTP content encoding. Decode the source charset as appropriate.

The bridge supports GET and POST, only configured origins, 4-second request deadlines and 4 MiB responses. The token expires when the script run finishes; stdout remains the JSON search-result array. Never print the bridge token, cookies or passwords. A plugin is trusted executable code, not a sandbox; compatibility requires routing all its requests through the SDK. Never retry directly when the SDK fails.

Legacy mode retains the existing Python/HTTPS_PROXY behavior. A script without the SDK marker cannot use the new connection settings and receives an explicit error. Havvn ships the SDK with the packaged app; standalone use of this plugin without HAVVN_NETWORK_URL needs no SDK and retains its previous network path.


### Sign in through Havvn

The current RuTracker example reports structured errors and its working mirror,
including when a search has no results. If you imported an older copy, replace it
with the current script from this directory.

1. Select and save the source connection and a mirror such as
   `https://rutracker.org/forum`.
2. Click **Sign in**, log in on the site and complete any browser check manually.
   Then close the window. Search and `.torrent` retrieval reuse that source session.
3. Click **Check access** or run a search in Havvn. If necessary, test the site's
   search inside the sign-in window too; a working homepage alone does not prove
   that the search endpoint is accessible.

If login navigates to another trusted domain, add its origin to the allowed
addresses. The sign-in window permits HTTPS page resources and Cloudflare's
challenge resources without granting the Python SDK access to those origins.

This mode does not use the saved password or `cookie:` field to log in again.
**Sign out** clears the source session; the next authenticated search needs manual
sign-in. Legacy mode keeps its previous Python-based authentication.

### Browser HTML transport

The bundled RuTracker plugin uses `havvn_network.browser_html(url)` for GET pages when a shared connection is configured. Havvn navigates a sandboxed, hidden browser window using the same source session and proxy as Sign in, then returns the HTML as Unicode. At most four browser pages run concurrently per plugin invocation; windows close on completion, cancellation, logout or connection reset. Allowed origins, redirect limits, a 12-second page deadline and a 4 MiB HTML limit still apply. This API accepts no JavaScript, cookies or POST data and does not solve challenges. If the site requests another challenge, use Sign in. Other SDK HTTP requests and standalone Python mode keep their existing transport.
