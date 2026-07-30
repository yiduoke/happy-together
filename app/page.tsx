'use client';

import { useRouter } from 'next/navigation';
import React from 'react';
import { generateRoomId } from '@/lib/client-utils';

// Palette drawn from the Happy Together (1997) poster: teal sky, crimson type.
const TEAL_TOP = '#2e9f96';
const TEAL_BOTTOM = '#7cc5b1';
const CRIMSON = '#d0142c';

// Film-grain overlay, generated inline — no asset needed.
const GRAIN =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;

function Cloud(props: { top: string; left: string; scale: number; opacity: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: props.top,
        left: props.left,
        width: 220 * props.scale,
        height: 60 * props.scale,
        background: '#eef7f2',
        borderRadius: '50%',
        filter: 'blur(18px)',
        opacity: props.opacity,
        pointerEvents: 'none',
      }}
    />
  );
}

export default function Page() {
  const router = useRouter();
  return (
    <main
      data-lk-theme="default"
      style={{
        position: 'relative',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 8vw',
        background: `linear-gradient(180deg, ${TEAL_TOP} 0%, #3daa9d 45%, ${TEAL_BOTTOM} 100%)`,
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      }}
    >
      {/* clouds */}
      <Cloud top="12%" left="55%" scale={1.6} opacity={0.5} />
      <Cloud top="22%" left="20%" scale={1.1} opacity={0.4} />
      <Cloud top="8%" left="8%" scale={0.8} opacity={0.35} />
      <Cloud top="38%" left="70%" scale={1.3} opacity={0.45} />
      <Cloud top="60%" left="12%" scale={1.5} opacity={0.35} />
      <Cloud top="72%" left="58%" scale={1.0} opacity={0.3} />
      {/* film grain */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: GRAIN,
          mixBlendMode: 'overlay',
          opacity: 0.55,
          pointerEvents: 'none',
        }}
      />

      <div style={{ position: 'relative', maxWidth: 900 }}>
        <h1
          style={{
            margin: 0,
            color: CRIMSON,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            lineHeight: 0.95,
            fontSize: 'clamp(3.5rem, 11vw, 8.5rem)',
            textTransform: 'lowercase',
          }}
        >
          happy
          <br />
          <span style={{ marginLeft: '1.2em' }}>together</span>
        </h1>
        <p
          style={{
            color: '#f4faf7',
            fontSize: 'clamp(1rem, 1.6vw, 1.25rem)',
            maxWidth: 520,
            marginTop: '2rem',
            textShadow: '0 1px 8px rgba(0,0,0,0.12)',
          }}
        >
          Watch videos with your friends, perfectly in sync — everyone plays their own copy,
          nothing gets uploaded.
        </p>
        <button
          onClick={() => router.push(`/rooms/${generateRoomId()}`)}
          style={{
            marginTop: '1.5rem',
            padding: '0.9rem 2.6rem',
            fontSize: '1.2rem',
            fontWeight: 700,
            color: '#fff',
            background: CRIMSON,
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            boxShadow: '0 4px 18px rgba(120, 10, 25, 0.35)',
          }}
        >
          Start a room
        </button>
      </div>
    </main>
  );
}
