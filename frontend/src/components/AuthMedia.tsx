import { useState, useEffect } from 'react';
import { getAuthToken, apiBase } from '../lib/api';

function needsAuth(url: string): boolean {
  const base = apiBase();
  return !!getAuthToken() && !!base && url.startsWith(base);
}

export default function AuthMedia({ url, type = 'img', style, alt, className }: {
  url: string;
  type?: 'img' | 'video' | 'audio';
  style?: React.CSSProperties;
  alt?: string;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!needsAuth(url)) { setBlobUrl(url); return; }
    let revoke = '';
    const token = getAuthToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
      .then(blob => { revoke = URL.createObjectURL(blob); setBlobUrl(revoke); })
      .catch(() => setFailed(true));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [url]);

  if (failed || !blobUrl) return null;

  if (type === 'img') return <img src={blobUrl} alt={alt || ''} style={style} className={className} loading="lazy" onError={() => setFailed(true)} />;
  if (type === 'video') return <video src={blobUrl} controls preload="metadata" style={style} className={className} />;
  return <audio src={blobUrl} controls preload="metadata" style={style} className={className} />;
}
