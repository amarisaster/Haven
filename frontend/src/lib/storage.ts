import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const CRITICAL_KEYS = [
  'haven-auth-token',
  'haven-api-url',
  'haven-setup-done',
  'haven-active-companion-id',
];

export async function syncFromNativeStorage(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  for (const key of CRITICAL_KEYS) {
    const { value } = await Preferences.get({ key });
    if (value !== null) {
      localStorage.setItem(key, value);
    }
  }
}

export function persistSet(key: string, value: string): void {
  localStorage.setItem(key, value);
  if (Capacitor.isNativePlatform() && CRITICAL_KEYS.includes(key)) {
    Preferences.set({ key, value });
  }
}

export function persistRemove(key: string): void {
  localStorage.removeItem(key);
  if (Capacitor.isNativePlatform() && CRITICAL_KEYS.includes(key)) {
    Preferences.remove({ key });
  }
}
