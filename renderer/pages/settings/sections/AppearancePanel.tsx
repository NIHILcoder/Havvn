import React, { useEffect, useRef, useState } from 'react';
import { SettingsCard, SettingRow, TextField } from '../controls';
import { Button, Select, Toggle } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import { DEFAULT_APPEARANCE, MAX_WALLPAPER_LENGTH, validWallpaper, type Appearance } from '../../../../shared/appearance';
import { validateAppearanceProfile, type AppearanceProfile } from '../../../../shared/appearance-profile';
import { acrylicStatus, APPEARANCE_EVENT, readAppearance, saveAppearance } from '../../../utils/appearance';
import { applyAppearanceProfile, captureAppearanceProfile, loadAppearanceProfiles,
  removeAppearanceProfile, saveAppearanceProfile } from '../../../utils/appearance-profiles';
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
  const wallpaperInput = useRef<HTMLInputElement>(null);
  const profileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const sync = () => { setPrefs(readAppearance()); setNative(acrylicStatus()); };
    window.addEventListener(APPEARANCE_EVENT, sync);
    return () => { alive.current = false; window.removeEventListener(APPEARANCE_EVENT, sync); };
  }, []);
  const run = async (action: () => void | Promise<void>) => {
    setError(''); setBusy(true);
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
  const selectedProfile = profiles[Number(profileIndex)];
  const profileLimitReached = profiles.length >= 8 && !profiles.some(p => p.name === profileName.trim());
  const applyProfile = (profile: AppearanceProfile) => { void run(async () => {
    await applyAppearanceProfile(profile); onProfileApplied(profile.mode);
    setPrefs(readAppearance()); setNative(acrylicStatus());
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
    saveAppearanceProfile(profile); setProfiles(loadAppearanceProfiles()); setProfileName(profile.name);
  }); };
  const exportProfile = () => { void run(() => {
    const profile = captureAppearanceProfile(profileName.trim() || 'Havvn');
    const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'havvn.appearance.json';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }); };
  return <SettingsCard title={t('appearance.title')} icon="sun" description={t('appearance.description')}>
    <SettingRow label={t('appearance.acrylic')} description={t(`appearance.native.${native.reason}`)}
      control={<Toggle checked={prefs.acrylic} disabled={busy} ariaLabel={t('appearance.acrylic')}
        onChange={acrylic => update({ acrylic })} />} />
    <SettingRow label={t('appearance.glassInEditor')} description={t('appearance.glassInEditorHint')}
      control={<Button variant="secondary" size="sm" onClick={() => openEditor('glass')}>{t('appearance.editGlass')}</Button>} />
    <SettingRow label={t('appearance.background')} description={t('appearance.backgroundHint')} control={<Select value={prefs.background}
      options={(['none', 'aurora', 'aero', 'sunset', ...(prefs.wallpaper ? ['image'] : [])] as Appearance['background'][])
        .map(value => ({ value, label: t(`appearance.background.${value}`) }))}
      onChange={value => update({ background: value as Appearance['background'] })} />} />
    <div className="ap-actions">
      <Button size="sm" variant="secondary" onClick={() => wallpaperInput.current?.click()}>{t('appearance.chooseImage')}</Button>
      {prefs.wallpaper && <Button size="sm" variant="ghost" onClick={() => update({ wallpaper: '', background: 'none' })}>{t('appearance.removeImage')}</Button>}
      <input ref={wallpaperInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={event => { loadWallpaper(event.target.files?.[0]); event.target.value = ''; }} />
    </div>
    <SettingRow label={t('appearance.backgroundDim')} control={slider('backgroundDim', 0, 85)} />
    <details className="ap-advanced"><summary>{t('appearance.profiles')}</summary>
      <p className="ap-hint">{t('appearance.profilesHint')}</p>
      {profilesLocked && <p className="ap-hint">{t('appearance.editorHint')}</p>}
      <TextField value={profileName} onChange={value => setProfileName(value.slice(0, 60))} placeholder={t('appearance.profileName')} ariaLabel={t('appearance.profileName')} />
      <div className="ap-actions">
        <Button size="sm" variant="secondary" disabled={profilesLocked || profileLimitReached || !profileName.trim() || busy}
          onClick={() => { void run(() => { saveAppearanceProfile(captureAppearanceProfile(profileName)); setProfiles(loadAppearanceProfiles()); }); }}>
          {t('appearance.saveProfile')}</Button>
        <Button size="sm" variant="ghost" disabled={profilesLocked} onClick={exportProfile}>{t('appearance.export')}</Button>
        <Button size="sm" variant="ghost" onClick={() => profileInput.current?.click()}>{t('appearance.import')}</Button>
        <input ref={profileInput} type="file" accept=".json" hidden onChange={event => { importProfile(event.target.files?.[0]); event.target.value = ''; }} />
      </div>
      {profiles.length > 0 && <><Select value={profileIndex} placeholder={t('appearance.selectProfile')}
        options={profiles.map((p, i) => ({ value: String(i), label: p.name }))} onChange={setProfileIndex} />
        <div className="ap-actions"><Button size="sm" variant="primary" disabled={profilesLocked || !selectedProfile || profileIndex === '' || busy}
          onClick={() => selectedProfile && applyProfile(selectedProfile)}>{t('appearance.applyProfile')}</Button>
          <Button size="sm" variant="ghost" disabled={!selectedProfile || profileIndex === '' || busy} onClick={() => { void run(() => {
            removeAppearanceProfile(selectedProfile.name); setProfiles(loadAppearanceProfiles()); setProfileIndex('');
          }); }}>{t('appearance.deleteProfile')}</Button></div></>}
    </details>
    <div className="ap-actions"><Button size="sm" variant="ghost" onClick={() => update({ acrylic: false, background: DEFAULT_APPEARANCE.background, wallpaper: '', backgroundDim: DEFAULT_APPEARANCE.backgroundDim })}>
      {t('appearance.reset')}</Button></div>
    {error && <p className="ap-error" role="alert">{error}</p>}
  </SettingsCard>;
}
