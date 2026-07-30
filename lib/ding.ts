let ctx: AudioContext | null = null;

/** Short two-note chirp for incoming chat messages. Synthesized with the
 *  Web Audio API — no audio asset needed. */
export function playDing() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t); // A5
    osc.frequency.setValueAtTime(1174.66, t + 0.08); // D6
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  } catch {
    // Audio not available (rare) — a silent ding beats a crash.
  }
}
