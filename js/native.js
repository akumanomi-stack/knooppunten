// Koppeling met de Android-app (Capacitor). In de gewone browser doet dit niets: isNative is dan false.
// Doel: GPS en meldingen blijven werken als het scherm uit staat of de app op de achtergrond draait.
const Cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
export const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());

const BG = isNative ? Cap.registerPlugin('BackgroundGeolocation') : null;
const LN = isNative ? Cap.registerPlugin('LocalNotifications') : null;

let notifId = 1;

/** Start het volgen van de positie; blijft doorlopen op de achtergrond met een melding in de statusbalk. */
export async function startNativeWatch(onPos, onErr) {
  const id = await BG.addWatcher(
    {
      backgroundTitle: 'Knooppunten',
      backgroundMessage: 'Je positie wordt gevolgd voor de route.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 5,
    },
    (location, error) => {
      if (error) {
        onErr({ code: error.code === 'NOT_AUTHORIZED' ? 1 : 2, native: error });
        if (error.code === 'NOT_AUTHORIZED') BG.openSettings?.().catch?.(() => {});
        return;
      }
      if (!location) return;
      onPos({ coords: { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy ?? 20 } });
    },
  );
  return id;
}

export async function stopNativeWatch(id) {
  try {
    await BG.removeWatcher({ id });
  } catch { /* al gestopt */ }
}

/** Vraagt eenmalig toestemming voor meldingen (Android 13 en hoger). */
export async function ensureNotificationPermission() {
  try {
    const st = await LN.checkPermissions();
    if (st.display !== 'granted') await LN.requestPermissions();
  } catch { /* niet erg */ }
}

/** Een melding in de statusbalk, zichtbaar ook bij vergrendeld scherm. */
export async function nativeNotify(title, body) {
  try {
    await LN.schedule({ notifications: [{ id: notifId++ % 2000000000, title, body }] });
  } catch { /* niet erg */ }
}
