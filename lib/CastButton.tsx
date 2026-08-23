'use client';

import React from 'react';

/**
 * Send the movie to a TV via the Remote Playback API (Chromecast in Chrome
 * and Edge, AirPlay in Safari). The browser owns the device picker, so no
 * vendor SDK is involved.
 *
 * The Cast *sender* SDK can't be used here: it hands the receiver a URL to
 * fetch, and our video is a blob: URL that only exists inside this browser.
 * Remote Playback has no such requirement — for a local source the browser
 * streams the decoded media itself.
 *
 * Playback stays driven by the same <video> element while remote, so the
 * room's play/pause/seek sync keeps working.
 */
export function CastButton(props: { videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const [available, setAvailable] = React.useState(false);
  const [state, setState] = React.useState<'disconnected' | 'connecting' | 'connected'>(
    'disconnected',
  );

  React.useEffect(() => {
    const video = props.videoRef.current;
    const remote = video?.remote;
    if (!video || !remote) return;

    let watchId: number | undefined;
    let cancelled = false;
    remote
      .watchAvailability((isAvailable) => setAvailable(isAvailable))
      .then((id) => {
        if (cancelled) {
          remote.cancelWatchAvailability(id).catch(() => {});
        } else {
          watchId = id;
        }
      })
      // Availability monitoring is unsupported on some platforms; the button
      // simply stays hidden there.
      .catch(() => {});

    const onConnecting = () => setState('connecting');
    const onConnect = () => setState('connected');
    const onDisconnect = () => setState('disconnected');
    remote.addEventListener('connecting', onConnecting);
    remote.addEventListener('connect', onConnect);
    remote.addEventListener('disconnect', onDisconnect);

    return () => {
      cancelled = true;
      if (watchId !== undefined) remote.cancelWatchAvailability(watchId).catch(() => {});
      remote.removeEventListener('connecting', onConnecting);
      remote.removeEventListener('connect', onConnect);
      remote.removeEventListener('disconnect', onDisconnect);
    };
  }, [props.videoRef]);

  if (!available && state === 'disconnected') return null;

  const label =
    state === 'connected' ? 'casting — tap to stop' : state === 'connecting' ? 'connecting…' : 'cast to TV';

  return (
    <button
      onClick={() => props.videoRef.current?.remote?.prompt().catch(() => {})}
      style={{
        background: 'none',
        border: 'none',
        color: state === 'connected' ? '#7ee2c0' : '#fff',
        cursor: 'pointer',
        padding: 0,
        fontSize: 12,
        textAlign: 'left',
      }}
    >
      ⧉ {label}
    </button>
  );
}
