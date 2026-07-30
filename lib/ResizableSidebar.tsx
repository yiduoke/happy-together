'use client';

import * as React from 'react';

const MIN_WIDTH = 260;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 360;
const STORAGE_KEY = 'ht-sidebar-width';

/**
 * Right sidebar with a draggable divider: drag to resize, use the chevron
 * (or double-click the divider) to collapse/expand. Children stay mounted
 * while collapsed so media and chat history keep working.
 */
export function ResizableSidebar(props: { children: React.ReactNode }) {
  const [width, setWidth] = React.useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = React.useState(false);
  const dragging = React.useRef(false);

  // Restore persisted width (after mount — localStorage is unavailable in SSR)
  React.useEffect(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (saved >= MIN_WIDTH && saved <= MAX_WIDTH) setWidth(saved);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (collapsed) return;
    dragging.current = true;
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no active pointer — dragging still works.
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
    setWidth(next);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setWidth((w) => {
      localStorage.setItem(STORAGE_KEY, String(w));
      return w;
    });
  };

  return (
    <>
      {/* Divider: drag to resize, double-click to collapse */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setCollapsed((c) => !c)}
        style={{
          width: 10,
          flexShrink: 0,
          cursor: collapsed ? 'default' : 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--lk-bg2, #1e1e1e)',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <button
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setCollapsed((c) => !c)}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.7)',
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          {collapsed ? '❮' : '❯'}
        </button>
      </div>
      {/* Keep children mounted while collapsed: tracks + chat history live on */}
      <div
        style={{
          width: collapsed ? 0 : width,
          minWidth: collapsed ? 0 : MIN_WIDTH,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {props.children}
      </div>
    </>
  );
}
