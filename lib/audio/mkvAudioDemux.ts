'use client';

import type { AudioTrackInfo, EncodedAudioFrame } from './types';

// Cluster Timecode + Block relative timecode are in TimecodeScale units
// (default 1,000,000 ns = 1 ms).
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

type EbmlModule = typeof import('ebml-stream');

interface TrackMeta {
  info: AudioTrackInfo;
  /** Frame duration in seconds when the container doesn't say (AAC: 1024 samples). */
  defaultFrameDuration: number;
}

function codecFromMatroska(codecId: string): { codec: AudioTrackInfo['codec']; name: string } {
  if (codecId.startsWith('A_AAC')) return { codec: 'aac', name: 'AAC' };
  if (codecId === 'A_OPUS') return { codec: 'opus', name: 'Opus' };
  // Decoded by the bundled ffmpeg WASM build, not by the browser.
  if (codecId === 'A_AC3') return { codec: 'ac3', name: 'AC3' };
  if (codecId === 'A_EAC3') return { codec: 'eac3', name: 'E-AC3' };
  if (codecId.startsWith('A_DTS')) return { codec: 'dts', name: 'DTS' };
  if (codecId === 'A_TRUEHD' || codecId === 'A_MLP') return { codec: 'truehd', name: 'TrueHD' };
  const known: Record<string, string> = {
    A_VORBIS: 'Vorbis',
    A_FLAC: 'FLAC',
    'A_MPEG/L3': 'MP3',
    'A_MPEG/L2': 'MP2',
  };
  return { codec: null, name: known[codecId] ?? codecId.replace(/^A_/, '') };
}

/** Split a laced block payload into its individual frames. */
function splitLacing(payload: Uint8Array, lacing: number, ebml: EbmlModule): Uint8Array[] {
  const { BlockLacing } = ebml;
  if (lacing === BlockLacing.None) return [payload];

  const frameCount = payload[0] + 1;
  let offset = 1;
  const sizes: number[] = [];

  if (lacing === BlockLacing.Xiph) {
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      let b: number;
      do {
        b = payload[offset++];
        size += b;
      } while (b === 255);
      sizes.push(size);
    }
  } else if (lacing === BlockLacing.EBML) {
    const readVint = (buf: Uint8Array, pos: number) => {
      const first = buf[pos];
      let length = 1;
      let mask = 0x80;
      while (length <= 8 && !(first & mask)) {
        length++;
        mask >>= 1;
      }
      let value = first & (mask - 1);
      for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i];
      return { value, length };
    };
    const first = readVint(payload, offset);
    offset += first.length;
    sizes.push(first.value);
    for (let i = 1; i < frameCount - 1; i++) {
      const v = readVint(payload, offset);
      offset += v.length;
      // Signed: subtract the range midpoint for this VINT length.
      const delta = v.value - (Math.pow(2, 7 * v.length - 1) - 1);
      sizes.push(sizes[sizes.length - 1] + delta);
    }
  } else {
    // Fixed-size lacing: equal frames, no size table.
    const total = payload.length - offset;
    const each = Math.floor(total / frameCount);
    for (let i = 0; i < frameCount - 1; i++) sizes.push(each);
  }

  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    frames.push(payload.subarray(offset, offset + size));
    offset += size;
  }
  frames.push(payload.subarray(offset));
  return frames;
}

/**
 * Stream a Matroska file through the EBML decoder. `onTracks` fires once
 * with every audio track; `onFrame` (when given) receives frames for
 * `wantTrack`. Resolves when the file ends or `signal` aborts.
 */
async function walk(
  file: File,
  opts: {
    wantTrack?: number;
    signal?: AbortSignal;
    backpressure?: () => Promise<void>;
    onTracks: (tracks: TrackMeta[]) => boolean | void; // return false to stop
    onFrame?: (frame: EncodedAudioFrame) => void;
  },
): Promise<void> {
  const ebml = await import('ebml-stream');
  const { EbmlStreamDecoder, EbmlTagId } = ebml;

  const decoder = new EbmlStreamDecoder({
    bufferTagIds: [EbmlTagId.TimecodeScale, EbmlTagId.Tracks, EbmlTagId.BlockGroup],
  });

  let timecodeScale = DEFAULT_TIMECODE_SCALE_NS / 1e9; // seconds per unit
  let clusterTimecode = 0;
  let stop = false;
  const tracks = new Map<number, TrackMeta>();

  const getData = (master: { Children: Array<{ id: number; data?: unknown }> }, id: number) =>
    master.Children.find((c) => c.id === id)?.data;

  const emitFrames = (
    block: { track: number; value: number; payload: Uint8Array; lacing: number },
    blockDuration?: number,
  ) => {
    if (block.track !== opts.wantTrack || !opts.onFrame) return;
    const meta = tracks.get(block.track);
    if (!meta) return;
    const frames = splitLacing(block.payload, block.lacing, ebml);
    const start = (clusterTimecode + block.value) * timecodeScale;
    const perFrame =
      blockDuration !== undefined && frames.length > 0
        ? (blockDuration * timecodeScale) / frames.length
        : meta.defaultFrameDuration;
    frames.forEach((data, i) => {
      opts.onFrame!({ data, timestamp: start + i * perFrame, duration: perFrame });
    });
  };

  decoder.on('data', (chunk: any) => {
    if (stop) return;
    if (chunk.id === EbmlTagId.TimecodeScale) {
      timecodeScale = Number(chunk.data) / 1e9;
    } else if (chunk.id === EbmlTagId.Timecode) {
      clusterTimecode = Number(chunk.data);
    } else if (chunk.id === EbmlTagId.Tracks) {
      for (const entry of chunk.Children.filter((c: any) => c.id === EbmlTagId.TrackEntry)) {
        if (getData(entry, EbmlTagId.TrackType) !== 0x02) continue;
        const codecId = String(getData(entry, EbmlTagId.CodecID) ?? '');
        const { codec, name: codecName } = codecFromMatroska(codecId);
        const audio = entry.Children.find((c: any) => c.id === EbmlTagId.Audio);
        const sampleRate = audio ? Number(getData(audio, EbmlTagId.SamplingFrequency) ?? 48000) : 48000;
        const channels = audio ? Number(getData(audio, EbmlTagId.Channels) ?? 2) : 2;
        const number = Number(getData(entry, EbmlTagId.TrackNumber));
        const name = getData(entry, EbmlTagId.Name) as string | undefined;
        const language = getData(entry, EbmlTagId.Language) as string | undefined;
        const priv = getData(entry, EbmlTagId.CodecPrivate) as Uint8Array | undefined;
        tracks.set(number, {
          info: {
            id: number,
            label: [name, language].filter(Boolean).join(' — ') || `Track ${number}`,
            codec,
            codecName,
            sampleRate,
            channels,
            description: priv ? new Uint8Array(priv) : undefined,
          },
          // AAC frames are 1024 samples; Opus in Matroska is almost always 20 ms.
          defaultFrameDuration: codec === 'opus' ? 0.02 : 1024 / sampleRate,
        });
      }
      if (opts.onTracks(Array.from(tracks.values())) === false) stop = true;
    } else if (chunk.id === EbmlTagId.SimpleBlock) {
      emitFrames(chunk);
    } else if (chunk.id === EbmlTagId.BlockGroup) {
      const block = chunk.Children.find((c: any) => c.id === EbmlTagId.Block);
      if (block) {
        const duration = getData(chunk, EbmlTagId.BlockDuration) as number | undefined;
        emitFrames(block, duration);
      }
    }
  });

  const reader = file.stream().getReader();
  try {
    for (;;) {
      if (stop || opts.signal?.aborted) break;
      await opts.backpressure?.();
      if (stop || opts.signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!decoder.write(value)) {
        await new Promise<void>((r) => decoder.once('drain', () => r()));
      }
    }
  } finally {
    reader.cancel().catch(() => {});
    try {
      decoder.end();
    } catch {
      // The decoder may already be in an errored state on a truncated file.
    }
  }
}

export async function probeMkvAudioTracks(file: File): Promise<AudioTrackInfo[]> {
  let found: AudioTrackInfo[] = [];
  await walk(file, {
    onTracks: (tracks) => {
      found = tracks.map((t) => t.info);
      return false; // header is all we need
    },
  });
  return found;
}

/**
 * Stream frames of one track in file order. Matroska has no random access
 * without parsing Cues, so a seek is served by re-walking from the start
 * and skipping frames before `fromTime`.
 */
export function demuxMkvAudioTrack(
  file: File,
  trackId: number,
  fromTime: number,
  onFrame: (frame: EncodedAudioFrame) => void,
  signal: AbortSignal,
  backpressure?: () => Promise<void>,
): Promise<void> {
  return walk(file, {
    wantTrack: trackId,
    signal,
    backpressure,
    onTracks: () => undefined,
    onFrame: (frame) => {
      if (frame.timestamp + frame.duration >= fromTime) onFrame(frame);
    },
  });
}
