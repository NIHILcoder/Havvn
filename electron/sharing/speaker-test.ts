/** Local output only. This graph has no microphone, voice session or peer sender. */
export class SpeakerTester {
  private stopCurrent: (() => void) | null = null;
  async play(outputDeviceId: string | null, volume: number): Promise<{ ok: boolean }> {
    this.stop();
    const ctx = new AudioContext({ sampleRate: 48000 });
    const audio = new Audio(), destination = ctx.createMediaStreamDestination();
    let stopped = false, finish: ((result: { ok: boolean }) => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (stopped) return;
      stopped = true; clearTimeout(timer);
      audio.pause(); audio.srcObject = null;
      destination.stream.getTracks().forEach(track => track.stop());
      void ctx.close().catch(() => {});
      if (this.stopCurrent === cleanup) this.stopCurrent = null;
      finish?.({ ok: false });
    };
    this.stopCurrent = cleanup;
    try {
      audio.srcObject = destination.stream;
      audio.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
      if (outputDeviceId && !audio.setSinkId) throw new Error('SPEAKER_OUTPUT_UNSUPPORTED');
      if (audio.setSinkId) await audio.setSinkId(outputDeviceId || '');
      if (stopped) return { ok: false };
      await ctx.resume();
      if (stopped) return { ok: false };
      await audio.play();
      if (stopped) return { ok: false };
      // Two short, gently ramped tones; avoid clicks and full-scale sine waves.
      for (const [offset, frequency] of [[0.04, 440], [0.50, 660]]) {
        const oscillator = ctx.createOscillator(), gain = ctx.createGain(), start = ctx.currentTime + offset;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.16, start + 0.025);
        gain.gain.setValueAtTime(0.16, start + 0.24); gain.gain.linearRampToValueAtTime(0, start + 0.30);
        oscillator.connect(gain); gain.connect(destination); oscillator.start(start); oscillator.stop(start + 0.31);
      }
      return await new Promise(resolve => { finish = resolve; timer = setTimeout(() => { finish = undefined; cleanup(); resolve({ ok: true }); }, 1100); });
    } catch (cause) { cleanup(); throw cause; }
  }
  stop(): void { this.stopCurrent?.(); }
}
