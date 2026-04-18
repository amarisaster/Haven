/**
 * Haven TTS — supports browser voices + ElevenLabs
 */

import { apiBase } from './api';

const LS_VOICE = 'haven-tts-voice';
const LS_ELEVEN_KEY = 'haven-eleven-key';
const LS_ELEVEN_VOICE = 'haven-eleven-voice-id';

export interface TTSSettings {
  mode: 'browser' | 'elevenlabs';
  browserVoice: string;  // voice name
  elevenLabsKey: string;
  elevenLabsVoiceId: string;
}

export function getTTSSettings(): TTSSettings {
  return {
    mode: (localStorage.getItem('haven-tts-mode') as 'browser' | 'elevenlabs') || 'browser',
    browserVoice: localStorage.getItem(LS_VOICE) || '',
    elevenLabsKey: localStorage.getItem(LS_ELEVEN_KEY) || '',
    elevenLabsVoiceId: localStorage.getItem(LS_ELEVEN_VOICE) || '',
  };
}

export function saveTTSSettings(settings: Partial<TTSSettings>) {
  if (settings.mode !== undefined) localStorage.setItem('haven-tts-mode', settings.mode);
  if (settings.browserVoice !== undefined) localStorage.setItem(LS_VOICE, settings.browserVoice);
  if (settings.elevenLabsKey !== undefined) localStorage.setItem(LS_ELEVEN_KEY, settings.elevenLabsKey);
  if (settings.elevenLabsVoiceId !== undefined) localStorage.setItem(LS_ELEVEN_VOICE, settings.elevenLabsVoiceId);
}

export function getBrowserVoices(): SpeechSynthesisVoice[] {
  return speechSynthesis.getVoices();
}

let currentAudio: HTMLAudioElement | null = null;

export async function speak(text: string, onEnd?: () => void): Promise<void> {
  stop();
  const settings = getTTSSettings();

  if (settings.mode === 'elevenlabs' && settings.elevenLabsKey && settings.elevenLabsVoiceId) {
    await speakElevenLabs(text, settings, onEnd);
  } else {
    speakBrowser(text, settings, onEnd);
  }
}

export function stop() {
  speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

function speakBrowser(text: string, settings: TTSSettings, onEnd?: () => void) {
  // Check if Web Speech API is available (not on Android WebView)
  if (!('speechSynthesis' in window) || window.speechSynthesis.getVoices().length === 0) {
    speakCloud(text, onEnd);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);

  if (settings.browserVoice) {
    const voices = speechSynthesis.getVoices();
    const match = voices.find(v => v.name === settings.browserVoice);
    if (match) utterance.voice = match;
  }

  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  speechSynthesis.speak(utterance);
}

async function speakCloud(text: string, onEnd?: () => void) {
  // Cloud TTS fallback — routes through the user's own Haven Worker at /api/tts.
  // If their Worker doesn't implement /api/tts, the fetch returns 404 and we
  // silently give up. Users needing Android TTS should configure ElevenLabs.
  const base = apiBase();
  if (!base) { onEnd?.(); return; }
  try {
    const resp = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 1000) }),
    });
    if (!resp.ok) { onEnd?.(); return; }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; onEnd?.(); };
    audio.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; onEnd?.(); };
    audio.play();
  } catch {
    onEnd?.();
  }
}

async function speakElevenLabs(text: string, settings: TTSSettings, onEnd?: () => void) {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${settings.elevenLabsVoiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': settings.elevenLabsKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      console.error('ElevenLabs error:', res.status);
      // Fall back to browser
      speakBrowser(text, settings, onEnd);
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      onEnd?.();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      onEnd?.();
    };
    audio.play();
  } catch {
    speakBrowser(text, settings, onEnd);
  }
}
