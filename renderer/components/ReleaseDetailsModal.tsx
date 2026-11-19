import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MergedResult } from '../../shared/search-dedupe';
import type { ReleasePreviewImage, SearchReleaseDetails } from '../../shared/search-release-details';
import { useTranslation } from '../utils/i18nContext';
import { usePortalTarget } from '../utils/hostWindow';
import { formatBytes } from '../utils/format-helpers';
import { Modal } from './Modal';
import { Button } from './Button';
import { Icon } from './Icon';
import { Select } from './Select';
import './ReleaseDetailsModal.css';

function ReleaseImage({ image, eager = false, enlarged = false, onOpen }: {
  image: ReleasePreviewImage; eager?: boolean; enlarged?: boolean; onOpen?: () => void;
}) {
  const { t } = useTranslation(), ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager), [revision, setRevision] = useState(0);
  const [data, setData] = useState<string>(), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (visible) return;
    if (!ref.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: ref.current.closest('.um-body'), rootMargin: '100px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const request = crypto.randomUUID(); setData(undefined); setFailed(false);
    void window.api.search.releaseImage(image.id, request).then(value => {
      if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(value) || value.length > 4200000) throw new Error('Invalid image');
      if (alive) setData(value);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; void window.api.search.cancelPreview(request).catch(() => {}); };
  }, [image.id, visible, revision]);
  const alt = image.label || t('search.preview.image');
  return <div ref={ref} className={`release-bitmap${enlarged ? ' enlarged' : ''}`}>
    {data ? onOpen ? <button className="release-image-open" type="button" onClick={onOpen} aria-label={t('search.preview.enlarge')}><img src={data} alt={alt} /></button>
      : <img src={data} alt={alt} /> : <div className="release-image-state" role="status">
        {failed ? <><Icon name="alert-triangle" size={20} /><span>{t('search.preview.imageFailed')}</span>
          <Button size="sm" variant="ghost" onClick={() => setRevision(value => value + 1)}>{t('common.retry')}</Button></>
          : <><span className="spinner spinner-sm" aria-hidden="true" /><span>{t('common.loading')}</span></>}
      </div>}
  </div>;
}

export function ReleaseDetailsModal({ result, onClose, onDownload, onSelectFiles, onSignIn, busy, added }: {
  result: MergedResult; onClose: () => void; onDownload: (ref?: string) => Promise<void>;
  onSelectFiles?: (ref?: string) => void; onSignIn?: (providerId: string) => void; busy: boolean; added: boolean;
}) {
  const { t, language } = useTranslation(), portal = usePortalTarget();
  const refsKey = JSON.stringify(result.sourceRefs ?? []);
  const [selected, setSelected] = useState<string>(), [revision, setRevision] = useState(0);
  const requestKey = refsKey + '\0' + (selected ?? '') + '\0' + revision;
  const [state, setState] = useState<{ key: string; data?: SearchReleaseDetails; error?: 'search.preview.expired' | 'search.preview.failed' }>({ key: '' });
  const [tab, setTab] = useState<'description' | 'screenshots'>('description');
  const [gallery, setGallery] = useState<{ images: ReleasePreviewImage[]; index: number }>();
  const [submitting, setSubmitting] = useState(false), pending = useRef(false);
  const [actionFailed, setActionFailed] = useState(false);
  const forceRefresh = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let alive = true;
    const request = crypto.randomUUID(), refs: string[] = JSON.parse(refsKey);
    const refresh = forceRefresh.current; forceRefresh.current = false;
    setState({ key: requestKey }); setGallery(undefined); setTab('description'); setActionFailed(false);
    if (!refs.length) {
      setState({ key: requestKey, data: { title: result.title, url: result.detailsUrl, supported: false, blocks: [], screenshots: [], sources: [],
        source: { ref: '', providerId: '', name: result.provider, supported: false } } });
      return () => { alive = false; };
    }
    void window.api.search.releaseDetails(refs, request, selected, refresh).then(data => {
      if (alive) setState({ key: requestKey, data });
    }).catch(error => {
      if (alive) setState({ key: requestKey, error: /expired/i.test(String(error)) ? 'search.preview.expired' : 'search.preview.failed' });
    });
    return () => { alive = false; void window.api.search.cancelPreview(request).catch(() => {}); };
  }, [refsKey, selected, revision, requestKey, result.title, result.detailsUrl, result.provider]);
  const data = state.key === requestKey ? state.data : undefined;
  const failure = state.key === requestKey ? state.error : undefined;
  const loading = !data && !failure;
  let url: string | undefined;
  try { const target = new URL(data?.url ?? result.detailsUrl ?? ''); if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) url = target.href; } catch { /* Optional original page. */ }
  const openOriginal = () => { if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); };
  const refresh = () => { forceRefresh.current = true; setRevision(value => value + 1); };
  const allImages = data ? [...(data.poster ? [data.poster] : []), ...data.screenshots] : [];
  const showImage = (image: ReleasePreviewImage) => setGallery({ images: allImages, index: allImages.findIndex(entry => entry.id === image.id) });
  const download = async () => {
    if (pending.current || busy || added) return;
    pending.current = true; setSubmitting(true); setActionFailed(false);
    try { await onDownload(data?.source.ref || undefined); }
    catch { if (mounted.current) setActionFailed(true); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  };
  const content = <>
    <Modal title={t('search.preview.title')} icon="file" size="xl" className="release-details-modal" backdropClassName="release-details-backdrop" onClose={onClose} busy={submitting}
      footer={<>
        {url && /^https?:\/\//i.test(url) && <Button size="sm" variant="ghost" onClick={openOriginal} icon={<Icon name="external-link" size={14} />}>{t('search.row.openPage')}</Button>}
        {onSelectFiles && <Button size="sm" variant="secondary" onClick={() => onSelectFiles(data?.source.ref || undefined)} disabled={busy || submitting || loading}>{t('search.row.selectFiles')}</Button>}
        <Button size="sm" variant="primary" onClick={() => { void download(); }} loading={busy || submitting} disabled={added || loading}
          icon={<Icon name="download" size={14} />}>{t(added ? 'search.state.inDownloads' : 'search.download')}</Button>
      </>}>
      <h2 className="release-details-title">{data?.title || result.title}</h2>
      <div className="release-details-facts"><span>{formatBytes(result.size)}</span><span>{t('search.preview.seeds')}: {result.seeds} / {result.leechers}</span>{(!data || data.sources.length < 2) && <span>{data?.source.name || result.provider}</span>}</div>
      {actionFailed && <p role="alert">{t('search.failedToAdd')}</p>}
      {data && <div className="release-details-source">
        {data.sources.length > 1 && <Select ariaLabel={t('search.preview.source')} value={data.source.ref} disabled={submitting || busy}
          options={data.sources.map(source => ({ value: source.ref, label: source.name }))} onChange={setSelected} />}
        {data.supported && <Button size="sm" variant="ghost" onClick={refresh} disabled={submitting} icon={<Icon name="refresh" size={14} />}>{t('rooms.screen.refresh')}</Button>}
      </div>}
      {loading && <div className="release-details-state" role="status"><span className="spinner" />{t('search.preview.loading')}</div>}
      {failure && <div className="release-details-state" role="alert"><p>{t(failure)}</p><Button size="sm" onClick={refresh}>{t('common.retry')}</Button></div>}
      {data?.failure && <div className="release-details-state" role="alert"><p>{t(data.failure === 'auth' ? 'search.preview.auth' : data.failure === 'captcha' ? 'search.preview.captcha' : data.failure === 'rate-limit' ? 'search.preview.rateLimit' : 'search.preview.failed')}</p>
        <div className="release-details-retry"><Button size="sm" onClick={refresh}>{t('common.retry')}</Button>
          {onSignIn && ['auth', 'captcha'].includes(data.failure) && <Button size="sm" onClick={() => onSignIn(data.source.providerId)}>{t('search.connection.login')}</Button>}</div></div>}
      {data && !data.failure && <>
        <div className="release-details-tabs"><Button size="sm" variant={tab === 'description' ? 'primary' : 'secondary'} aria-pressed={tab === 'description'} onClick={() => setTab('description')}>{t('search.preview.description')}</Button>
          <Button size="sm" variant={tab === 'screenshots' ? 'primary' : 'secondary'} aria-pressed={tab === 'screenshots'} onClick={() => setTab('screenshots')} disabled={!data.screenshots.length}>{t('search.preview.screenshots')} ({data.screenshots.length})</Button></div>
        {tab === 'description' ? <div className={`release-details-overview${data.poster ? '' : ' no-poster'}`}>
          {data.poster && <aside className="release-details-poster"><ReleaseImage key={data.poster.id} image={data.poster} eager onOpen={() => showImage(data.poster!)} /></aside>}
          <section className="release-details-description" aria-label={t('search.preview.description')}>
            {!data.supported && <p>{t('search.preview.unsupported')}</p>}
            {data.supported && !data.blocks.length && <p>{t('search.preview.empty')}</p>}
            {data.blocks.map((block, index) => block.kind === 'heading' ? <h3 key={index}>{block.text}</h3>
              : block.kind === 'code' ? <pre key={index}>{block.text}</pre> : <p key={index}>{block.text}</p>)}
          </section>
        </div> : <div className="release-details-gallery">{data.screenshots.map((image, index) => <figure key={image.id}><ReleaseImage image={image} onOpen={() => showImage(image)} />
          <figcaption>{image.label || `${t('search.preview.screenshot')} ${index + 1}`}</figcaption></figure>)}</div>}
        {data.truncated && <p className="release-details-note">{t('search.preview.truncated')}</p>}
        {data.fetchedAt && <p className="release-details-note">{t('search.preview.fromSource')} · {new Date(data.fetchedAt).toLocaleString(language)}</p>}
      </>}
    </Modal>
    {gallery && <Modal title={`${t('search.preview.image')} ${gallery.index + 1}/${gallery.images.length}`} size="full" className="release-image-viewer" onClose={() => setGallery(undefined)}
      footer={<><Button size="sm" disabled={gallery.images.length < 2} onClick={() => setGallery({ ...gallery, index: (gallery.index - 1 + gallery.images.length) % gallery.images.length })}>{t('search.preview.previous')}</Button>
        <Button size="sm" disabled={gallery.images.length < 2} onClick={() => setGallery({ ...gallery, index: (gallery.index + 1) % gallery.images.length })}>{t('search.preview.next')}</Button></>}>
      <ReleaseImage key={gallery.images[gallery.index].id} image={gallery.images[gallery.index]} eager enlarged />
    </Modal>}
  </>;
  return portal ? createPortal(content, portal) : content;
}
