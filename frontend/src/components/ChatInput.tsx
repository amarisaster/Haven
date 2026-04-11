import { useState, useRef, useEffect } from 'react';
import GifPicker from './GifPicker';
import { uploadFile } from '../lib/api';

interface ChatInputProps {
  onSend: (message: string, image?: string) => void;
  disabled: boolean;
  placeholder?: string;
}

export default function ChatInput({ onSend, disabled, placeholder = 'Type a message...' }: ChatInputProps) {
  const [text, setText] = useState('');
  const [showGif, setShowGif] = useState(false);
  const [listening, setListening] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [pendingImage, setPendingImage] = useState<string | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Images: convert to base64 for vision
    if (file.type.startsWith('image/')) {
      setUploading(true);
      const reader = new FileReader();
      reader.onload = () => {
        setPendingImage(reader.result as string);
        setUploading(false);
      };
      reader.readAsDataURL(file);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    // Other files: upload to R2 as before
    setUploading(true);
    try {
      const result = await uploadFile(file);
      const apiUrl = localStorage.getItem('haven-api-url') || import.meta.env.VITE_API_URL || '';
      onSend(`${apiUrl}${result.url}`);
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const recognitionRef = useRef<any | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;
    if (disabled) return;
    onSend(trimmed || '(image)', pendingImage || undefined);
    setText('');
    setPendingImage(null);
    setShowGif(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleGifSelect = (gifUrl: string) => {
    onSend(gifUrl);
    setShowGif(false);
  };

  // Speech-to-text
  const toggleSTT = () => {
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      if (transcript) {
        setText((prev) => (prev ? prev + ' ' : '') + transcript);
      }
    };

    recognition.onerror = () => {
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.stop();
    };
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
    }
  }, [text]);

  return (
    <div style={{ position: 'relative', padding: '8px 12px 12px', background: 'var(--haven-bg)' }}>
      {/* GIF picker above */}
      {showGif && <GifPicker onSelect={handleGifSelect} onClose={() => setShowGif(false)} />}

      {/* Pending image preview */}
      {pendingImage && (
        <div style={{ marginBottom: '8px', position: 'relative', display: 'inline-block' }}>
          <img src={pendingImage} alt="Attached" style={{ maxHeight: '120px', borderRadius: '8px', border: '1px solid var(--haven-border)' }} />
          <button
            onClick={() => setPendingImage(null)}
            style={{
              position: 'absolute', top: '-6px', right: '-6px', width: '20px', height: '20px',
              borderRadius: '50%', background: '#ef4444', color: 'white', border: 'none',
              fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >x</button>
        </div>
      )}

      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: '4px',
      }}>
        {/* Hidden file input */}
        <input ref={fileRef} type="file" accept="image/*,application/pdf,text/plain,audio/*,video/mp4" onChange={handleFileUpload} className="hidden" />

        {/* Attach button */}
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          style={{
            width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0,
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: uploading ? 'var(--haven-accent)' : 'var(--haven-text-muted)',
            animation: uploading ? 'pulse 1.5s infinite' : undefined,
          }}
          title={uploading ? 'Uploading...' : 'Attach file'}
        >
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
          </svg>
        </button>

        {/* GIF button */}
        <button
          onClick={() => setShowGif(!showGif)}
          style={{
            width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0,
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: showGif ? 'var(--haven-accent)' : 'var(--haven-text-muted)',
            fontSize: '11px', fontWeight: 700,
          }}
        >GIF</button>

        {/* Input area */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'flex-end', gap: '6px',
          background: 'var(--haven-card)', borderRadius: '22px',
          padding: '6px 6px 6px 14px',
          border: '1px solid var(--haven-border)',
        }}>
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--haven-text)', fontSize: '14px', lineHeight: '1.4',
            padding: '6px 0', fontFamily: 'inherit',
            maxHeight: '120px',
          }}
        />

        {/* Mic / Send button */}
        {text.trim() ? (
          <button
            onClick={handleSend}
            disabled={disabled}
            style={{
              width: '36px', height: '36px', borderRadius: '50%',
              background: 'var(--haven-accent)',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 0.2s',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={toggleSTT}
            style={{
              width: '36px', height: '36px', borderRadius: '50%',
              background: listening ? 'var(--haven-accent)' : 'var(--haven-border)',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 0.2s',
              animation: listening ? 'pulse 1.5s infinite' : undefined,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
        )}
        </div>
      </div>

      {listening && (
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}</style>
      )}
    </div>
  );
}

// Extend window for Speech API types
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}
