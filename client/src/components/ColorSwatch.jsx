/** Renders a small colored square + hex label. color: {r,g,b} or null */
export default function ColorSwatch({ color, label }) {
  if (!color || color.r === null || color.r === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
        <span className="h-4 w-4 rounded border border-slate-700 bg-slate-800" />
        {label ?? 'Not set'}
      </span>
    );
  }
  const hex = `#${color.r.toString(16).padStart(2, '0')}${color.g.toString(16).padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`.toUpperCase();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-300">
      <span
        className="h-4 w-4 rounded border border-slate-600 shrink-0"
        style={{ backgroundColor: hex }}
        title={hex}
      />
      {label ?? hex}
    </span>
  );
}
