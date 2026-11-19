'use client';

import React from 'react';

const STEP_SECONDS = 5;
/** Presses closer together than this add up, like the YouTube counter. */
const STACK_WINDOW_MS = 700;

type Flash = { dir: 'back' | 'forward'; seconds: number; id: number };

// Inputs that take typed text, where the arrows move the caret. Checkboxes,
// radios and the file picker are inputs too, but they keep focus after being
// clicked — treating them as typing left the arrows dead after touching any
// subtitle or audio option.
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  // The arrows move a slider's value, so leave those to it.
  'range',
]);

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'SELECT') return true;
  const isInput = el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  if (isInput || el.tagName === 'TEXTAREA') {
    // The chat box keeps focus after you send a message. With nothing in it
    // the arrows have no caret to move, so let them through rather than
    // leaving them dead until you click away.
    return (el as HTMLInputElement | HTMLTextAreaElement).value !== '';
  }
  return el.isContentEditable;
}

/**
 * Left/right arrows jump the film 5 seconds, wherever focus happens to be,
 * and flash the jump on the picture. The browser only seeks on the arrows
 * when the video element itself has focus, which after clicking a button or
 * the sidebar it doesn't.
 *
 * Seeking goes through the normal `seeked` event, so it syncs to the room
 * exactly like dragging the scrubber does.
 */
export function SeekShortcuts(props: { videoRef: React.RefObject<HTMLVideoElement> }) {
  const [flash, setFlash] = React.useState<Flash | null>(null);
  const last = React.useRef<{ dir: Flash['dir']; at: number; seconds: number } | null>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isTyping(e.target)) return;
      const video = props.videoRef.current;
      // Hidden (webcam-only mode) means nobody is watching it. Not
      // offsetParent: a fullscreen element is position:fixed, so that is null
      // exactly when the film is filling the screen.
      if (!video || video.getClientRects().length === 0 || !Number.isFinite(video.duration)) {
        return;
      }

      // Capture phase + stop: with the video focused the browser would seek
      // too, and the two jumps would add up to 10 seconds.
      e.preventDefault();
      e.stopPropagation();
      // A held key auto-repeats ~30 times a second, and every repeat would
      // jump 5s: half a second of holding is 90s. One press, one jump.
      if (e.repeat) return;

      const dir: Flash['dir'] = e.key === 'ArrowLeft' ? 'back' : 'forward';
      // While a seek is pending currentTime already reports its target, so
      // held or rapid presses accumulate instead of repeating the same jump.
      const target = video.currentTime + (dir === 'back' ? -STEP_SECONDS : STEP_SECONDS);
      video.currentTime = Math.min(video.duration, Math.max(0, target));

      const now = performance.now();
      const prev = last.current;
      const seconds =
        prev && prev.dir === dir && now - prev.at < STACK_WINDOW_MS
          ? prev.seconds + STEP_SECONDS
          : STEP_SECONDS;
      last.current = { dir, at: now, seconds };
      setFlash({ dir, seconds, id: now });
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setFlash(null), STACK_WINDOW_MS);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [props.videoRef]);

  if (!flash) return null;
  const back = flash.dir === 'back';
  return (
    <div
      // Re-keying on each press restarts the fade, so repeats visibly pulse.
      key={flash.id}
      className="ht-seek-flash"
      aria-hidden
      style={{ [back ? 'left' : 'right']: '14%' }}
    >
      <div style={{ fontSize: 28, lineHeight: 1 }}>{back ? '⏪' : '⏩'}</div>
      <div style={{ fontSize: 14, marginTop: 4 }}>{flash.seconds} seconds</div>
    </div>
  );
}
