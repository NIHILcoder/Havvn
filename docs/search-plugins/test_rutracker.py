import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
import tempfile
import time
from unittest.mock import patch

import rutracker


class RuTrackerTests(unittest.TestCase):
    def test_shared_empty_search_reports_working_mirror(self):
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request", "HAVVN_SOURCE_MIRRORS": '["https://one.test/forum"]'}, clear=True), \
                patch.object(rutracker, "_request", return_value='<a href="login.php?logout=1">Logout</a>'):
            code, out, err = self.run_main(["--search-worker", "Linux"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"results": [], "mirror": "https://one.test/forum"})

    def test_check_only_validates_search_without_fetching_topics(self):
        page = '<a href="login.php?logout=1">Logout</a>'
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request", "HAVVN_CHECK_ONLY": "1"}, clear=True), \
                patch.object(rutracker, "_request", return_value=page) as request, \
                patch.object(rutracker, "parse_search_rows") as parse:
            self.assertEqual(rutracker.search("test"), [])
        self.assertEqual(request.call_count, 1)
        self.assertIn("/tracker.php?nm=test", request.call_args.args[1])
        parse.assert_not_called()

    def test_check_only_still_rejects_expired_login_and_challenges(self):
        for page in ['<input name="login_username"><input name="login_password">', '<input name="cap_sid">', '<html>Access denied</html>']:
            with self.subTest(page=page), \
                    patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request", "HAVVN_CHECK_ONLY": "1"}, clear=True), \
                    patch.object(rutracker, "_request", return_value=page):
                with self.assertRaises(RuntimeError):
                    rutracker.search("test")

    def test_shared_html_uses_browser_navigation(self):
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request"}, clear=True), \
                patch("havvn_network.browser_html", return_value="<html>title</html>") as browser, \
                patch("havvn_network.request") as background:
            opener, _ = rutracker._build_opener()
            self.assertEqual(rutracker._request(opener, "https://one.test/forum/tracker.php?nm=test"), "<html>title</html>")
            browser.assert_called_once_with("https://one.test/forum/tracker.php?nm=test")
            background.assert_not_called()

    def test_shared_mirror_failure_keeps_dns_diagnostic(self):
        from havvn_network import NetworkError
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request"}, clear=True), \
                patch.object(rutracker, "_request", side_effect=NetworkError('dns')):
            code, out, err = self.run_main(["--search-worker", "Linux"])
        self.assertEqual(code, 1)
        self.assertIn('HAVVN_DIAGNOSTIC {"code": "dns"}', err)

    def test_shared_captcha_does_not_try_other_mirrors(self):
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request", "HAVVN_SOURCE_MIRRORS": '["https://one.test/forum", "https://two.test/forum"]'}, clear=True), \
                patch.object(rutracker, "_request", return_value='<input name="cap_sid">') as request:
            code, out, err = self.run_main(["--search-worker", "Linux"])
        self.assertEqual(code, 1)
        self.assertIn('HAVVN_DIAGNOSTIC {"code": "captcha"}', err)
        self.assertEqual(request.call_count, 1)

    def test_shared_network_failure_tries_next_mirror(self):
        from havvn_network import NetworkError
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request", "HAVVN_SOURCE_MIRRORS": '["https://one.test/forum", "https://two.test/forum"]'}, clear=True), \
                patch.object(rutracker, "_request", side_effect=[NetworkError('dns'), '<a href="login.php?logout=1">Logout</a>']):
            self.assertEqual(rutracker.search('Linux'), [])
            self.assertEqual(rutracker.LAST_WORKING_MIRROR, 'https://two.test/forum')

    def run_main(self, args):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", [rutracker.__file__, *args]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rutracker.main()
        return code, out.getvalue(), err.getvalue()

    def test_shared_session_needs_no_password(self):
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request"}, clear=True), \
                patch.object(rutracker, "_request", return_value='<a href="login.php?logout=1">Logout</a>'), \
                patch.object(rutracker, "_login") as login:
            self.assertEqual(rutracker.search("Linux"), [])
            login.assert_not_called()

    def test_expired_shared_session_does_not_relogin_with_saved_password(self):
        with patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request", "TH_USERNAME": "old", "TH_PASSWORD": "old"}, clear=True), \
                patch.object(rutracker, "_request", return_value='<input name="login_username"><input name="login_password">'), \
                patch.object(rutracker, "_login") as login:
            with self.assertRaisesRegex(RuntimeError, "Session expired"):
                rutracker.search("Linux")
            login.assert_not_called()

    def test_shared_session_challenge_is_not_empty_success(self):
        for page in ['<input name="cap_sid">', '<html>Access denied</html>']:
            with self.subTest(page=page), \
                    patch.dict(os.environ, {"HAVVN_NETWORK_URL": "http://127.0.0.1/request"}, clear=True), \
                    patch.object(rutracker, "_request", return_value=page):
                with self.assertRaises(RuntimeError):
                    rutracker.search("Linux")

    def test_existing_parser(self):
        with contextlib.redirect_stdout(io.StringIO()):
            rutracker._selftest()

    def test_magnet_entities(self):
        self.assertEqual(rutracker.parse_magnet(
            '<a href="magnet:?xt=urn:btih:abc&amp;dn=Linux">M</a>'),
            'magnet:?xt=urn:btih:abc&dn=Linux')

    def test_deadline_is_shorter_than_host_timeout(self):
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 21)) as run:
            code, out, err = self.run_main(["Linux", ""])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("21 seconds", err)
        self.assertLess(run.call_args.kwargs["timeout"], 25)
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_worker_preserves_json_and_exit_status(self):
        result = subprocess.CompletedProcess([], 0, '[{"title":"Linux"}]', '')
        with patch.object(subprocess, "run", return_value=result):
            code, out, err = self.run_main(["Linux", ""])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), [{"title": "Linux"}])
        self.assertEqual(err, "")

    def test_credentials_error_is_not_successful_empty_search(self):
        with patch.dict(os.environ, {}, clear=True):
            code, out, err = self.run_main(["--search-worker", "Linux"])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("Login and Password", err)

    def test_failed_mirrors_report_network_error(self):
        with patch.dict(os.environ, {"TH_USERNAME": "test", "TH_PASSWORD": "test"}), \
                patch.object(rutracker, "_login", side_effect=TimeoutError) as login:
            with self.assertRaisesRegex(RuntimeError, "All RuTracker mirrors failed"):
                rutracker.search("Linux")
        self.assertEqual(login.call_count, len(rutracker.MIRRORS))

    def test_failed_worker_diagnostic_reaches_host(self):
        result = subprocess.CompletedProcess([], 1, '', 'rutracker: Login failed\n')
        with patch.object(subprocess, "run", return_value=result):
            code, out, err = self.run_main(["Linux", ""])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("Login failed", err)

    def test_real_stalled_worker_is_terminated(self):
        with tempfile.TemporaryDirectory() as directory:
            script = os.path.join(directory, "stalled.py")
            with open(script, "w", encoding="utf-8") as stream:
                stream.write("import time; time.sleep(60)")
            started = time.monotonic()
            with patch.object(rutracker, "__file__", script), \
                    patch.object(rutracker, "SEARCH_TIMEOUT", 0.2):
                code, out, err = self.run_main(["Linux", ""])
            self.assertEqual(code, 1)
            self.assertEqual(out, "")
            self.assertIn("exceeded", err)
            self.assertLess(time.monotonic() - started, 5)

    def test_wrong_password_is_not_retried_on_every_mirror(self):
        with patch.dict(os.environ, {"TH_USERNAME": "test", "TH_PASSWORD": "test"}), \
                patch.object(rutracker, "_login", return_value=False) as login:
            with self.assertRaisesRegex(RuntimeError, "Login failed"):
                rutracker.search("Linux")
        self.assertEqual(login.call_count, 1)


if __name__ == "__main__":
    unittest.main()
