/**
 * LanDiagnosticsModal — the "why isn't my LAN working?" report (Phase 2A).
 *
 * Built on the LanPeerPicker skeleton: a Modal (size lg) portaled to the OWNING
 * document's <body> so the room rail's container-query subtree containment can't
 * trap the fixed backdrop. The body is a dumb renderer over an already-EVALUATED
 * report — every verdict, ordering and threshold lives in the pure shared
 * evaluator (shared/lan-quality + shared/lan-diagnostics); this file only picks an
 * icon and translates a key.
 *
 * HOST WINDOW: both the portal target and the clipboard come from useHostWindow()
 * rather than
 * the module-scope globals, because the LAN panel that opens this modal can be torn
 * off into a child window. `document.body` would then put the report in the MAIN
 * window, and `navigator.clipboard` belongs to a document that is UNFOCUSED while
 * the child window has focus — Chromium rejects that write with "Document is not
 * focused" and the success toast never fires. With no provider (the docked case)
 * the context IS the real globals, so nothing about the docked panel changes.
 *
 * The report is copy-paste-able on purpose: a user pastes it into a bug report.
 * The Copy button prefers the pre-formatted block the pure formatter produced
 * (formatLanDiagnostics) and falls back to composing one from the checks, so Copy
 * works even before that formatter exists. The same text is rendered in a
 * selectable <pre> for users whose clipboard is blocked.
 *
 * Theme tokens only; --radius-full is reserved for round dots.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { Modal, Button, Icon } from '../../components';
import type { IconName } from '../../components/Icon';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import './RoomLanPanel.css';

/** Verdict of one check. `unknown` = we could not measure it (not a failure). */
export type LanCheckLevel = 'ok' | 'warn' | 'fail' | 'unknown';

/**
 * One evaluated check as the UI consumes it.
 *
 * The pure layer never formats prose — it emits an i18n KEY (under
 * `rooms.lan.diag.*`) plus an already-stringified `detail` (an adapter name, a
 * dotted-quad, an RTT). Integration maps the shared evaluator's report onto this
 * view type; keeping the view shape here means the panel type-checks without
 * depending on the exact field names the transport phase settles on.
 */
export interface LanDiagCheckView {
  /** Stable id (`adapter`, `vip`, `firewall`, `helper`, `peer:<memberId>`, …). */
  id: string;
  level: LanCheckLevel;
  /** i18n key under `rooms.lan.diag.*` — translated here, never in the evaluator. */
  key: string;
  /** Already-stringified specifics (adapter name, vIP, "42 ms · srflx/relay"). */
  detail?: string;
  /** Optional i18n key for the "how to fix it" line under a warn/fail row. */
  hintKey?: string;
}

/** The evaluated report the modal renders. */
export interface LanDiagReportView {
  /** Worst level across the checks (drives the summary banner). */
  verdict?: LanCheckLevel;
  checks: LanDiagCheckView[];
  /** Pre-formatted copy-paste block from the pure formatter; composed locally when absent. */
  report?: string;
  /** epoch ms the snapshot was taken. */
  generatedAt?: number;
}

export interface LanDiagnosticsModalProps {
  /** Runs the check pass. Called once on mount and again on "Re-run". */
  run: () => Promise<LanDiagReportView>;
  onClose: () => void;
}

const LEVEL_ICON: Record<LanCheckLevel, IconName> = {
  ok: 'check-circle',
  warn: 'alert-triangle',
  fail: 'x-circle',
  unknown: 'help-circle',
};

/** Plain-text mark used in the copy-paste fallback (ASCII so it survives any paste). */
const LEVEL_MARK: Record<LanCheckLevel, string> = {
  ok: '[ OK ]',
  warn: '[WARN]',
  fail: '[FAIL]',
  unknown: '[ ?? ]',
};

export const LanDiagnosticsModal: React.FC<LanDiagnosticsModalProps> = ({ run, onClose }) => {
  const { t } = useTranslation();
  const host = useHostWindow();
  // Evaluator-supplied keys are dynamic strings; t() is typed against en.json, so
  // the dynamic path casts once here instead of at every call site.
  const tk = (key: string) => t(key as Parameters<typeof t>[0]);

  const [report, setReport] = useState<LanDiagReportView | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A pass started before Close must not setState on an unmounted modal.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Held in a ref so an inline arrow from the parent can't re-fire the mount pass
  // on every render (the effect below depends on a stable callback).
  const runRef = useRef(run);
  runRef.current = run;

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await runRef.current();
      if (alive.current) setReport(r);
    } catch (e) {
      if (alive.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** The copy-paste block: the pure formatter's text, or a local reconstruction. */
  const asText = (r: LanDiagReportView): string => {
    if (r.report && r.report.trim()) return r.report;
    const when = new Date(r.generatedAt || Date.now()).toISOString();
    const lines = [`${t('rooms.lan.diagTitle')} — ${when}`, ''];
    for (const c of r.checks) {
      lines.push(`${LEVEL_MARK[c.level] || LEVEL_MARK.unknown} ${tk(c.key)}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    return lines.join('\n');
  };

  const copy = () => {
    if (!report) return;
    const text = asText(report);
    // The clipboard of the window this modal is actually displayed in — writing
    // through an unfocused document rejects (see the REALM note in the header).
    host.window.navigator.clipboard?.writeText(text)
      .then(() => { setCopied(true); toast.success(t('rooms.lan.copied')); })
      .catch(() => { /* clipboard blocked — the <pre> below is selectable */ });
  };

  const verdict: LanCheckLevel = report?.verdict
    || (report?.checks.some((c) => c.level === 'fail') ? 'fail'
      : report?.checks.some((c) => c.level === 'warn') ? 'warn'
        : 'ok');

  return createPortal(
    <Modal
      onClose={onClose}
      title={t('rooms.lan.diagTitle')}
      icon="activity"
      size="lg"
      bodyClassName="lan-diag-body"
      footer={
        <div className="lan-diag-footer">
          <Button
            variant="ghost"
            onClick={() => { void refresh(); }}
            disabled={busy}
            icon={<Icon name="refresh" size={14} />}
          >
            {t('rooms.lan.diagRerun')}
          </Button>
          <Button
            variant="primary"
            onClick={copy}
            disabled={busy || !report}
            icon={<Icon name={copied ? 'check' : 'copy'} size={14} />}
          >
            {t('rooms.lan.diagCopy')}
          </Button>
        </div>
      }
    >
      <p className="lan-diag-desc">{t('rooms.lan.diagDesc')}</p>

      {busy && !report && <div className="lan-diag-empty">{t('rooms.lan.diagRunning')}</div>}
      {error && (
        <div className="lan-diag-row fail">
          <Icon name="x-circle" size={15} />
          <span className="lan-diag-text">
            <span className="lan-diag-label">{t('rooms.lan.diagFailed')}</span>
            <span className="lan-diag-detail">{error}</span>
          </span>
        </div>
      )}

      {report && (
        <>
          <div className={`lan-diag-verdict ${verdict}`}>
            <Icon name={LEVEL_ICON[verdict]} size={15} />
            <span>
              {verdict === 'ok' ? t('rooms.lan.diagVerdictOk')
                : verdict === 'warn' ? t('rooms.lan.diagVerdictWarn')
                  : verdict === 'fail' ? t('rooms.lan.diagVerdictFail')
                    : t('rooms.lan.diagVerdictUnknown')}
            </span>
          </div>

          <div className="lan-diag-list">
            {report.checks.map((c) => (
              <div key={c.id} className={`lan-diag-row ${c.level}`}>
                <Icon name={LEVEL_ICON[c.level] || 'help-circle'} size={15} />
                <span className="lan-diag-text">
                  <span className="lan-diag-label">{tk(c.key)}</span>
                  {c.detail && <span className="lan-diag-detail">{c.detail}</span>}
                  {c.hintKey && (c.level === 'warn' || c.level === 'fail') && (
                    <span className="lan-diag-hint">{tk(c.hintKey)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* Selectable fallback: the exact text the Copy button writes, so a user
              whose clipboard is blocked can still select it by hand. */}
          <details className="lan-diag-raw">
            <summary>{t('rooms.lan.diagRaw')}</summary>
            <pre className="lan-diag-pre">{asText(report)}</pre>
          </details>
        </>
      )}
    </Modal>,
    host.document.body,
  );
};

export default LanDiagnosticsModal;
