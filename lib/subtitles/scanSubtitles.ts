'use client';

import { parseIdx, type IdxInfo } from './vobsub';

/**
 * Walks a Matroska file once and pulls out every subtitle track we can show.
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
  idx: IdxInfo;
  compressed: boolean;
  cues: BitmapCue[];
}

export type ScannedTrack = TextSubTrack | BitmapSubTrack;

const SSA_CODECS = /^S_TEXT\/(ASS|SSA)$/i;

function msToVtt(ms: number) {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(
    Math.floor((ms % 60000) / 1000),
  )}.${pad(Math.floor(ms % 1000), 3)}`;
}

function cleanText(text: string) {
  return text
    .replace(/\{[^}]*\}/g, '') // ASS style overrides
    .replace(/\\N/gi, '\n')
    .trim();
}

function cuesToVttUrl(cues: Array<{ start: number; end: number; text: string }>) {
  const body = cues
    .filter((c) => c.text)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`)
    .join('\n\n');
  return URL.createObjectURL(new Blob([`WEBVTT\n\n${body}`], { type: 'text/vtt' }));
}

interface TrackState {
  number: number;
  label: string;
  codecId: string;
  compressed: boolean;
  text?: Array<{ start: number; end: number; text: string }>;
  bitmap?: BitmapCue[];
  idx?: IdxInfo;
}

export async function scanSubtitles(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ScannedTrack[]> {
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
            bitmap: [],
            idx: parseIdx(new Uint8Array(priv)),
          });
        }
        // S_HDMV/PGS and other image formats are not decoded yet.
      }
    }

    const handleBlock = (block: any, blockDuration?: number) => {
      const track = tracks.get(block.track);
      if (!track) return;
      const start = (clusterTimecode + block.value) * timecodeScale * 1000;
      const duration = blockDuration !== undefined ? blockDuration * timecodeScale * 1000 : 3000;
      const payload: Uint8Array = block.payload;

      if (track.bitmap) {
        track.bitmap.push({ start, end: start + duration, data: new Uint8Array(payload) });
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

  const waitForCapacity = () =>
    new Promise<void>((resolve) => {
      const settle = () => {
        decoder.off('drain', settle);
        decoder.off('finish', settle);
        decoder.off('close', settle);
        decoder.off('error', settle);
        resolve();
      };
      decoder.once('drain', settle);
      decoder.once('finish', settle);
      decoder.once('close', settle);
      decoder.once('error', settle);
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
      if (!decoder.write(value)) await waitForCapacity();
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
      out.push({
        kind: 'bitmap',
        label: t.label,
        idx: t.idx,
        compressed: t.compressed,
        cues: t.bitmap,
      });
    }
  }
  return out;
}
