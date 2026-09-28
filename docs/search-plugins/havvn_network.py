"""Havvn Network SDK v1: scoped HTTP through the source's configured session."""
import base64
import json
import os
import urllib.request
import urllib.parse


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class NetworkError(OSError):
    def __init__(self, code):
        self.code = code
        super().__init__('Havvn network: ' + code)


class AccessError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__('Havvn network: ' + code)


def _request(url, data=None, headers=None, browser_html=False):
    endpoint = os.environ.get('HAVVN_NETWORK_URL', '')
    token = os.environ.get('HAVVN_NETWORK_TOKEN', '')
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path != '/request' or not token:
        raise RuntimeError('Havvn network bridge is unavailable')
    payload = {'url': url, 'method': 'POST' if data is not None else 'GET', 'headers': headers or {}, 'browserHtml': browser_html}
    if data is not None:
        payload['body'] = base64.b64encode(data).decode('ascii')
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode('utf-8'), headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    # Never send the capability through system/HTTPS_PROXY settings or redirects.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(req, timeout=20 if browser_html else 6) as response:
            result = json.loads(response.read(6 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        try:
            reason = json.loads(error.read(1024)).get('error', 'network')
        except Exception:
            reason = 'network'
        error_type = AccessError if reason in ('auth', 'captcha', 'forbidden', 'rate-limit', 'redirect', 'invalid-url', 'tls', 'proxy', 'too-large', 'cancelled') else NetworkError
        raise error_type(str(reason)) from None
    return result


def request(url, data=None, headers=None):
    return base64.b64decode(_request(url, data, headers)['body'], validate=True)


def browser_html(url):
    """Navigate an HTML page in the isolated source browser; no JS/cookie API."""
    result = _request(url, browser_html=True)
    return base64.b64decode(result['body'], validate=True).decode('utf-8')
