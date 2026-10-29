/**
 * QR Code Component
 *
 * Renders a real, scannable QR code via the `qrcode` library (canvas).
 */

import React, { useEffect, useRef } from 'react';
import QRCodeLib from 'qrcode';
import './QRCode.css';

interface QRCodeProps {
  data: string;
  size?: number;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  label?: string;
  onError?(): void;
}

export const QRCode: React.FC<QRCodeProps> = ({
  data,
  size = 200,
  errorCorrectionLevel = 'M',
  label = 'QR code',
  onError,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    // Long links (e.g. share URLs) need a lower EC level to stay within capacity.
    const ec = data.length > 230 ? 'L' : errorCorrectionLevel;
    QRCodeLib.toCanvas(canvas, data, {
      width: size,
      margin: 1,
      errorCorrectionLevel: ec,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch((err) => {
      if (onError) { onError(); return; }
      // eslint-disable-next-line no-console
      console.error('Failed to render QR code:', err);
    });
  }, [data, size, errorCorrectionLevel, onError]);

  return (
    <div className="qr-code-container">
      <canvas ref={canvasRef} className="qr-code-canvas" role="img" aria-label={label} />
    </div>
  );
};
