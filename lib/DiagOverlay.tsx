'use client';

import React from 'react';

/**
 * Dev-only (?diag=1) on-screen playback diagnostics, readable from a
 * screenshot — the only way to "observe" browsers we can't script (Firefox).
 * The audio probe taps captureStream() into an AnalyserNode: with a
 * constant-tone test file, RMS should hold steady and dropouts stay 0;
 * clicky/gappy audio shows up as a climbing dropout count.
 */
export function DiagOverlay(props: { videoRef: React.RefObject<HTMLVideoElement> }) {
  const [stats, setStats] = React.useState<Record<string, string>>({});
  const probe = React.useRef<{
    analyser: AnalyserNode;
    buf: Float32Array;
    dropouts: number;
    wasSilent: boolean;
  } | null>(null);

  React.useEffect(() => {
    const interval = setInterval(() => {
      const video = props.videoRef.current;
      if (!video) return;

      // Attach the audio probe once the video has a source.
      if (!probe.current && video.readyState >= 2) {
        try {
          const stream: MediaStream =
            // @ts-expect-error captureStream is not in the TS DOM lib for video
            (video.captureStream ?? video.mozCaptureStream)?.call(video);
          if (stream && stream.getAudioTracks().length > 0) {
            const ctx = new AudioContext();
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            src.connect(analyser);
            probe.current = {
              analyser,
              buf: new Float32Array(analyser.fftSize),
              dropouts: 0,
              wasSilent: false,
            };
          }
        } catch {
          // Probe is best-effort; stats still show decode counters.
        }
      }

      let rms = NaN;
      if (probe.current) {
        probe.current.analyser.getFloatTimeDomainData(probe.current.buf);
        let sum = 0;
        for (const v of probe.current.buf) sum += v * v;
        rms = Math.sqrt(sum / probe.current.buf.length);
        // A silence onset while the clip is mid-play = a dropout/click.
        const silent = rms < 0.005;
        if (silent && !probe.current.wasSilent && !video.paused && !video.ended) {
          probe.current.dropouts += 1;
        }
        probe.current.wasSilent = silent;
      }

      const q = video.getVideoPlaybackQuality?.();
      setStats({
        t: video.currentTime.toFixed(2),
        state: video.error
          ? `ERROR ${video.error.code}`
          : video.paused
            ? 'paused'
            : `playing @${video.playbackRate.toFixed(2)}x`,
        ready: String(video.readyState),
        'dropped/total frames': q ? `${q.droppedVideoFrames}/${q.totalVideoFrames}` : 'n/a',
        'audio rms': Number.isNaN(rms) ? 'no probe' : rms.toFixed(4),
        'audio dropouts': probe.current ? String(probe.current.dropouts) : 'n/a',
      });
    }, 500);
    return () => clearInterval(interval);
  }, [props.videoRef]);

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 60,
        left: 8,
        background: 'rgba(0,0,0,0.8)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: 14,
        padding: 8,
        borderRadius: 4,
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      {Object.entries(stats).map(([k, v]) => (
        <div key={k}>
          {k}: {v}
        </div>
      ))}
    </div>
  );
}
