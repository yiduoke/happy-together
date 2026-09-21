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

// Samples per compressed frame, by codec. Getting this wrong skews every
// timestamp we hand the engine: AC3/E-AC3 frames are 1536 samples, so calling
// them 1024 made each one look 10.7 ms shorter than it really is.
function frameDuration(codec: AudioTrackInfo['codec'], sampleRate: number): number {
  switch (codec) {
    case 'opus':
      return 0.02;
    case 'ac3':
    case 'eac3':
      return 1536 / sampleRate;
    case 'dts':
      return 512 / sampleRate;
    default:
      return 1024 / sampleRate;
  }
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


// --- seeking ---------------------------------------------------------------

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const TIMECODE_ID = 0xe7;

/** Read an EBML variable-length integer; returns its value and byte length. */
function readVint(buf: Uint8Array, pos: number): { value: number; length: number } | null {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (pos + length > buf.length) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i];
  return { value, length };
}

/**
 * Find a Cluster start inside `buf` and read its Timecode, which is the
 * cluster's position in the film. Returns the offset within buf and the time.
 */
function clusterAt(buf: Uint8Array, timecodeScale: number) {
  for (let i = 0; i + 16 < buf.length; i++) {
    if (
      buf[i] !== CLUSTER_ID[0] ||
      buf[i + 1] !== CLUSTER_ID[1] ||
      buf[i + 2] !== CLUSTER_ID[2] ||
      buf[i + 3] !== CLUSTER_ID[3]
    ) {
      continue;
    }
    const size = readVint(buf, i + 4);
    if (!size) continue;
    // A Cluster's first child is normally its Timecode.
    let p = i + 4 + size.length;
    if (buf[p] !== TIMECODE_ID) continue;
    const tcSize = readVint(buf, p + 1);
    if (!tcSize) continue;
    p += 1 + tcSize.length;
    let tc = 0;
    for (let k = 0; k < tcSize.value && p + k < buf.length; k++) tc = tc * 256 + buf[p + k];
    return { offset: i, time: tc * timecodeScale };
  }
  return null;
}

/**
 * Byte offset of the last cluster starting at or before `target`.
 *
 * Matroska has no index we can rely on, so this binary-searches the file:
 * read a window, find a cluster, read its timestamp, and narrow. Without it,
 * playing from an hour in means reading the preceding gigabyte first — slow
 * enough that the playhead outruns the demuxer and it never catches up.
 */
async function findClusterOffset(
  file: File,
  target: number,
  timecodeScale: number,
  signal?: AbortSignal,
): Promise<number> {
  if (target <= 0) return 0;
  const WINDOW = 512 * 1024;

  // A window can land inside a large cluster's payload and contain no header
  // at all, so always scan forward for the next real cluster rather than
  // assuming the target lies earlier.
  const nextClusterFrom = async (from: number) => {
    let pos = Math.max(0, from);
    for (let tries = 0; tries < 64 && pos < file.size; tries++) {
      if (signal?.aborted) return null;
      const buf = new Uint8Array(await file.slice(pos, pos + WINDOW).arrayBuffer());
      if (buf.length === 0) return null;
      const found = clusterAt(buf, timecodeScale);
      if (found) return { at: pos + found.offset, time: found.time };
      pos += WINDOW - 64; // overlap so a header can't be split across reads
    }
    return null;
  };

  let lo = 0;
  let hi = file.size;
  let best = 0;
  for (let step = 0; step < 32 && lo < hi; step++) {
    if (signal?.aborted) return best;
    const mid = Math.floor((lo + hi) / 2);
    const found = await nextClusterFrom(mid);
    if (!found || found.time > target) {
      hi = mid;
    } else {
      best = found.at;
      // Nothing before this can be a better answer.
      if (found.at + 1 <= lo) break;
      lo = found.at + 1;
    }
    if (hi - lo < WINDOW) break;
  }
  return best;
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
    /** Begin reading here instead of at the start of the file. */
    startByte?: number;
    /** Header values, when starting mid-file where the header isn't present. */
    seed?: { timecodeScale: number; tracks: Map<number, TrackMeta> };
    captureHeader?: (h: { timecodeScale: number; tracks: Map<number, TrackMeta> }) => void;
  },
): Promise<void> {
  const ebml = await import('ebml-stream');
  const { EbmlStreamDecoder, EbmlTagId } = ebml;

  const decoder = new EbmlStreamDecoder({
    bufferTagIds: [EbmlTagId.TimecodeScale, EbmlTagId.Tracks, EbmlTagId.BlockGroup],
  });

  let timecodeScale = opts.seed?.timecodeScale ?? DEFAULT_TIMECODE_SCALE_NS / 1e9;
  let clusterTimecode = 0;
  let stop = false;
  const tracks = opts.seed ? opts.seed.tracks : new Map<number, TrackMeta>();

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
          defaultFrameDuration: frameDuration(codec, sampleRate),
        });
      }
      opts.captureHeader?.({ timecodeScale, tracks });
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

  const reader = (opts.startByte ? file.slice(opts.startByte) : file).stream().getReader();
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
export async function demuxMkvAudioTrack(
  file: File,
  trackId: number,
  fromTime: number,
  onFrame: (frame: EncodedAudioFrame) => void,
  signal: AbortSignal,
  backpressure?: () => Promise<void>,
): Promise<void> {
  // Read the header first: it carries the track list and timecode scale, and
  // it is only at the start of the file.
  let header: { timecodeScale: number; tracks: Map<number, TrackMeta> } | null = null;
  await walk(file, {
    signal,
    onTracks: () => false, // stop as soon as the header is parsed
    captureHeader: (h) => {
      header = h;
    },
  });
  if (signal.aborted || !header) return;
  const seed = header as { timecodeScale: number; tracks: Map<number, TrackMeta> };

  // Jump straight to the right part of the file. Scanning to it instead means
  // reading everything before it, which at an hour in is over a gigabyte.
  const startByte = await findClusterOffset(file, fromTime, seed.timecodeScale, signal);
  if (signal.aborted) return;

  return walk(file, {
    wantTrack: trackId,
    signal,
    backpressure,
    startByte,
    seed,
    onTracks: () => undefined,
    onFrame: (frame) => {
      if (frame.timestamp + frame.duration >= fromTime) onFrame(frame);
    },
  });
}
