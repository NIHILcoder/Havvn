import { ErrorMessage } from '../../../components/ErrorMessage';
import React, { useEffect, useRef, useState } from 'react';
import { SettingsCard, SettingRow, TextField } from '../controls';
import { Button, Icon, Select, Toggle } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import { DEFAULT_APPEARANCE, MAX_WALLPAPER_LENGTH, SCENIC_BACKGROUNDS, validWallpaper, type Appearance } from '../../../../shared/appearance';
import { AppearanceCollection } from '../../../components/AppearanceCollection';
import { validateAppearanceProfile, type AppearanceProfile } from '../../../../shared/appearance-profile';
import { acrylicStatus, APPEARANCE_EVENT, readAppearance, saveAppearance } from '../../../utils/appearance';
import { applyAppearanceProfile, captureAppearanceProfile, loadAppearanceProfiles,
  removeAppearanceProfile, saveAppearanceProfile, APPEARANCE_PROFILES_EVENT,
  loadPreviousAppearanceProfile, restorePreviousAppearanceProfile, standardAppearanceProfile } from '../../../utils/appearance-profiles';
import { useThemeEditor } from '../../../components/ThemeEditorContext';
import '../../../components/GlassControls.css';

export function AppearancePanel({ onProfileApplied, profilesLocked = false }: {
  onProfileApplied: (mode: 'dark' | 'light' | 'system') => void;
  profilesLocked?: boolean;
}) {
  const { t } = useTranslation();
  const { openEditor } = useThemeEditor();
  const [prefs, setPrefs] = useState(readAppearance);
  const [native, setNative] = useState(acrylicStatus);
  const [profiles, setProfiles] = useState(loadAppearanceProfiles);
  const [profileName, setProfileName] = useState('');
  const [profileIndex, setProfileIndex] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [previous, setPrevious] = useState(loadPreviousAppearanceProfile);
  const wallpaperInput = useRef<HTMLInputElement>(null);
  const profileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const sync = () => { setPrefs(readAppearance()); setNative(acrylicStatus()); };
    window.addEventListener(APPEARANCE_EVENT, sync);
    const syncProfiles = () => { setProfiles(loadAppearanceProfiles()); setPrevious(loadPreviousAppearanceProfile()); };
    window.addEventListener(APPEARANCE_PROFILES_EVENT, syncProfiles);
    return () => {
      alive.current = false; window.removeEventListener(APPEARANCE_EVENT, sync);
      window.removeEventListener(APPEARANCE_PROFILES_EVENT, syncProfiles);
    };
  }, []);
  const run = async (action: () => void | Promise<void>) => {
    setError(''); setFeedback(''); setBusy(true);
    try { await action(); } catch { if (alive.current) setError(t('appearance.saveError')); }
    finally { if (alive.current) setBusy(false); }
  };
  const update = (patch: Partial<Appearance>) => { void run(() => saveAppearance({ ...readAppearance(), ...patch })); };
  const slider = (key: 'backgroundDim', min: number, max: number) => (
    <label className="ap-slider">
      <input type="range" min={min} max={max} value={prefs[key]} aria-label={t(`appearance.${key}`)}
        onChange={event => update({ [key]: Number(event.target.value) })} />
      <output>{Math.round(prefs[key])}%</output>
    </label>
  );
  const selectedProfile = profileIndex === '' ? undefined : profiles[Number(profileIndex)];
  const replacingProfile = profiles.some(p => p.name === profileName.trim());
  const profileLimitReached = profiles.length >= 8 && !profiles.some(p => p.name === profileName.trim());
  const applyProfile = (profile: AppearanceProfile) => { void run(async () => {
    await applyAppearanceProfile(profile); onProfileApplied(profile.mode);
    setPrefs(readAppearance()); setNative(acrylicStatus());
    setFeedback(`${t('appearance.profileApplied')}: ${profile.name}`);
  }); };
  const loadWallpaper = (file?: File) => { if (file) void run(async () => {
    if (file.size > 2_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError(t('appearance.imageError')); return;
    }
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file);
    });
    if (!validWallpaper(image)) throw new Error('Invalid image');
    // Decode before persisting: a fake raster MIME or corrupt file is rejected.
    let decoded: ImageBitmap;
    try { decoded = await createImageBitmap(file); }
    catch { setError(t('appearance.imageError')); return; }
    const acceptable = decoded.width <= 8192 && decoded.height <= 8192;
    decoded.close();
    if (!acceptable) { setError(t('appearance.imageError')); return; }
    await saveAppearance({ ...readAppearance(), background: 'image', wallpaper: image });
  }); };
  const importProfile = (file?: File) => { if (file) void run(async () => {
    if (file.size > MAX_WALLPAPER_LENGTH + 2_200_000) throw new Error('Large profile');
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); }
    catch { setError(t('appearance.profileError')); return; }
    const profile = validateAppearanceProfile(parsed);
    if (!profile) { setError(t('appearance.profileError')); return; }
    saveAppearanceProfile(profile);
    const updated = loadAppearanceProfiles(); setProfiles(updated);
    setProfileIndex(String(updated.findIndex(p => p.name === profile.name))); setProfileName('');
    setFeedback(t('appearance.profileImported'));
  }); };
  const exportProfile = () => { void run(() => {
    const profile = captureAppearanceProfile(profileName.trim() || 'Havvn');
    const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'havvn.appearance.json';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }); };
  return <SettingsCard title={t('appearance.title')} icon="sun" description={t('appearance.description')}>
    <details className="ap-disclosure ap-collection-disclosure" data-setting-label={t('appearance.collection.title')}>
      <summary><Icon name="chevron-right" size={16} /><span>{t('appearance.collection.title')}</span>
        <span className="ap-disclosure-meta">{t('appearance.collection.count')}</span></summary>
      <div className="ap-disclosure-body">
        <p className="ap-hint">{t('appearance.collection.hint')}</p>
        {profilesLocked && <p className="ap-hint">{t('appearance.editorHint')}</p>}
        <AppearanceCollection background={prefs.background} disabled={busy || profilesLocked} onApply={applyProfile} />
      </div>
    </details>
    <div className="ap-theme-recovery">
      {previous && <Button size="sm" variant="secondary" disabled={profilesLocked || busy}
        icon={<Icon name="rotate-ccw" size={14} />} onClick={() => { void run(async () => {
          const restored = await restorePreviousAppearanceProfile();
          if (restored) { onProfileApplied(restored.mode); setFeedback(t('appearance.previousRestored')); }
        }); }}>{t('appearance.restorePrevious')}</Button>}
      <Button size="sm" variant="secondary" disabled={profilesLocked || busy} icon={<Icon name="sun" size={14} />}
        onClick={() => applyProfile(standardAppearanceProfile())}>{t('appearance.standardTheme')}</Button>
    </div>
    <SettingRow label={t('appearance.acrylic')} description={t(`appearance.native.${native.reason}`)}
      control={<Toggle checked={prefs.acrylic} disabled={busy} ariaLabel={t('appearance.acrylic')}
        onChange={acrylic => update({ acrylic })} />} />
    {prefs.acrylic && <SettingRow label={t('appearance.nativeMaterial')} description={t(`appearance.nativeMaterial.${prefs.nativeMaterial}.hint`)}
      control={<Select value={prefs.nativeMaterial} ariaLabel={t('appearance.nativeMaterial')} disabled={busy}
        options={(['acrylic', 'mica'] as const).map(value => ({ value, label: t(`appearance.nativeMaterial.${value}`) }))}
        onChange={value => update({ nativeMaterial: value as Appearance['nativeMaterial'] })} />} />}
    {native.active && prefs.background !== 'none' && <p className="ap-hint ap-native-note">{t('appearance.nativeCovered')}</p>}
    <SettingRow label={t('appearance.glassInEditor')} description={t('appearance.glassInEditorHint')}
      control={<Button variant="secondary" size="sm" onClick={() => openEditor('glass')}>{t('appearance.editGlass')}</Button>} />
    <SettingRow label={t('appearance.background')} description={t('appearance.backgroundHint')} control={<Select value={prefs.background}
      options={(['none', 'aurora', 'aero', 'sunset', ...SCENIC_BACKGROUNDS, ...(prefs.wallpaper ? ['image'] : [])] as Appearance['background'][])
        .map(value => ({ value, label: t(`appearance.background.${value}`) }))}
      onChange={value => update({ background: value as Appearance['background'] })} />} />
    <div className="ap-actions">
      <Button size="sm" variant="secondary" onClick={() => wallpaperInput.current?.click()}>{t('appearance.chooseImage')}</Button>
      {prefs.wallpaper && <Button size="sm" variant="ghost" onClick={() => update({ wallpaper: '', background: 'none' })}>{t('appearance.removeImage')}</Button>}
      <input ref={wallpaperInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={event => { loadWallpaper(event.target.files?.[0]); event.target.value = ''; }} />
    </div>
    <SettingRow label={t('appearance.backgroundDim')} control={slider('backgroundDim', 0, 85)} />
    <details className="ap-advanced ap-disclosure ap-profiles" data-setting-label={t('appearance.profiles')}>
      <summary><Icon name="chevron-right" size={16} /><span>{t('appearance.profiles')}</span>
        <span className="ap-disclosure-meta">{profiles.length}/8</span></summary>
      <div className="ap-disclosure-body">
      <p className="ap-hint">{t('appearance.profilesHint')}</p>
      {profilesLocked && <p className="ap-hint">{t('appearance.editorHint')}</p>}
      <div className="ap-profile-section">
        <strong className="ap-profile-heading">{t('appearance.saveCurrent')}</strong>
        <div className="ap-profile-save">
          <label className="ap-profile-name"><span>{t('appearance.profileName')}</span>
            <TextField value={profileName} onChange={value => setProfileName(value.slice(0, 60))}
              placeholder={t('appearance.profileNameExample')} ariaLabel={t('appearance.profileName')} /></label>
          <Button size="sm" variant="primary" disabled={profilesLocked || profileLimitReached || !profileName.trim() || busy}
            icon={<Icon name={replacingProfile ? 'refresh' : 'plus'} size={14} />}
            onClick={() => { void run(() => {
              saveAppearanceProfile(captureAppearanceProfile(profileName));
              const updated = loadAppearanceProfiles(); setProfiles(updated);
              setProfileIndex(String(updated.findIndex(p => p.name === profileName.trim())));
              setFeedback(`${t('appearance.profileSaved')}: ${profileName.trim()}`);
            }); }}>{t(replacingProfile ? 'appearance.replaceProfile' : 'appearance.saveProfile')}</Button>
        </div>
        {replacingProfile && <p className="ap-hint">{t('appearance.replaceHint')}</p>}
        {profileLimitReached && <p className="ap-hint">{t('appearance.profileLimit')}</p>}
      </div>
      <div className="ap-profile-section">
        <strong className="ap-profile-heading">{t('appearance.savedProfiles')}</strong>
        {profiles.length > 0 ? <div className="ap-profile-saved">
          <Select value={profileIndex} placeholder={t('appearance.selectProfile')} ariaLabel={t('appearance.selectProfile')} disabled={busy}
            options={profiles.map((p, i) => ({ value: String(i), label: p.name }))} onChange={setProfileIndex} />
          <Button size="sm" variant="secondary" disabled={profilesLocked || !selectedProfile || busy}
            icon={<Icon name="check" size={14} />} onClick={() => selectedProfile && applyProfile(selectedProfile)}>{t('appearance.applyProfile')}</Button>
          <Button size="sm" variant="ghost" className="ap-profile-delete" disabled={!selectedProfile || busy}
            icon={<Icon name="trash" size={14} />} onClick={() => { void run(() => {
              if (!selectedProfile) return;
              removeAppearanceProfile(selectedProfile.name); setProfiles(loadAppearanceProfiles()); setProfileIndex('');
              setFeedback(`${t('appearance.profileDeleted')}: ${selectedProfile.name}`);
            }); }}>{t('appearance.deleteProfile')}</Button>
        </div> : <p className="ap-hint">{t('appearance.noProfiles')}</p>}
      </div>
      <div className="ap-profile-section">
        <strong className="ap-profile-heading">{t('appearance.profileFiles')}</strong>
        <p className="ap-hint">{t('appearance.profileFilesHint')}</p>
        <div className="ap-profile-files">
          <Button size="sm" variant="secondary" disabled={profilesLocked || busy} icon={<Icon name="download" size={14} />}
            onClick={exportProfile}>{t('appearance.export')}</Button>
          <Button size="sm" variant="secondary" disabled={busy} icon={<Icon name="upload" size={14} />}
            onClick={() => profileInput.current?.click()}>{t('appearance.import')}</Button>
        </div>
        <input ref={profileInput} type="file" accept=".json" hidden onChange={event => { importProfile(event.target.files?.[0]); event.target.value = ''; }} />
      </div>
      </div>
    </details>
    <div className="ap-actions"><Button size="sm" variant="ghost" onClick={() => update({ acrylic: false, nativeMaterial: DEFAULT_APPEARANCE.nativeMaterial, background: DEFAULT_APPEARANCE.background, wallpaper: '', backgroundDim: DEFAULT_APPEARANCE.backgroundDim })}>
      {t('appearance.reset')}</Button></div>
    {error && <p className="ap-error" role="alert"><ErrorMessage error={error} /></p>}
    <p className="ap-feedback" role="status" aria-live="polite">{feedback}</p>
  </SettingsCard>;
}
