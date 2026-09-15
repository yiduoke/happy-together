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

  // The element decodes the first track by itself — unless its codec is one
  // browsers refuse, in which case even "original" has to go through us.
  const needsEngine = (track: AudioTrackInfo) =>
    track.id !== tracks[0]?.id || (!!track.codec && needsWasm(track.codec));

  const choose = (track: AudioTrackInfo) => {
    const video = props.videoRef.current;
    if (!video || !props.file || !container || !track.codec) return;
    // Re-picking the already-selected track is a retry, not a no-op: it is how
    // you start the decoder for a first track that needs one.
    if (track.id === selected && status.s !== 'stopped') return;
    setSelected(track.id);
    if (!engine.current) {
      engine.current = new AudioTrackEngine(video, (s, detail) => setStatus({ s, detail }));
      if (process.env.NODE_ENV === 'development') {
        (window as unknown as { __audioEngine?: AudioTrackEngine }).__audioEngine = engine.current;
      }
    }
    if (needsEngine(track)) {
      engine.current.start(props.file, container, track);
    } else {
      engine.current.stop();
    }
  };

  // A single track still needs the picker when only our bundled decoder can
  // play it — otherwise the viewer gets silence with no way to turn it on.
  const anyNeedsDecoder = tracks.some((t) => t.codec && needsWasm(t.codec));
  if (tracks.length < 2 && !anyNeedsDecoder) return null;

  const selectedTrack = tracks.find((t) => t.id === selected);
  const needsClickToStart =
    status.s === 'stopped' && !!selectedTrack?.codec && needsWasm(selectedTrack.codec);

  const statusLine = needsClickToStart
    ? `${selectedTrack!.codecName} needs the bundled decoder — click it to enable sound`
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
                {i === 0 ? ' (original)' : ''}
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
