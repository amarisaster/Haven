/**
 * ImportWizard — Step-by-step chat import from other platforms
 */

import { useState, useRef } from 'react';
import JSZip from 'jszip';
import { autoDetectAndParse, type ImportResult } from '../lib/importers';
import { createThread, updateCompanion, addIdentity, apiBase, importCompanion, setActiveCompanionId } from '../lib/api';

interface ImportWizardProps {
  onClose: () => void;
  onComplete: (threadCount: number) => void;
}

export default function ImportWizard({ onClose, onComplete }: ImportWizardProps) {
  const [step, setStep] = useState<'upload' | 'preview' | 'importing' | 'done'>('upload');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [selectedThreads, setSelectedThreads] = useState<Set<number>>(new Set());
  const [importIdentity, setImportIdentity] = useState(true);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [importedCount, setImportedCount] = useState(0);
  const [importKind, setImportKind] = useState<'threads' | 'companion'>('threads');
  const fileRef = useRef<HTMLInputElement>(null);

  const parseJsonData = (data: any): ImportResult => {
    return autoDetectAndParse(data);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const isZip = file.name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';

      if (isZip) {
        const zip = await JSZip.loadAsync(file);
        const allThreads: ImportResult['threads'] = [];
        const allErrors: string[] = [];
        let detectedSource: ImportResult['source'] = 'unknown';
        let identity: ImportResult['identity'];

        const jsonFiles = Object.entries(zip.files).filter(
          ([name, f]) => !f.dir && name.endsWith('.json')
        );

        if (jsonFiles.length === 0) {
          allErrors.push('No JSON files found in the ZIP.');
        }

        for (const [name, zipFile] of jsonFiles) {
          try {
            const text = await zipFile.async('text');
            const data = JSON.parse(text);
            const parsed = parseJsonData(data);
            if (parsed.source !== 'unknown') detectedSource = parsed.source;
            if (parsed.identity && !identity) identity = parsed.identity;
            allThreads.push(...parsed.threads);
            allErrors.push(...parsed.errors);
          } catch {
            allErrors.push(`Failed to parse ${name}`);
          }
        }

        setResult({ source: detectedSource, threads: allThreads, identity, errors: allErrors });
        setSelectedThreads(new Set(allThreads.map((_, i) => i)));
        setStep('preview');
        return;
      }

      // Non-ZIP: single JSON. Check for Haven companion-project bundle first
      // (`haven_export_version` + `companion` at the top level) — those get
      // routed to the companion-import endpoint which creates a brand-new
      // companion (identity + memories + people + files) and we switch to
      // them. Anything else falls through to the chat-import flow.
      const text = await file.text();
      const data = JSON.parse(text);

      if (data && typeof data === 'object' && data.haven_export_version && data.companion) {
        setImportKind('companion');
        setStep('importing');
        setProgress({ current: 0, total: 1 });
        const res = await importCompanion(data);
        if (!res?.id) {
          setResult({ source: 'unknown', threads: [], errors: ['Companion import failed.'] });
          setStep('preview');
          return;
        }
        setActiveCompanionId(res.id);
        setImportedCount(1);
        setProgress({ current: 1, total: 1 });
        setStep('done');
        return;
      }

      const parsed = parseJsonData(data);
      setResult(parsed);
      setSelectedThreads(new Set(parsed.threads.map((_, i) => i)));
      setStep('preview');
    } catch {
      setResult({
        source: 'unknown',
        threads: [],
        errors: ['Failed to parse file. Supports .json and .zip files.'],
      });
      setStep('preview');
    }
  };

  const handleImport = async () => {
    if (!result) return;
    setStep('importing');

    const threadsToImport = result.threads.filter((_, i) => selectedThreads.has(i));
    setProgress({ current: 0, total: threadsToImport.length });

    let imported = 0;

    // Import identity if available and selected
    if (importIdentity && result.identity) {
      try {
        if (result.identity.name) {
          await updateCompanion({ name: result.identity.name });
        }
        if (result.identity.description) {
          await addIdentity({ content: result.identity.description, identity_type: 'backstory', priority: 10, pinned: true });
        }
        if (result.identity.personality) {
          await addIdentity({ content: result.identity.personality, identity_type: 'trait', priority: 8 });
        }
        if (result.identity.scenario) {
          await addIdentity({ content: result.identity.scenario, identity_type: 'dynamic', priority: 6 });
        }
        if (result.identity.systemPrompt) {
          await addIdentity({ content: result.identity.systemPrompt, identity_type: 'anchor', priority: 9, pinned: true });
        }
      } catch {}
    }

    // Import threads
    for (const thread of threadsToImport) {
      try {
        const created = await createThread(thread.title);
        if (created?.id) {
          // Save messages via direct API
          for (const msg of thread.messages) {
            await fetch(`${apiBase()}/api/import/message`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                thread_id: created.id,
                role: msg.role,
                content: msg.content,
                model: msg.model,
                created_at: msg.timestamp,
              }),
            });
          }
          imported++;
        }
      } catch {}
      setProgress(p => ({ ...p, current: p.current + 1 }));
    }

    setImportedCount(imported);
    setStep('done');
  };

  const toggleThread = (index: number) => {
    setSelectedThreads(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const sectionStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '16px',
  };

  const cardStyle: React.CSSProperties = {
    width: '100%', maxWidth: '520px', maxHeight: '80vh',
    background: 'var(--haven-surface)',
    border: '1px solid var(--haven-border)',
    borderRadius: '16px', overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  };

  return (
    <div style={sectionStyle} onClick={onClose}>
      <div style={cardStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--haven-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--haven-text)', margin: 0 }}>Import Conversations</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--haven-text-muted)', cursor: 'pointer', fontSize: '18px' }}>x</button>
        </div>

        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {/* Step: Upload */}
          {step === 'upload' && (
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: '14px', color: 'var(--haven-text-secondary)', marginBottom: '8px' }}>
                Bring your conversations home.
              </p>
              <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)', marginBottom: '24px' }}>
                Drop a .json or .zip file. Supports ChatGPT, Claude, SillyTavern, and Haven exports.
              </p>

              <input ref={fileRef} type="file" accept=".json,.zip" onChange={handleFile} className="hidden" />

              <button
                onClick={() => fileRef.current?.click()}
                style={{
                  padding: '16px 32px', borderRadius: '12px', border: '2px dashed var(--haven-border)',
                  background: 'transparent', color: 'var(--haven-text)', fontSize: '14px',
                  cursor: 'pointer', width: '100%',
                }}
              >
                Choose file (.json or .zip)
              </button>

              <div style={{ marginTop: '24px', textAlign: 'left' }}>
                <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)', fontWeight: 600, marginBottom: '8px' }}>How to export:</p>
                <div style={{ fontSize: '11px', color: 'var(--haven-text-muted)', lineHeight: '1.8' }}>
                  <p><strong style={{ color: 'var(--haven-text-secondary)' }}>ChatGPT:</strong> Settings &rarr; Data controls &rarr; Export data &rarr; use conversations.json</p>
                  <p><strong style={{ color: 'var(--haven-text-secondary)' }}>Claude:</strong> Use a browser extension to export conversations as JSON</p>
                  <p><strong style={{ color: 'var(--haven-text-secondary)' }}>SillyTavern:</strong> Export character card as JSON</p>
                  <p><strong style={{ color: 'var(--haven-text-secondary)' }}>Haven:</strong> Settings &rarr; Export Everything</p>
                </div>
              </div>
            </div>
          )}

          {/* Step: Preview */}
          {step === 'preview' && result && (
            <div>
              {/* Source badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <span style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
                  background: result.source === 'unknown' ? '#7f1d1d' : 'var(--haven-card)',
                  color: result.source === 'unknown' ? '#f87171' : 'var(--haven-accent)',
                }}>
                  {result.source === 'chatgpt' ? 'ChatGPT' : result.source === 'claude' ? 'Claude' : result.source === 'sillytavern' ? 'SillyTavern' : result.source === 'haven' ? 'Haven' : 'Unknown'}
                </span>
                <span style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>
                  {result.threads.length} thread{result.threads.length !== 1 ? 's' : ''} found
                </span>
              </div>

              {/* Errors */}
              {result.errors.length > 0 && (
                <div style={{ marginBottom: '16px', padding: '10px', borderRadius: '8px', background: '#7f1d1d20', border: '1px solid #7f1d1d' }}>
                  {result.errors.map((err, i) => (
                    <p key={i} style={{ fontSize: '12px', color: '#f87171', margin: '4px 0' }}>{err}</p>
                  ))}
                </div>
              )}

              {/* Identity preview */}
              {result.identity && (
                <div style={{ marginBottom: '16px', padding: '12px', borderRadius: '8px', background: 'var(--haven-card)', border: '1px solid var(--haven-border)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={importIdentity} onChange={() => setImportIdentity(!importIdentity)} />
                    <span style={{ fontSize: '13px', color: 'var(--haven-text)' }}>
                      Import companion identity
                      {result.identity.name && <span style={{ color: 'var(--haven-accent)' }}> ({result.identity.name})</span>}
                    </span>
                  </label>
                </div>
              )}

              {/* Thread list */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>Select threads to import:</span>
                  <button
                    onClick={() => {
                      if (selectedThreads.size === result.threads.length) setSelectedThreads(new Set());
                      else setSelectedThreads(new Set(result.threads.map((_, i) => i)));
                    }}
                    style={{ fontSize: '11px', color: 'var(--haven-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    {selectedThreads.size === result.threads.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>

                <div style={{ maxHeight: '250px', overflowY: 'auto', borderRadius: '8px', border: '1px solid var(--haven-border)' }}>
                  {result.threads.map((thread, i) => (
                    <label
                      key={i}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                        borderBottom: '1px solid var(--haven-border)', cursor: 'pointer',
                        background: selectedThreads.has(i) ? 'var(--haven-card)' : 'transparent',
                      }}
                    >
                      <input type="checkbox" checked={selectedThreads.has(i)} onChange={() => toggleThread(i)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {thread.title}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--haven-text-muted)' }}>
                          {thread.messages.length} messages
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => { setStep('upload'); setResult(null); }}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px',
                    border: '1px solid var(--haven-border)', background: 'transparent',
                    color: 'var(--haven-text-secondary)', fontSize: '13px', cursor: 'pointer',
                  }}
                >Back</button>
                <button
                  onClick={handleImport}
                  disabled={selectedThreads.size === 0}
                  style={{
                    flex: 2, padding: '10px', borderRadius: '8px', border: 'none',
                    background: selectedThreads.size > 0 ? 'var(--haven-accent)' : 'var(--haven-border)',
                    color: 'white', fontSize: '13px', fontWeight: 600,
                    cursor: selectedThreads.size > 0 ? 'pointer' : 'default',
                  }}
                >Import {selectedThreads.size} thread{selectedThreads.size !== 1 ? 's' : ''}</button>
              </div>
            </div>
          )}

          {/* Step: Importing */}
          {step === 'importing' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ width: '40px', height: '40px', margin: '0 auto 16px', border: '3px solid var(--haven-accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
              <p style={{ fontSize: '14px', color: 'var(--haven-text)', marginBottom: '8px' }}>Importing conversations...</p>
              <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>
                {progress.current} / {progress.total} threads
              </p>
              <div style={{ width: '100%', height: '4px', background: 'var(--haven-border)', borderRadius: '2px', marginTop: '16px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', background: 'var(--haven-accent)', borderRadius: '2px',
                  width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                  transition: 'width 0.3s',
                }} />
              </div>
            </div>
          )}

          {/* Step: Done */}
          {step === 'done' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>🏠</div>
              <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--haven-text)', marginBottom: '8px' }}>
                Welcome home
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--haven-text-secondary)', marginBottom: '24px' }}>
                {importKind === 'companion'
                  ? 'Companion imported and made active.'
                  : `${importedCount} thread${importedCount !== 1 ? 's' : ''} imported successfully.`}
              </p>
              <button
                onClick={() => onComplete(importedCount)}
                style={{
                  padding: '12px 32px', borderRadius: '10px', border: 'none',
                  background: 'var(--haven-accent)', color: 'white',
                  fontSize: '14px', fontWeight: 600, cursor: 'pointer',
                }}
              >Start chatting</button>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
