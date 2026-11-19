'use client';

import React from 'react';

/**
 * Fades its contents out after `idleMs` without interaction, and brings them
 * back on hover. It stays shown while hovered. Focus only restarts the timer:
 * a clicked checkbox keeps focus indefinitely, and holding the panel open for
 * that would mean it never fades after you pick a subtitle.
 *
 * Only the opacity changes. The faded box still takes the pointer, so hovering
 * where it sits is enough to bring it back.
 */
export function IdleFade(props: {
  idleMs: number;
  /** Changing this (e.g. the file name) shows it again and restarts the timer. */
  resetKey?: unknown;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const [shown, setShown] = React.useState(true);
  const hovered = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const restart = React.useCallback(() => {
    setShown(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!hovered.current) setShown(false);
    }, props.idleMs);
  }, [props.idleMs]);

  React.useEffect(() => {
    restart();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [restart, props.resetKey]);

  return (
    <div
      style={{
        ...props.style,
        opacity: shown ? 1 : 0,
        transition: shown ? 'opacity 0.2s ease-out' : 'opacity 0.8s ease-in',
      }}
      onPointerEnter={() => {
        hovered.current = true;
        setShown(true);
      }}
      onPointerLeave={() => {
        hovered.current = false;
        restart();
      }}
      onPointerDown={restart}
      onFocus={restart}
    >
      {props.children}
    </div>
  );
}
