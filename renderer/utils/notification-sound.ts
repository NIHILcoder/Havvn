let context: AudioContext | undefined;
let lastStarted = -Infinity;
/** A short local chime. No content/URLs reach the renderer and audio never starts a microphone. */
export async function playNotificationSound(): Promise<void> {
  try {
    const timestamp = performance.now();
    if (timestamp - lastStarted < 300) return;
    lastStarted = timestamp;
    if (!context || context.state === 'closed') context = new AudioContext();
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') return;
    const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, start);
    oscillator.frequency.setValueAtTime(880, start + .09);
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.08, start + .015);
    gain.gain.exponentialRampToValueAtTime(.001, start + .22);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start); oscillator.stop(start + .23);
  } catch { /* OS audio or autoplay restrictions must not affect the app. */ }
}
