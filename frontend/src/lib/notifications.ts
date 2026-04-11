import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';

let permissionGranted = false;

export async function initNotifications() {
  if (!Capacitor.isNativePlatform()) return;

  const result = await LocalNotifications.requestPermissions();
  permissionGranted = result.display === 'granted';
}

export async function notifyCompanionMessage(companionName: string, preview: string) {
  if (!Capacitor.isNativePlatform() || !permissionGranted) return;
  // Don't notify if app is in foreground
  if (document.visibilityState === 'visible') return;

  await LocalNotifications.schedule({
    notifications: [
      {
        title: companionName,
        body: preview.length > 100 ? preview.slice(0, 100) + '...' : preview,
        id: Date.now(),
        smallIcon: 'ic_launcher',
        largeIcon: 'ic_launcher',
      },
    ],
  });
}

export async function notifyStatusChange(companionName: string, status: string) {
  if (!Capacitor.isNativePlatform() || !permissionGranted) return;
  if (document.visibilityState === 'visible') return;

  await LocalNotifications.schedule({
    notifications: [
      {
        title: `${companionName}`,
        body: status,
        id: Date.now() + 1,
        smallIcon: 'ic_launcher',
        largeIcon: 'ic_launcher',
      },
    ],
  });
}
