'use client';

import { parseIdx, type IdxInfo } from './vobsub';
import { cuesToVttUrl } from './vtt';

/**
 * Pulls out every subtitle track we can show, from Matroska or MP4.
 *
 * Matroska is walked once, streaming. MP4 only reads its `moov` box and the
 * subtitle samples (see ./mp4Subtitles).
 *
 * Text tracks (SRT/ASS) become WebVTT the <video> element can take directly.
 * Bitmap tracks (VobSub) can't use <track> at all — browsers have no notion
 * of image subtitles — so their packets are kept compressed and decoded to
 * pixels on demand, which also keeps a feature-length film's worth of
 * subtitle bitmaps from sitting in memory.
 */

export interface TextSubTrack {
  kind: 'text';
  label: string;
  vttUrl: string;
}

export interface BitmapCue {
  start: number;
  end: number;
  /** Raw block payload; still zlib-compressed when `compressed` is set. */
  data: Uint8Array;
}

export interface BitmapSubTrack {
  kind: 'bitmap';
  label: string;
  /** VobSub carries its palette in the header; PGS carries one per subtitle. */
  format: 'vobsub' | 'pgs';
  idx: IdxInfo;
  compressed: boolean;
  cues: BitmapCue[];
}

export type ScannedTrack = TextSubTrack | BitmapSubTrack;

const SSA_CODECS = /^S_TEXT\/(ASS|SSA)$/i;

function cleanText(text: string) {
  return text
    .replace(/\{[^}]*\}/g, '') // ASS style overrides
    .replace(/\\N/gi, '\n')
    .trim();
}

interface TrackState {
  number: number;
  label: string;
  codecId: string;
  compressed: boolean;
  format?: 'vobsub' | 'pgs';
  text?: Array<{ start: number; end: number; text: string }>;
  bitmap?: BitmapCue[];
  idx?: IdxInfo;
}

export async function scanSubtitles(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ScannedTrack[]> {
  if (/\.(mp4|m4v|mov)$/i.test(file.name)) {
    const { scanMp4Subtitles } = await import('./mp4Subtitles');
    return scanMp4Subtitles(file, onProgress, signal);
  }
  if (!/\.(mkv|webm)$/i.test(file.name)) return [];
  const { EbmlStreamDecoder, EbmlTagId } = await import('ebml-stream');

  const decoder = new EbmlStreamDecoder({
    bufferTagIds: [EbmlTagId.TimecodeScale, EbmlTagId.Tracks, EbmlTagId.BlockGroup],
  });

  const tracks = new Map<number, TrackState>();
  let timecodeScale = 1e-3; // seconds per timecode unit
  let clusterTimecode = 0;
  let sawTracks = false;
  let closed = false;

  const getData = (master: { Children: Array<{ id: number; data?: unknown }> }, id: number) =>
    master.Children.find((c) => c.id === id)?.data;

  decoder.on('data', (chunk: any) => {
    if (chunk.id === EbmlTagId.TimecodeScale) {
      timecodeScale = Number(chunk.data) / 1e9;
    } else if (chunk.id === EbmlTagId.Timecode) {
      clusterTimecode = Number(chunk.data);
    } else if (chunk.id === EbmlTagId.Tracks) {
      sawTracks = true;
      for (const entry of chunk.Children.filter((c: any) => c.id === EbmlTagId.TrackEntry)) {
        if (getData(entry, EbmlTagId.TrackType) !== 0x11) continue; // subtitles only
        const codecId = String(getData(entry, EbmlTagId.CodecID) ?? '');
        const number = Number(getData(entry, EbmlTagId.TrackNumber));
        const name = getData(entry, EbmlTagId.Name) as string | undefined;
        const language = getData(entry, EbmlTagId.Language) as string | undefined;
        const compressed = !!entry.Children.find(
          (c: any) => c.id === EbmlTagId.ContentEncodings,
        );
        const label = [name, language].filter(Boolean).join(' — ') || `Track ${number}`;

        if (codecId.startsWith('S_TEXT')) {
          tracks.set(number, { number, label, codecId, compressed, text: [] });
        } else if (codecId === 'S_VOBSUB') {
          const priv = getData(entry, EbmlTagId.CodecPrivate) as Uint8Array | undefined;
          if (!priv) continue;
          tracks.set(number, {
            number,
            label,
            codecId,
            compressed,
            format: 'vobsub',
            bitmap: [],
            idx: parseIdx(new Uint8Array(priv)),
          });
        } else if (codecId === 'S_HDMV/PGS') {
          // PGS has no header palette: each display set carries its own, and
          // the authoring size comes from the composition segment.
          tracks.set(number, {
            number,
            label,
            codecId,
            compressed,
            format: 'pgs',
            bitmap: [],
            idx: { palette: [], width: 1920, height: 1080 },
          });
        }
      }
    }

    const handleBlock = (block: any, blockDuration?: number) => {
      const track = tracks.get(block.track);
      if (!track) return;
      const start = (clusterTimecode + block.value) * timecodeScale * 1000;
      const duration = blockDuration !== undefined ? blockDuration * timecodeScale * 1000 : 3000;
      const payload: Uint8Array = block.payload;

      if (track.bitmap) {
        // PGS says nothing about duration: a later display set with no image
        // clears the screen, so each cue runs until the next one begins.
        if (track.format === 'pgs') {
          const previous = track.bitmap[track.bitmap.length - 1];
          if (previous) previous.end = start;
          track.bitmap.push({ start, end: Number.POSITIVE_INFINITY, data: new Uint8Array(payload) });
        } else {
          track.bitmap.push({ start, end: start + duration, data: new Uint8Array(payload) });
        }
        return;
      }
      if (!track.text) return;
      let text = new TextDecoder().decode(payload);
      if (SSA_CODECS.test(track.codecId)) {
        // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
        text = text.split(',').slice(8).join(',');
      }
      track.text.push({ start, end: start + duration, text: cleanText(text) });
    };

    if (chunk.id === EbmlTagId.SimpleBlock) handleBlock(chunk);
    else if (chunk.id === EbmlTagId.BlockGroup) {
      const block = chunk.Children.find((c: any) => c.id === EbmlTagId.Block);
      if (block) handleBlock(block, getData(chunk, EbmlTagId.BlockDuration) as number | undefined);
    }
  });

  const markClosed = () => {
    closed = true;
  };
  decoder.on('finish', markClosed);
  decoder.on('close', markClosed);
  decoder.on('error', markClosed);

  const TERMINAL = ['drain', 'close', 'finish', 'error', 'end'] as const;
  const waitForCapacity = () =>
    new Promise<void>((resolve) => {
      const settle = () => {
        for (const e of TERMINAL) decoder.removeListener(e, settle);
        resolve();
      };
      for (const e of TERMINAL) decoder.once(e, settle);
    });

  const reader = file.stream().getReader();
  try {
    let read = 0;
    for (;;) {
      // Nothing we can render in this file: stop before reading it all.
      if (closed || signal?.aborted || (sawTracks && tracks.size === 0)) break;
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      onProgress?.(read / file.size);
      // Never wait on a parser that has already ended: its terminal events
      // have fired and a fresh listener would hang forever.
      if (!decoder.write(value) && !closed) await waitForCapacity();
    }
  } catch {
    // Keep whatever was collected before the failure.
  } finally {
    reader.cancel().catch(() => {});
    try {
      if (!closed) decoder.end();
    } catch {
      // already ended
    }
  }

  const out: ScannedTrack[] = [];
  for (const t of tracks.values()) {
    if (t.text && t.text.length > 0) {
      out.push({ kind: 'text', label: t.label, vttUrl: cuesToVttUrl(t.text) });
    } else if (t.bitmap && t.bitmap.length > 0 && t.idx) {
      // A trailing PGS cue has no successor to bound it.
      const last = t.bitmap[t.bitmap.length - 1];
      if (last && !Number.isFinite(last.end)) last.end = last.start + 5000;
      out.push({
        kind: 'bitmap',
        label: t.label,
        format: t.format ?? 'vobsub',
        idx: t.idx,
        compressed: t.compressed,
        cues: t.bitmap,
      });
    }
  }
  return out;
}
