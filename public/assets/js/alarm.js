/* The SOS alarm for staff pages: a siren that keeps going until someone
   acknowledges it, and a system notification where the platform allows one.

   Limits worth knowing: a web app can only ring while it is open (or very
   recently backgrounded). Browsers start audio only after a first tap, and
   an iPhone's silent switch mutes it; notifications need permission, granted
   from a tap, and on iOS exist only for the home-screen app (16.4+). */

export function createAlarm() {
  let ctx = null;
  let timer = null;

  function unlock() {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch { /* no audio on this device */ }
  }
  // Audio may only start from a gesture: take the first one, and every later one in case it was suspended.
  document.addEventListener('click', unlock, true);
  document.addEventListener('touchend', unlock, true);

  function burst() {
    try {
      unlock();
      if (!ctx) return;
      const t = ctx.currentTime;
      [960, 720, 960, 720].forEach((hz, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = hz;
        const at = t + i * 0.28;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.27);
      });
    } catch { /* keep going: vibration and the banner still work */ }
    if (navigator.vibrate) navigator.vibrate([400, 120, 400, 120, 400]);
  }

  return {
    start() {
      if (timer) return;
      burst();
      timer = setInterval(burst, 1600);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      if (navigator.vibrate) navigator.vibrate(0);
    },
    ringing: () => timer !== null,
    test() { burst(); }
  };
}

/** 'unsupported' | 'default' | 'granted' | 'denied' */
export const notificationState = () => ('Notification' in window ? Notification.permission : 'unsupported');

/** Ask for permission. Must be called from a tap. */
export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** A system notification through the service worker, if permitted. Resolves to whether one was shown. */
export async function notifySystem(title, body, tag) {
  if (notificationState() !== 'granted' || !('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body, tag, renotify: true, requireInteraction: true,
      icon: 'assets/icons/icon-192.png', badge: 'assets/icons/icon-192.png',
      vibrate: [400, 120, 400, 120, 400]
    });
    return true;
  } catch {
    return false;
  }
}
