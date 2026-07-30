'use client';

import { useRouter } from 'next/navigation';
import React from 'react';
import { generateRoomId } from '@/lib/client-utils';
import styles from '../styles/Home.module.css';

export default function Page() {
  const router = useRouter();
  return (
    <main className={styles.main} data-lk-theme="default">
      <div className="header">
        <h1 style={{ fontSize: '3rem', margin: 0 }}>Happy Together</h1>
        <h2 style={{ fontWeight: 400, opacity: 0.8 }}>
          Watch videos with your friends, perfectly in sync — everyone plays their own copy,
          nothing gets uploaded.
        </h2>
      </div>
      <button
        className="lk-button"
        style={{ fontSize: '1.25rem', padding: '0.85rem 2.5rem' }}
        onClick={() => router.push(`/rooms/${generateRoomId()}`)}
      >
        Start a room
      </button>
    </main>
  );
}
