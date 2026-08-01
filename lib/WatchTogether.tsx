'use client';

import React from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, RemoteParticipant } from 'livekit-client';
import { extractEmbeddedSubs } from './extractEmbeddedSubs';

const SYNC_TOPIC = 'watch-sync';

// Browsers don't demux subtitle tracks embedded in local MP4/MKV files, so
// tracks arrive as sidecar .srt/.vtt files added as <track> elements.
function srtToVtt(srt: string) {
  return (
    'WEBVTT\n\n' +
    srt.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  );
}

function SubtitleSelector(props: { videoRef: React.RefObject<HTMLVideoElement> }) {
  const [tracks, setTracks] = React.useState<Array<{ index: number; label: string }>>([]);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  const onSubtitleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = props.videoRef.current;
    const files = e.target.files;
    if (!video || !files) return;
    for (const file of Array.from(files)) {
      const text = await file.text();
      const vtt = file.name.toLowerCase().endsWith('.vtt') ? text : srtToVtt(text);
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = file.name.replace(/\.(srt|vtt)$/i, '');
      track.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      video.appendChild(track);
      track.track.mode = 'disabled';
    }
    e.target.value = '';
  };

  React.useEffect(() => {
    const video = props.videoRef.current;
    if (!video) return;
    const list = video.textTracks;
    const updateTracks = () => {
      setTracks(
        Array.from(list).map((track, i) => ({
          index: i,
          label: track.label || [track.language, `Subtitle ${i + 1}`].filter(Boolean).join(' — '),
        })),
      );
    };
    const reset = () => {
      setSelected(new Set());
      updateTracks();
    };
    updateTracks();
    list.addEventListener('addtrack', updateTracks);
    list.addEventListener('removetrack', updateTracks);
    video.addEventListener('loadedmetadata', reset);
    return () => {
      list.removeEventListener('addtrack', updateTracks);
      list.removeEventListener('removetrack', updateTracks);
      video.removeEventListener('loadedmetadata', reset);
    };
  }, [props.videoRef]);

  const toggle = (index: number) => {
    const video = props.videoRef.current;
    const track = video?.textTracks[index];
    if (!track) return;
    const next = new Set(selected);
    if (next.has(index)) {
      next.delete(index);
      track.mode = 'disabled';
    } else {
      next.add(index);
      track.mode = 'showing';
    }
    setSelected(next);
  };

  const [open, setOpen] = React.useState(false);

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
        {open ? '▾' : '▸'} subtitles{selected.size > 0 ? ` (${selected.size} on)` : ''}
      </button>
      {open && tracks.map((track) => (
        <label
          key={track.index}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          <input
            type="checkbox"
            checked={selected.has(track.index)}
            onChange={() => toggle(track.index)}
            style={{ cursor: 'pointer' }}
          />
          <span>{track.label}</span>
        </label>
      ))}
      {open && (
        <label style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: 12 }}>
          add subtitles (.srt / .vtt)
          <input type="file" accept=".srt,.vtt" multiple onChange={onSubtitleFiles} hidden />
        </label>
      )}
    </div>
  );
}
const TICK_INTERVAL_MS = 2000;
// Drift thresholds (seconds)
const HARD_SEEK_THRESHOLD = 3;
const NUDGE_THRESHOLD = 0.3;

type SyncMsg =
  | { t: 'play'; time: number }
  | { t: 'pause'; time: number }
  | { t: 'seek'; time: number }
  | { t: 'tick'; time: number; paused: boolean }
  | { t: 'hello' }
  | { t: 'state'; time: number; paused: boolean };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Main watch stage: each participant loads their OWN local copy of the video.
 * Nothing is uploaded — only playback state syncs over LiveKit data messages.
 *
 * Sync model (based on watchparty/Syncplay):
 * - play/pause/seek: any participant's action broadcasts; last writer wins.
 * - drift: everyone broadcasts a `tick` while playing; a receiver only
 *   corrects toward ticks from participants whose identity sorts before its
 *   own, so exactly one participant acts as the clock master.
 * - corrections under HARD_SEEK_THRESHOLD use playbackRate nudging so the
 *   viewer never sees a jump.
 */
export function WatchTogether() {
  const room = useRoomContext();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  // Applying a remote action fires the same video events as a local user
  // action would. Each programmatic apply registers an expectation; the
  // matching event consumes it instead of re-broadcasting. Unlike a time
  // window, this never swallows a genuine user action that lands nearby.
  const expected = React.useRef({ play: 0, pause: 0, seek: 0 });

  const send = React.useCallback(
    (msg: SyncMsg, reliable = true) => {
      room.localParticipant
        .publishData(encoder.encode(JSON.stringify(msg)), { reliable, topic: SYNC_TOPIC })
        .catch(() => {});
    },
    [room],
  );

  // Consume one expected echo of `kind`; returns true if this event was
  // caused by a remote apply and must not re-broadcast.
  const consumeExpected = (kind: 'play' | 'pause' | 'seek') => {
    if (expected.current[kind] > 0) {
      expected.current[kind] -= 1;
      return true;
    }
    return false;
  };

  const applySeek = (video: HTMLVideoElement, time: number) => {
    expected.current.seek += 1;
    video.currentTime = time;
  };
  const applyPlay = (video: HTMLVideoElement) => {
    if (!video.paused) return;
    expected.current.play += 1;
    video.play().catch(() => {
      expected.current.play = Math.max(0, expected.current.play - 1);
    });
  };
  const applyPause = (video: HTMLVideoElement) => {
    if (video.paused) return;
    expected.current.pause += 1;
    video.pause();
  };

  // Receive sync messages
  React.useEffect(() => {
    const onData = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (topic !== SYNC_TOPIC || !participant) {
        return;
      }
      let msg: SyncMsg;
      try {
        msg = JSON.parse(decoder.decode(payload));
      } catch {
        return;
      }
      const video = videoRef.current;
      switch (msg.t) {
        case 'play':
          if (!video) return;
          if (Math.abs(video.currentTime - msg.time) > NUDGE_THRESHOLD) {
            applySeek(video, msg.time);
          }
          applyPlay(video);
          break;
        case 'pause':
          if (!video) return;
          applyPause(video);
          applySeek(video, msg.time);
          break;
        case 'seek':
          if (!video) return;
          applySeek(video, msg.time);
          break;
        case 'tick': {
          if (!video || video.paused || msg.paused) return;
          // Only correct toward the deterministic clock master.
          if (participant.identity >= room.localParticipant.identity) return;
          const delta = msg.time - video.currentTime;
          if (Math.abs(delta) > HARD_SEEK_THRESHOLD) {
            applySeek(video, msg.time);
            video.playbackRate = 1;
          } else if (Math.abs(delta) > NUDGE_THRESHOLD) {
            // 0.01x per 100ms of drift, clamped — imperceptible correction.
            video.playbackRate = Math.min(Math.max(1 + delta / 10, 0.9), 1.1);
          } else {
            video.playbackRate = 1;
          }
          break;
        }
        case 'hello':
          // A participant (re)loaded their file; share our state if we have one.
          if (video && videoRef.current?.src) {
            send({ t: 'state', time: video.currentTime, paused: video.paused });
          }
          break;
        case 'state':
          if (!video) return;
          applySeek(video, msg.time);
          if (msg.paused) {
            applyPause(video);
          } else {
            applyPlay(video);
          }
          break;
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, send]);

  // Broadcast a position tick while playing (lossy — fine to drop).
  React.useEffect(() => {
    if (!objectUrl) return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.paused) return;
      send({ t: 'tick', time: video.currentTime, paused: video.paused }, false);
    }, TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [objectUrl, send]);

  React.useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const [subScanPct, setSubScanPct] = React.useState<number | null>(null);
  // Bumped on every file change so a stale extraction can't attach its tracks.
  const fileGeneration = React.useRef(0);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    // Drop tracks that belonged to the previous file.
    videoRef.current?.querySelectorAll('track').forEach((el) => {
      URL.revokeObjectURL(el.src);
      el.remove();
    });
    setObjectUrl(URL.createObjectURL(file));
    setFileName(file.name);
    // Ask peers where they are so we join in sync.
    send({ t: 'hello' });

    // Dig embedded subtitle tracks out of the container (MKV/WebM).
    const generation = ++fileGeneration.current;
    setSubScanPct(null);
    extractEmbeddedSubs(file, (fraction) => {
      if (fileGeneration.current !== generation) return;
      setSubScanPct((prev) => {
        const pct = Math.round(fraction * 100);
        return pct === prev ? prev : pct;
      });
    })
      .then((tracks) => {
        if (fileGeneration.current !== generation) return;
        setSubScanPct(null);
        const video = videoRef.current;
        if (!video) return;
        for (const t of tracks) {
          const el = document.createElement('track');
          el.kind = 'subtitles';
          el.label = t.label;
          el.src = t.vttUrl;
          video.appendChild(el);
          el.track.mode = 'disabled';
        }
      })
      .catch(() => {
        if (fileGeneration.current === generation) setSubScanPct(null);
      });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#000',
        position: 'relative',
      }}
    >
      {objectUrl ? (
        <>
          <video
            ref={videoRef}
            src={objectUrl}
            controls
            playsInline
            style={{ flex: 1, minHeight: 0, width: '100%', objectFit: 'contain' }}
            onPlay={() => {
              const video = videoRef.current;
              if (video && !consumeExpected('play')) send({ t: 'play', time: video.currentTime });
            }}
            onPause={() => {
              const video = videoRef.current;
              if (!video || consumeExpected('pause')) return;
              // Reaching the end pauses naturally — each side ends on its own;
              // broadcasting it would stomp a peer who just sought elsewhere.
              if (video.ended || video.seeking) return;
              send({ t: 'pause', time: video.currentTime });
            }}
            onSeeked={() => {
              const video = videoRef.current;
              if (video && !consumeExpected('seek')) send({ t: 'seek', time: video.currentTime });
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: 'rgba(0,0,0,0.6)',
              borderRadius: 6,
              padding: '8px',
              fontSize: 13,
              color: '#fff',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{fileName}</span>
              <label style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                change
                <input type="file" accept="video/*,.mkv" onChange={onFileChange} hidden />
              </label>
            </div>
            {subScanPct !== null && (
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                scanning embedded subtitles… {subScanPct}%
              </span>
            )}
            <SubtitleSelector videoRef={videoRef} />
          </div>
        </>
      ) : (
        <div
          style={{
            flex: 1,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            textAlign: 'center',
            padding: 24,
          }}
        >
          <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Load your copy of the video</h2>
            <p style={{ margin: 0, opacity: 0.7, maxWidth: 420 }}>
              Everyone opens their own local file — nothing is uploaded. Playback stays in sync
              automatically.
            </p>
            <label className="lk-button" style={{ cursor: 'pointer' }}>
              Choose video file
              <input type="file" accept="video/*,.mkv" onChange={onFileChange} hidden />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
