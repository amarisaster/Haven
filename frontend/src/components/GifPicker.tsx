import { useState, useEffect, useRef, useCallback } from 'react';

interface GifPickerProps {
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

// No hardcoded fallback. A key committed here is public the moment the repo is,
// and a fallback also hides a missing config behind someone else's quota until
// that key dies — the same silent-failure shape as a vision fallback pointing at
// a retired model. Absent key => the picker says so instead of pretending.
const GIPHY_KEY = import.meta.env.VITE_GIPHY_KEY || '';

interface GiphyGif {
  id: string;
  images: {
    fixed_width: { url: string };
    original: { url: string };
  };
  title: string;
}

export default function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchGifs = useCallback(async (searchQuery: string) => {
    // A missing key must not look like "no results" — that reads as an empty
    // search and sends you hunting for the wrong problem.
    if (!GIPHY_KEY) { setGifs([]); setKeyMissing(true); setLoading(false); return; }
    setLoading(true);
    try {
      const endpoint = searchQuery.trim()
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(searchQuery)}&limit=20&rating=r`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=20&rating=r`;
      const res = await fetch(endpoint);
      const data = await res.json();
      setGifs(data.data || []);
    } catch {
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trending on mount
  useEffect(() => {
    fetchGifs('');
  }, [fetchGifs]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchGifs(query);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, fetchGifs]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: '8px',
        right: '8px',
        marginBottom: '8px',
        background: 'var(--haven-surface)',
        border: '1px solid var(--haven-border)',
        borderRadius: '12px',
        overflow: 'hidden',
        zIndex: 100,
        maxHeight: '360px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Search */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--haven-border)' }}>
        <input
          type="text"
          placeholder="Search GIFs..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          style={{
            width: '100%',
            background: 'var(--haven-card)',
            border: '1px solid var(--haven-border)',
            borderRadius: '8px',
            padding: '8px 12px',
            color: 'var(--haven-text)',
            fontSize: '13px',
            outline: 'none',
          }}
        />
      </div>

      {/* Grid */}
      <div
        className="hide-scrollbar"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px',
          alignContent: 'start',
        }}
      >
        {loading ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '24px', color: 'var(--haven-text-muted)', fontSize: '13px' }}>
            Loading...
          </div>
        ) : keyMissing ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '24px', color: '#fbbf24', fontSize: '13px', lineHeight: 1.5 }}>
            No GIPHY key configured.<br />Set VITE_GIPHY_KEY and rebuild.
          </div>
        ) : gifs.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '24px', color: 'var(--haven-text-muted)', fontSize: '13px' }}>
            No GIFs found
          </div>
        ) : (
          gifs.map((gif) => (
            <img
              key={gif.id}
              src={gif.images.fixed_width.url}
              alt={gif.title}
              loading="lazy"
              onClick={() => onSelect(gif.images.original.url)}
              style={{
                width: '100%',
                height: '120px',
                objectFit: 'cover',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'transform 0.1s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.03)')}
              onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
            />
          ))
        )}
      </div>

      {/* Attribution */}
      <div style={{
        padding: '6px 12px',
        borderTop: '1px solid var(--haven-border)',
        textAlign: 'center',
        fontSize: '10px',
        color: 'var(--haven-text-muted)',
      }}>
        Powered by GIPHY
      </div>
    </div>
  );
}
