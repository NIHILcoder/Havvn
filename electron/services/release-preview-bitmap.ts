import { BrowserWindow, nativeImage } from 'electron';
import { ProviderNetworkError } from '../../shared/provider-network';
import { releaseImageFormat } from '../../shared/release-image';

const LIMIT = 3 * 1024 * 1024;
/** NativeImage on Windows handles PNG/JPEG; Chromium supplies the WebP codec. */
export async function previewBitmap(bytes: Buffer, signal: AbortSignal): Promise<string> {
  const format = releaseImageFormat(bytes);
  if (signal.aborted) throw new ProviderNetworkError('cancelled');
  let bitmap = nativeImage.createFromBuffer(bytes);
  if (!bitmap.isEmpty()) {
    const size = bitmap.getSize();
    if (!size.width || !size.height || size.width * size.height > 16000000) throw new Error('Unsupported preview image');
    const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
    if (scale < 1) bitmap = bitmap.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' });
    const jpeg = bitmap.toJPEG(85);
    if (jpeg.length > LIMIT) throw new ProviderNetworkError('too-large');
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }
  if (format !== 'webp') throw new Error('Unsupported preview image');
  const worker = new BrowserWindow({ show: false, width: 16, height: 16, webPreferences: {
    partition: 'havvn-preview-bitmap', nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false,
  } });
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  worker.webContents.on('will-navigate', event => event.preventDefault());
  const dataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, data?: string) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(data!);
      };
      const abort = () => finish(new ProviderNetworkError('cancelled'));
      const timer = setTimeout(() => finish(new ProviderNetworkError('timeout')), 6000);
      signal.addEventListener('abort', abort, { once: true });
      worker.webContents.once('render-process-gone', () => finish(new Error('Preview decoder unavailable')));
      worker.once('closed', abort);
      const document = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; script-src \'none\'; object-src \'none\'; frame-src \'none\'">';
      void worker.loadURL('data:text/html;base64,' + Buffer.from(document).toString('base64')).then(async () => {
        if (settled) return;
        // Fixed code and base64 bytes only. No page/network content, preload or Node.
        const data = await worker.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `new Promise((resolve,reject)=>{
          const image=new Image();image.onerror=()=>reject(Error('Invalid image'));image.onload=()=>{
            const w=image.naturalWidth,h=image.naturalHeight;if(!w||!h||w*h>16000000){reject(Error('Invalid image dimensions'));return;}
            const scale=Math.min(1,1600/Math.max(w,h)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
            const context=canvas.getContext('2d');if(!context){reject(Error('Decoder unavailable'));return;}context.drawImage(image,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',0.85));
          };image.src=${JSON.stringify(dataUrl)};
        })` }]);
        if (typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,') || data.length > 4200000) throw new Error('Invalid decoded image');
        finish(undefined, data);
      }).catch(error => finish(error));
      if (signal.aborted) abort();
    });
  } finally { if (!worker.isDestroyed()) worker.destroy(); }
}
