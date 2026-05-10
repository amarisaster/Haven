import { useState, useRef } from 'react';

interface WallpaperPickerProps {
  onSelect: (wallpaper: string) => void;
  onClose: () => void;
  current: string;
}

const PRESET_GRADIENTS = [
  { label: 'Ember', value: 'linear-gradient(135deg, #1a0a0a 0%, #2d1515 50%, #0c0a09 100%)' },
  { label: 'Twilight', value: 'linear-gradient(135deg, #0a0a1a 0%, #1a1030 50%, #0c0a09 100%)' },
  { label: 'Forest', value: 'linear-gradient(135deg, #0a1a0a 0%, #102010 50%, #0c0a09 100%)' },
  { label: 'Ocean', value: 'linear-gradient(135deg, #0a1520 0%, #0c2030 50%, #0c0a09 100%)' },
  { label: 'Sunset', value: 'linear-gradient(135deg, #1a100a 0%, #2d1a10 50%, #0c0a09 100%)' },
  { label: 'Amethyst', value: 'linear-gradient(135deg, #150a1a 0%, #201030 50%, #0c0a09 100%)' },
];

const STARFIELD = 'preset:starfield';

const SOLID_COLORS = [
  '#0c0a09', '#1c1917', '#292524', '#1a1a2e', '#16213e',
  '#0f3460', '#1a0a2e', '#2d132c', '#1e1e1e', '#0d1117',
  '#1b1b2f', '#162447', '#1f1f38', '#0b0c10', '#121212',
];

type Tab = 'presets' | 'colors' | 'upload';

export default function WallpaperPicker({ onSelect, onClose, current }: WallpaperPickerProps) {
  const [tab, setTab] = useState<Tab>('presets');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const MAX = 1920;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const scale = MAX / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      onSelect(`url(${dataUrl})`);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };

  const isSelected = (val: string) => current === val;

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200 }}
        onClick={onClose}
      />

      {/* Bottom sheet */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 201,
        background: 'var(--haven-surface)',
        borderTop: '1px solid var(--haven-border)',
        borderRadius: '16px 16px 0 0',
        maxHeight: '60vh',
        display: 'flex', flexDirection: 'column',
        animation: 'slideUp 0.2s ease-out',
      }}>
        <style>{`
          @keyframes slideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
        `}</style>

        {/* Handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
          <div style={{ width: '40px', height: '4px', borderRadius: '2px', background: 'var(--haven-border)' }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 16px 12px' }}>
          <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--haven-text)' }}>Wallpaper</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => { onSelect(''); onClose(); }}
              style={{
                padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--haven-border)',
                background: 'transparent', color: 'var(--haven-text-secondary)', fontSize: '12px', cursor: 'pointer',
              }}
            >Reset</button>
            <button
              onClick={onClose}
              style={{
                padding: '4px 12px', borderRadius: '6px', border: 'none',
                background: 'var(--haven-accent)', color: 'white', fontSize: '12px', cursor: 'pointer',
              }}
            >Done</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--haven-border)', padding: '0 16px' }}>
          {(['presets', 'colors', 'upload'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1, padding: '8px 0', background: 'transparent', border: 'none',
                borderBottom: tab === t ? '2px solid var(--haven-accent)' : '2px solid transparent',
                color: tab === t ? 'var(--haven-accent)' : 'var(--haven-text-muted)',
                fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >{t}</button>
          ))}
        </div>

        {/* Content */}
        <div className="hide-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          {tab === 'presets' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
              {PRESET_GRADIENTS.map((g) => (
                <button
                  key={g.label}
                  onClick={() => onSelect(g.value)}
                  style={{
                    height: '70px', borderRadius: '10px', border: isSelected(g.value) ? '2px solid var(--haven-accent)' : '2px solid var(--haven-border)',
                    background: g.value, cursor: 'pointer', position: 'relative', overflow: 'hidden',
                  }}
                >
                  <span style={{
                    position: 'absolute', bottom: '4px', left: 0, right: 0, textAlign: 'center',
                    fontSize: '10px', color: 'var(--haven-text-secondary)',
                  }}>{g.label}</span>
                </button>
              ))}
              {/* Starfield */}
              <button
                onClick={() => onSelect(STARFIELD)}
                style={{
                  height: '70px', borderRadius: '10px',
                  border: isSelected(STARFIELD) ? '2px solid var(--haven-accent)' : '2px solid var(--haven-border)',
                  background: 'radial-gradient(ellipse at center, #0a0a1a 0%, #000 100%)',
                  cursor: 'pointer', position: 'relative', overflow: 'hidden',
                }}
              >
                <span style={{ fontSize: '16px' }}>✨</span>
                <span style={{
                  position: 'absolute', bottom: '4px', left: 0, right: 0, textAlign: 'center',
                  fontSize: '10px', color: 'var(--haven-text-secondary)',
                }}>Starfield</span>
              </button>
            </div>
          )}

          {tab === 'colors' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px' }}>
              {SOLID_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => onSelect(c)}
                  style={{
                    width: '100%', aspectRatio: '1', borderRadius: '10px',
                    border: isSelected(c) ? '2px solid var(--haven-accent)' : '2px solid var(--haven-border)',
                    background: c, cursor: 'pointer',
                  }}
                />
              ))}
            </div>
          )}

          {tab === 'upload' && (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <button
                onClick={() => fileRef.current?.click()}
                style={{
                  padding: '12px 24px', borderRadius: '10px', border: '2px dashed var(--haven-border)',
                  background: 'transparent', color: 'var(--haven-text-secondary)', fontSize: '14px',
                  cursor: 'pointer', width: '100%', minHeight: '100px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px',
                }}
              >
                <span style={{ fontSize: '24px' }}>📁</span>
                <span>Choose an image</span>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={handleUpload}
                style={{ display: 'none' }}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
