/**
 * Onboarding — the 3-step first-run dialog.
 *
 * Shown once, on a fresh install only (App checks localStorage 'onboarded' AND
 * an empty downloads list before mounting this). Walks through the three things
 * a new user actually needs: where files land, whether their connection is
 * behind a VPN, and that rooms exist. Finishing OR skipping stamps
 * localStorage.onboarded = '1' so it never reappears.
 *
 * Built on the shared Modal shell (Ember card, focus trap, stacked-Escape),
 * with Escape mapped to skip and Enter advancing to the next step.
 */

import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import Icon, { IconName } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { IpInfo } from '../../shared/types';
import './Onboarding.css';

interface OnboardingProps {
  /** Unmount the dialog (the flag is already persisted by then). */
  onClose: () => void;
  /** Step 3's «Создать комнату» — App closes us and navigates to rooms. */
  onCreateRoom: () => void;
}

type IpCheck =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'done'; info: IpInfo }
  | { status: 'error' };

const STEP_ICONS: IconName[] = ['folder', 'shield', 'users'];
const LAST_STEP = 2;

/** Persist the "seen it" flag — must never throw even with storage disabled. */
function markOnboarded(): void {
  try { localStorage.setItem('onboarded', '1'); } catch { /* storage unavailable */ }
}

export const Onboarding: React.FC<OnboardingProps> = ({ onClose, onCreateRoom }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [downloadDir, setDownloadDir] = useState<string>('');
  const [ipCheck, setIpCheck] = useState<IpCheck>({ status: 'idle' });

  // Current download dir for step 1. The bridge may be stubbed/unavailable in
  // tests — every call is guarded and a miss just leaves the path blank.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const settings = await window.api.getSettings();
        if (alive && settings?.defaultDownloadDir) setDownloadDir(settings.defaultDownloadDir);
      } catch { /* settings unavailable — show placeholder */ }
    })();
    return () => { alive = false; };
  }, []);

  const skip = () => { markOnboarded(); onClose(); };
  const finish = () => { markOnboarded(); onClose(); };
  const createRoom = () => { markOnboarded(); onCreateRoom(); };
  const next = () => setStep((s) => Math.min(s + 1, LAST_STEP));

  // Enter advances (finishes on the last step). Buttons handle their own Enter
  // via click, so skip the shortcut when a control is focused to avoid firing
  // twice. Escape-to-skip comes from the Modal shell (onClose).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'A') return;
      e.preventDefault();
      if (step === LAST_STEP) finish();
      else next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const changeDir = async () => {
    try {
      const dir = await window.api.selectDirectory();
      if (!dir) return; // dialog cancelled
      await window.api.updateSettings({ defaultDownloadDir: dir });
      setDownloadDir(dir);
    } catch { /* dialog/settings unavailable — keep the old path */ }
  };

  const runIpCheck = async () => {
    setIpCheck({ status: 'checking' });
    try {
      const info = await window.api.getIpInfo();
      if (info && typeof info.vpnActive === 'boolean') setIpCheck({ status: 'done', info });
      else setIpCheck({ status: 'error' });
    } catch {
      setIpCheck({ status: 'error' });
    }
  };

  const titles = [t('onboarding.step1.title'), t('onboarding.step2.title'), t('onboarding.step3.title')];

  const renderVerdict = () => {
    if (ipCheck.status === 'idle' || ipCheck.status === 'checking') return null;
    if (ipCheck.status === 'error') {
      return (
        <div className="ob-verdict ob-verdict-unknown">
          <Icon name="help-circle" size={14} />
          <span>{t('onboarding.step2.unknown')}</span>
        </div>
      );
    }
    const { info } = ipCheck;
    return (
      <div className={`ob-verdict ${info.vpnActive ? 'ob-verdict-ok' : 'ob-verdict-warn'}`}>
        <Icon name={info.vpnActive ? 'check-circle' : 'alert-triangle'} size={14} />
        <span>
          {info.vpnActive ? t('onboarding.step2.vpnFound') : t('onboarding.step2.vpnNotFound')}
          {info.ip ? ` · ${t('onboarding.step2.publicIp')} ${info.ip}` : ''}
        </span>
      </div>
    );
  };

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div className="ob-step" key="s0">
            <p className="ob-desc">{t('onboarding.step1.desc')}</p>
            <div className="ob-path-row">
              <code className="ob-path" title={downloadDir}>{downloadDir || '—'}</code>
              <Button size="sm" variant="secondary" onClick={changeDir}>
                {t('onboarding.step1.change')}
              </Button>
            </div>
          </div>
        );
      case 1:
        return (
          <div className="ob-step" key="s1">
            <p className="ob-desc">{t('onboarding.step2.desc')}</p>
            <div className="ob-check-row">
              <Button
                size="sm"
                variant="secondary"
                loading={ipCheck.status === 'checking'}
                onClick={runIpCheck}
              >
                {t('onboarding.step2.check')}
              </Button>
              {renderVerdict()}
            </div>
            <p className="ob-hint">{t('onboarding.step2.hint')}</p>
          </div>
        );
      default:
        return (
          <div className="ob-step" key="s2">
            <p className="ob-desc">{t('onboarding.step3.desc')}</p>
          </div>
        );
    }
  };

  return (
    <Modal
      title={titles[step]}
      icon={STEP_ICONS[step]}
      size="md"
      onClose={skip}
      closeOnBackdrop={false}
      className="ob-card"
      footer={
        <>
          <div className="ob-dots" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`ob-dot ${i === step ? 'ob-dot-active' : ''}`} />
            ))}
          </div>
          <Button variant="ghost" onClick={skip}>
            {t('onboarding.skip')}
          </Button>
          {step < LAST_STEP ? (
            <Button variant="primary" onClick={next} data-autofocus>
              {t('onboarding.next')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={finish}>
                {t('onboarding.done')}
              </Button>
              <Button variant="primary" onClick={createRoom} data-autofocus>
                {t('onboarding.step3.createRoom')}
              </Button>
            </>
          )}
        </>
      }
    >
      {renderStep()}
    </Modal>
  );
};

export default Onboarding;
