'use client';

import React from 'react';
import type { BitmapSubTrack } from './subtitles/scanSubtitles';
import { decodeVobSubPacket } from './subtitles/vobsub';

/**
 * Draws image-based subtitles (VobSub) over the video.
 *
 * The <track> element only understands text, so these are composited onto a
 * canvas laid over the picture. Packets stay compressed until the playhead
 * reaches them — a film's worth of decoded bitmaps would be hundreds of
 * megabytes — and the few most recent are cached as ImageBitmaps.
 */

const CACHE_LIMIT = 24;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Where the picture actually sits inside the element, given object-fit: contain. */
function contentRect(video: HTMLVideoElement) {
  const { videoWidth: vw, videoHeight: vh, clientWidth: cw, clientHeight: ch } = video;
  if (!vw || !vh || !cw || !ch) return null;
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h };
}

export function BitmapSubtitleOverlay(props: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  tracks: BitmapSubTrack[];
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const cache = React.useRef(new Map<string, ImageBitmap | null>());
  const positions = React.useRef(new Map<string, { x: number; y: number }>());
  const pending = React.useRef(new Set<string>());
  const lastKey = React.useRef('');

  // Drop cached bitmaps whenever the selection changes.
  React.useEffect(() => {
    for (const bmp of cache.current.values()) bmp?.close();
    cache.current.clear();
    positions.current.clear();
    pending.current.clear();
    lastKey.current = '';
  }, [props.tracks]);

  React.useEffect(() => {
    const video = props.videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let disposed = false;

    const decodeCue = async (track: BitmapSubTrack, index: number, key: string) => {
      pending.current.add(key);
      try {
        const cue = track.cues[index];
        const raw = track.compressed ? await inflate(cue.data) : cue.data;
        const image = decodeVobSubPacket(raw, track.idx.palette);
        if (!image || disposed) {
          cache.current.set(key, null);
          return;
        }
        const bmp = await createImageBitmap(
          new ImageData(image.rgba, image.width, image.height),
        );
        if (disposed) {
          bmp.close();
          return;
        }
        cache.current.set(key, bmp);
        // Remember where it goes; ImageBitmap carries only pixels.
        positions.current.set(key, { x: image.x, y: image.y });
        if (cache.current.size > CACHE_LIMIT) {
          const oldest = cache.current.keys().next().value as string | undefined;
          if (oldest !== undefined && oldest !== key) {
            cache.current.get(oldest)?.close();
            cache.current.delete(oldest);
            positions.current.delete(oldest);
          }
        }
      } catch {
        cache.current.set(key, null);
      } finally {
        pending.current.delete(key);
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const rect = contentRect(video);
      if (!rect) return;

      canvas.style.left = `${rect.left}px`;
      canvas.style.top = `${rect.top}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;

      const nowMs = video.currentTime * 1000;
      const active: Array<{ track: BitmapSubTrack; index: number; key: string }> = [];
      props.tracks.forEach((track, ti) => {
        const i = track.cues.findIndex((c) => nowMs >= c.start && nowMs < c.end);
        if (i >= 0) active.push({ track, index: i, key: `${ti}:${i}` });
      });

      const key = active.map((a) => a.key).join('|');
      // The canvas only changes when the set of showing cues changes.
      const ready = active.every((a) => cache.current.has(a.key));
      if (key === lastKey.current && ready) return;

      for (const a of active) {
        if (!cache.current.has(a.key) && !pending.current.has(a.key)) {
          void decodeCue(a.track, a.index, a.key);
        }
      }
      if (!ready) return;

      const space = props.tracks[0]?.idx ?? { width: 1920, height: 1080 };
      if (canvas.width !== space.width || canvas.height !== space.height) {
        canvas.width = space.width;
        canvas.height = space.height;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const a of active) {
        const bmp = cache.current.get(a.key);
        const pos = positions.current.get(a.key);
        if (bmp && pos) ctx.drawImage(bmp, pos.x, pos.y);
      }
      lastKey.current = key;
    };

    raf = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, [props.tracks, props.videoRef]);

  if (props.tracks.length === 0) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: 'absolute', pointerEvents: 'none', zIndex: 2 }}
    />
  );
}
