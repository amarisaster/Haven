import { useEffect, useState, useRef } from 'react';
import type { CompanionFile } from '../lib/types';
import {
  listCompanionFiles, uploadCompanionFile, deleteCompanionFile,
} from '../lib/api';
import { extractFileText, isExtractableFile } from '../lib/file-extract';

interface FilesPanelProps {
  companionId: number;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatWhen(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Companion project files — attached PDFs / text / code whose extracted text
// gets injected into the system prompt for this companion. Upload runs
// client-side extraction (pdfjs, plain text) so the worker stores both the
// binary + the text for easy system-prompt injection later.
export default function FilesPanel({ companionId }: FilesPanelProps) {
  const [files, setFiles] = useState<CompanionFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setFiles(await listCompanionFiles(companionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [companionId]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      // Extract text client-side when possible — PDF via pdfjs, text files
      // directly. Worker stores both bytes (R2) + extracted_text (D1) so
      // the system prompt can read the text without re-downloading the PDF.
      let extracted = '';
      if (isExtractableFile(file)) {
        try {
          const r = await extractFileText(file);
          if (r) extracted = r.text;
        } catch {
          // Silently fall back to no-text — the binary still uploads.
        }
      }
      await uploadCompanionFile(companionId, file, extracted);
      if (inputRef.current) inputRef.current.value = '';
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: number, filename: string) => {
    if (!confirm(`Remove ${filename}? The extracted text will stop being injected into this companion's prompt.`)) return;
    try {
      await deleteCompanionFile(companionId, id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <div>
      <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginBottom: '12px', lineHeight: '1.5' }}>
        Attach PDFs, text, or code. The extracted text gets loaded into this companion's system prompt, so they "know" the contents across every thread. Files add to every conversation's context — big files = expensive chats.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.txt,.md,.json,.csv,.py,.js,.ts,.tsx,.jsx,.rs,.go,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.toml,.ini,.env,.sh,.log"
        onChange={onPick}
        className="hidden"
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        style={{
          width: '100%', padding: '10px', borderRadius: '8px',
          background: 'var(--haven-card)', border: '1px dashed var(--haven-border)',
          color: 'var(--haven-text-secondary)', fontSize: '13px',
          cursor: uploading ? 'default' : 'pointer', marginBottom: '12px',
          opacity: uploading ? 0.6 : 1,
        }}
      >
        {uploading ? 'Uploading…' : '+ Upload file'}
      </button>

      {error && (
        <p style={{ fontSize: '12px', color: '#f87171', marginBottom: '8px' }}>{error}</p>
      )}

      {loading ? (
        <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>Loading…</p>
      ) : files.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>No files yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {files.map(f => (
            <div
              key={f.id}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 10px', borderRadius: '8px',
                background: 'var(--haven-card)',
                border: '1px solid var(--haven-border)',
              }}
            >
              <span style={{ fontSize: '16px', flexShrink: 0 }}>📄</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '12px', color: 'var(--haven-text)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {f.filename}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--haven-text-muted)' }}>
                  {[
                    formatBytes(f.file_size),
                    f.text_length ? `${Math.round(f.text_length / 1000)}k chars` : null,
                    formatWhen(f.added_at),
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button
                onClick={() => remove(f.id, f.filename)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--haven-text-muted)', fontSize: '14px', padding: '4px 8px',
                }}
                title="Remove"
                aria-label={`Remove ${f.filename}`}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
