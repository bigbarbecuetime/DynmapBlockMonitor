import { useEffect, useRef } from 'react';

/**
 * Renders a zzzz_ tile image with a crosshair overlay at the target pixel.
 *
 * Props:
 *   tileUrl  — proxied tile URL, e.g. "/dynmap/tiles/..."
 *   pixelX   — pixel X offset within the 128×128 tile
 *   pixelZ   — pixel Z offset within the 128×128 tile
 *   scale    — display scale factor (default 4 → 512×512 px)
 */
export default function TilePreview({ tileUrl, pixelX, pixelZ, scale = 4 }) {
  const canvasRef = useRef(null);
  const size = 128 * scale;

  useEffect(() => {
    if (!tileUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Draw the tile scaled up (nearest-neighbour via CSS image-rendering)
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, size, size);

      // Crosshair
      const cx = (pixelX + 0.5) * scale;
      const cz = (pixelZ + 0.5) * scale;
      const half = scale / 2;

      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(0, cz);
      ctx.lineTo(size, cz);
      ctx.stroke();
      // Vertical line
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, size);
      ctx.stroke();

      // Red box around target pixel
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - half, cz - half, scale, scale);
      ctx.restore();
    };
    img.onerror = () => {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Tile not available', size / 2, size / 2);
    };
    img.src = tileUrl;
  }, [tileUrl, pixelX, pixelZ, scale, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ imageRendering: 'pixelated' }}
      className="rounded-lg border border-slate-700 max-w-full"
    />
  );
}
