import { useEffect, useRef } from 'react';

/**
 * Renders a tile image with a crosshair and indicator box overlay.
 *
 * Props:
 *   tileUrl     — proxied tile URL, e.g. "/dynmap/tiles/..."
 *   pixelX      — pixel X offset within the 128×128 tile (top-left of indicator)
 *   pixelZ      — pixel Z offset within the 128×128 tile (top-left of indicator)
 *   scale       — display scale factor (default 4 → 512×512 px)
 *   blockPixels — original-pixel size of the indicator box (default 1; use 16 for native tiles)
 *   onBlockMove — optional callback(newPixelX, newPixelZ); when provided the canvas
 *                 becomes draggable and the indicator snaps to block boundaries
 */
export default function TilePreview({ tileUrl, pixelX, pixelZ, scale = 4, blockPixels = 1, onBlockMove }) {
  const canvasRef = useRef(null);
  // Holds loaded image, live indicator position, and drag state — all in one ref to
  // avoid stale closures in event handlers without triggering re-renders.
  const stateRef = useRef({ img: null, liveX: pixelX, liveZ: pixelZ, drag: null });
  const size = 128 * scale;

  function draw(px, pz) {
    const canvas = canvasRef.current;
    const { img } = stateRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, size, size);

    const cx = (px + blockPixels / 2) * scale;
    const cz = (pz + blockPixels / 2) * scale;
    const half = (blockPixels * scale) / 2;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cz);  ctx.lineTo(size, cz); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, 0);  ctx.lineTo(cx, size); ctx.stroke();

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - half, cz - half, blockPixels * scale, blockPixels * scale);
    ctx.restore();
  }

  // Load image and draw initial indicator whenever tile URL or position changes.
  useEffect(() => {
    stateRef.current.liveX = pixelX;
    stateRef.current.liveZ = pixelZ;

    if (!tileUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      stateRef.current.img = img;
      draw(pixelX, pixelZ);
    };
    img.onerror = () => {
      stateRef.current.img = null;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Tile not available', size / 2, size / 2);
    };
    img.src = tileUrl;
  }, [tileUrl, pixelX, pixelZ, scale, size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register window-level drag handlers whenever the component is draggable.
  useEffect(() => {
    if (!onBlockMove) return;

    function snap(val) {
      return Math.max(0, Math.min(128 - blockPixels, Math.round(val / blockPixels) * blockPixels));
    }

    function onMouseMove(e) {
      const { drag } = stateRef.current;
      if (!drag) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const mz = e.clientY - rect.top;
      const newPx = snap(drag.startPX + (mx - drag.startMX) / scale);
      const newPz = snap(drag.startPZ + (mz - drag.startMZ) / scale);
      stateRef.current.liveX = newPx;
      stateRef.current.liveZ = newPz;
      draw(newPx, newPz);
    }

    function onMouseUp() {
      if (!stateRef.current.drag) return;
      stateRef.current.drag = null;
      onBlockMove(stateRef.current.liveX, stateRef.current.liveZ);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onBlockMove, scale, blockPixels]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleMouseDown(e) {
    if (!onBlockMove) return;
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    stateRef.current.drag = {
      startMX: e.clientX - rect.left,
      startMZ: e.clientY - rect.top,
      startPX: stateRef.current.liveX,
      startPZ: stateRef.current.liveZ,
    };
  }

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ imageRendering: 'pixelated', cursor: onBlockMove ? 'crosshair' : 'default' }}
      className="rounded-lg border border-slate-700 max-w-full"
      onMouseDown={handleMouseDown}
    />
  );
}
