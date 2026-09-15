'use client';

import React from 'react';
import type { AudioTrackInfo } from './audio/types';
import { containerOf } from './audio/types';
import { AudioTrackEngine, type EngineStatus } from './audio/AudioTrackEngine';

/**
 * Pick which embedded audio track plays. The first track is what the browser
 * decodes natively; any other is played by AudioTrackEngine over the muted
 * element. Exactly one track at a time — two dubs at once is just noise.
 */
export function AudioTrackSelector(props: {
  file: File | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const [tracks, setTracks] = React.useState<AudioTrackInfo[]>([]);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<{ s: EngineStatus; detail?: string }>({
    s: 'stopped',
  });
  const engine = React.useRef<AudioTrackEngine | null>(null);

  const container = props.file ? containerOf(props.file.name) : null;

  // New file: tear down, re-probe.
  React.useEffect(() => {
    engine.current?.stop();
    engine.current = null;
    setTracks([]);
    setSelected(null);
    setStatus({ s: 'stopped' });
    const file = props.file;
    if (!file || !container) return;

    let cancelled = false;
    const probe =
      container === 'mp4'
        ? import('./audio/mp4AudioDemux').then((m) => m.probeMp4AudioTracks(file))
        : import('./audio/mkvAudioDemux').then((m) => m.probeMkvAudioTracks(file));
    probe
      .then((found) => {
        if (cancelled) return;
        setTracks(found);
        setSelected(found[0]?.id ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      engine.current?.stop();
      engine.current = null;
    };
  }, [props.file, container]);

  const choose = (track: AudioTrackInfo) => {
    const video = props.videoRef.current;
    if (!video || !props.file || !container || track.id === selected) return;
    setSelected(track.id);
    if (!engine.current) {
      engine.current = new AudioTrackEngine(video, (s, detail) => setStatus({ s, detail }));
      if (process.env.NODE_ENV === 'development') {
        (window as unknown as { __audioEngine?: AudioTrackEngine }).__audioEngine = engine.current;
      }
    }
    if (track.id === tracks[0].id) {
      engine.current.stop();
    } else {
      engine.current.start(props.file, container, track);
    }
  };

  if (tracks.length < 2) return null;

  const statusLine =
    status.s === 'starting'
      ? 'switching…'
      : status.s === 'error'
        ? `couldn't play: ${status.detail ?? 'unknown error'}`
        : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'none',
          border: 'none',
          color: '#fff',
          cursor: 'pointer',
          padding: 0,
          fontSize: 12,
          textAlign: 'left',
        }}
      >
        {open ? '▾' : '▸'} audio ({tracks.length} tracks)
      </button>
      {open &&
        tracks.map((track, i) => {
          const disabled = !track.codec;
          return (
            <label
              key={track.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontSize: 12,
                lineHeight: 1,
                opacity: disabled ? 0.5 : 1,
              }}
              title={disabled ? `${track.codecName} can't be decoded by this browser` : undefined}
            >
              {/* Radio, not checkbox: only one audio track plays at a time. */}
              <input
                type="radio"
                name="ht-audio-track"
                checked={selected === track.id}
                disabled={disabled}
                onChange={() => choose(track)}
                style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
              />
              <span>
                {track.label}
                {i === 0 ? ' (original)' : ''}
                {disabled ? ` — ${track.codecName}, not playable` : ''}
              </span>
            </label>
          );
        })}
      {open && statusLine && <span style={{ fontSize: 12, opacity: 0.7 }}>{statusLine}</span>}
    </div>
  );
}
