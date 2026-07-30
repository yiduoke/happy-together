'use client';

import { useRouter } from 'next/navigation';
import React from 'react';
import { generateRoomId } from '@/lib/client-utils';

// Sampled from the poster's title lettering.
const POSTER_RED = '#a60f26';

export default function Page() {
  const router = useRouter();
  return (
    <main
      data-lk-theme="default"
      style={{
        position: 'relative',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      }}
    >
      <h1
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        happy together
      </h1>
      <img
        src="/background-images/happy-together-poster.png"
        alt=""
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
      <div
        style={{
          position: 'absolute',
          top: '13vw',
          right: '8vw',
          width: 'min(420px, 32vw)',
          textAlign: 'right',
        }}
      >
        <p
          style={{
            color: '#f4faf7',
            fontSize: 'clamp(1rem, 1.6vw, 1.35rem)',
            lineHeight: 1.55,
            margin: 0,
            textShadow: '0 1px 10px rgba(0,0,0,0.2)',
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
            background: POSTER_RED,
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            boxShadow: '0 4px 18px rgba(90, 8, 20, 0.35)',
          }}
        >
          Start a room
        </button>
      </div>
    </main>
  );
}
