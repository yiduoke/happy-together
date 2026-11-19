'use client';

import React from 'react';

const STEP_SECONDS = 5;
/** Presses closer together than this add up, like the YouTube counter. */
const STACK_WINDOW_MS = 700;

type Flash = { dir: 'back' | 'forward'; seconds: number; id: number };

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.isContentEditable ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    // A range input uses the arrows itself, e.g. a volume slider.
    el.tagName === 'INPUT'
  );
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
      // Hidden (webcam-only mode) means nobody is watching it.
      if (!video || video.offsetParent === null || !Number.isFinite(video.duration)) return;

      // Capture phase + stop: with the video focused the browser would seek
      // too, and the two jumps would add up to 10 seconds.
      e.preventDefault();
      e.stopPropagation();

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
