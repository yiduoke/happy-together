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

/** Space presses these natively (a click), so leave it to them. */
function spaceActivates(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    ['BUTTON', 'A', 'SUMMARY', 'SELECT'].includes(el.tagName) ||
    (el.tagName === 'INPUT' && !TEXT_INPUT_TYPES.has((el as HTMLInputElement).type))
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
export function SeekShortcuts(props: {
  videoRef: React.RefObject<HTMLVideoElement>;
  /** Focusable (tabIndex -1) element around the film; see the click handler. */
  stageRef: React.RefObject<HTMLElement>;
}) {
  const [flash, setFlash] = React.useState<Flash | null>(null);
  const last = React.useRef<{ dir: Flash['dir']; at: number; seconds: number } | null>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clicking the video's built-in controls (play, scrubber) leaves focus
  // inside the browser's own control widget, and from there key presses go
  // only to that widget: the page never sees them, so these shortcuts never
  // run. The scrubber then steps by its own increment (a minute or more on a
  // film), Space presses the focused play button, and nothing flashes.
  // Clicks on those controls don't reach the page either, but the media
  // events they cause do — so use those to pull focus back out to the stage.
  React.useEffect(() => {
    const video = props.videoRef.current;
    if (!video) return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const reclaim = () => {
      // Only when focus is on the film. Remote play/pause/seek fire these
      // events too, and must not pull you out of the chat box mid-sentence.
      if (document.activeElement !== video) return;
      props.stageRef.current?.focus({ preventScroll: true });
    };
    const reclaimSoon = () => setTimeout(reclaim, 0);
    // Dragging the scrubber seeks continuously; wait for it to settle so the
    // drag isn't interrupted.
    const reclaimAfterScrub = () => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(reclaim, 400);
    };
    video.addEventListener('play', reclaimSoon);
    video.addEventListener('pause', reclaimSoon);
    video.addEventListener('seeked', reclaimAfterScrub);
    return () => {
      video.removeEventListener('play', reclaimSoon);
      video.removeEventListener('pause', reclaimSoon);
      video.removeEventListener('seeked', reclaimAfterScrub);
      if (settle) clearTimeout(settle);
    };
  }, [props.videoRef, props.stageRef]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === ' ') {
        // With focus on the stage the browser's own Space no longer applies,
        // so play/pause has to be handled here. Capture + stop also keeps the
        // browser from toggling a second time when the video has focus.
        if (isTyping(e.target) || spaceActivates(e.target)) return;
        const video = props.videoRef.current;
        if (!video || video.getClientRects().length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
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
