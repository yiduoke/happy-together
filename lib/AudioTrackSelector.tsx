'use client';

import React from 'react';
import type { AudioTrackInfo } from './audio/types';
import { containerOf } from './audio/types';
import { AudioTrackEngine, type EngineStatus } from './audio/AudioTrackEngine';
import { needsWasm } from './audio/wasmDecoder';

/**
 * Pick which embedded audio track plays. The first track is what the browser
 * decodes natively; any other is played by AudioTrackEngine over the muted
 * element. Exactly one track at a time — two dubs at once is just noise.
 */
/**
 * Which track the <video> element plays on its own: the first one whose codec
 * the browser can actually decode. A rip whose main track is E-AC3 silently
 * falls through to, say, an AAC commentary — so defaulting the UI to track 0
 * would claim one thing while the viewer hears another.
 */
function nativelyPlaying(tracks: AudioTrackInfo[]): number | null {
  const native = tracks.find((t) => t.codec && !needsWasm(t.codec));
  return native?.id ?? null;
}

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
        setSelected(nativelyPlaying(found));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      engine.current?.stop();
      engine.current = null;
    };
  }, [props.file, container]);

  const nativeId = nativelyPlaying(tracks);

  const choose = (track: AudioTrackInfo) => {
    const video = props.videoRef.current;
    if (!video || !props.file || !container || !track.codec) return;
    setSelected(track.id);
    if (!engine.current) {
      engine.current = new AudioTrackEngine(video, (s, detail) => setStatus({ s, detail }));
      if (process.env.NODE_ENV === 'development') {
        (window as unknown as { __audioEngine?: AudioTrackEngine }).__audioEngine = engine.current;
      }
    }
    // Picking the track the element already decodes just means getting out of
    // the way; anything else we have to play ourselves.
    if (track.id === nativeId) {
      engine.current.stop();
    } else {
      engine.current.start(props.file, container, track);
    }
  };

  // A single track still needs the picker when only our bundled decoder can
  // play it — otherwise the viewer gets silence with no way to turn it on.
  const anyNeedsDecoder = tracks.some((t) => t.codec && needsWasm(t.codec));
  if (tracks.length < 2 && !anyNeedsDecoder) return null;

  // Nothing plays natively at all (every track is a codec browsers refuse).
  const nothingPlays = nativeId === null && status.s === 'stopped';

  const statusLine = nothingPlays
    ? 'no track your browser can play — pick one to decode it here'
    : status.s === 'loading-decoder'
      ? 'loading decoder (one-time, ~31 MB)…'
      : status.s === 'starting'
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
        {open ? '▾' : '▸'} audio ({tracks.length} track{tracks.length === 1 ? '' : 's'})
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
              title={
                disabled
                  ? `${track.codecName} can't be decoded by anything we can ship`
                  : needsWasm(track.codec!)
                    ? `${track.codecName}: decoded by the bundled ffmpeg build`
                    : undefined
              }
            >
              {/* Radio, not checkbox: only one audio track plays at a time. */}
              <input
                type="radio"
                name="ht-audio-track"
                checked={selected === track.id}
                disabled={disabled}
                onChange={() => choose(track)}
                onClick={() => choose(track)}
                style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
              />
              <span>
                {track.label}
                {track.id === nativeId ? ' (browser default)' : ''}
                {disabled ? ` — ${track.codecName}, not playable` : ''}
                {!disabled && needsWasm(track.codec!) ? ` — ${track.codecName}` : ''}
              </span>
            </label>
          );
        })}
      {open && statusLine && <span style={{ fontSize: 12, opacity: 0.7 }}>{statusLine}</span>}
    </div>
  );
}
