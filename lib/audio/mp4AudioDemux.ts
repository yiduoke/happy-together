'use client';

import type { AudioTrackInfo, EncodedAudioFrame } from './types';

// Read granularity while extracting. Backpressure is checked between chunks,
// so this also bounds how far the compressed-frame queue can overshoot.
const CHUNK_SIZE = 1024 * 1024;

function codecFromMp4(codec: string): { codec: AudioTrackInfo['codec']; name: string } {
  if (codec.startsWith('mp4a.40')) return { codec: 'aac', name: 'AAC' };
  if (codec.toLowerCase().startsWith('opus')) return { codec: 'opus', name: 'Opus' };
  const known: Record<string, string> = {
    'ac-3': 'AC3',
    'ec-3': 'E-AC3',
    'mp4a.6b': 'MP3',
    'mp4a.69': 'MP3',
    alac: 'ALAC',
    flac: 'FLAC',
    dtsc: 'DTS',
  };
  return { codec: null, name: known[codec] ?? codec };
}

interface Box {
  type: string;
  start: number;
  size: number;
}

/** Top-level box map, so we can feed the header without reading the mdat. */
async function scanBoxes(file: File): Promise<Box[]> {
  const boxes: Box[] = [];
  let offset = 0;
  while (offset + 8 <= file.size) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(
      head.getUint8(4),
      head.getUint8(5),
      head.getUint8(6),
      head.getUint8(7),
    );
    if (size === 1 && head.byteLength >= 16) {
      size = Number(head.getBigUint64(8));
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < 8) break;
    boxes.push({ type, start: offset, size });
    offset += size;
  }
  return boxes;
}

async function append(
  file: File,
  mp4: import('mp4box').MP4File,
  start: number,
  end: number,
  opts: { signal?: AbortSignal; backpressure?: () => Promise<void> } = {},
): Promise<void> {
  let offset = start;
  while (offset < end) {
    if (opts.signal?.aborted) return;
    await opts.backpressure?.();
    if (opts.signal?.aborted) return;
    const slice = await file.slice(offset, Math.min(end, offset + CHUNK_SIZE)).arrayBuffer();
    const buf = slice as ArrayBuffer & { fileStart: number };
    buf.fileStart = offset;
    mp4.appendBuffer(buf);
    offset += slice.byteLength;
  }
}

/** Feed every non-mdat top-level box; resolves with the parsed info. */
async function loadHeader(
  file: File,
  mp4: import('mp4box').MP4File,
): Promise<import('mp4box').MP4Info | null> {
  const boxes = await scanBoxes(file);
  return new Promise(async (resolve) => {
    let done = false;
    mp4.onError = () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    };
    mp4.onReady = (info) => {
      if (!done) {
        done = true;
        resolve(info);
      }
    };
    for (const box of boxes) {
      if (done) break;
      // mp4box parses contiguously: it needs the mdat's header to know how far
      // to skip, but none of its payload.
      const end = box.type === 'mdat' ? box.start + Math.min(16, box.size) : box.start + box.size;
      await append(file, mp4, box.start, end);
    }
    if (!done) {
      done = true;
      resolve(null);
    }
  });
}

export async function probeMp4AudioTracks(file: File): Promise<AudioTrackInfo[]> {
  const { createFile } = await import('mp4box');
  const mp4 = createFile();
  const info = await loadHeader(file, mp4);
  if (!info) return [];

  return info.audioTracks.map((t) => {
    const { codec, name: codecName } = codecFromMp4(t.codec);
    let description: Uint8Array | undefined;
    if (codec === 'aac') {
      try {
        const entry = mp4.getTrackById(t.id).mdia.minf.stbl.stsd.entries[0];
        description = entry.esds?.esd.descs[0].descs[0].data;
      } catch {
        // No esds: leave the decoder to guess from the codec string.
      }
    }
    // mp4box reports the handler name ("SoundHandler"), which isn't a title.
    const name = t.name && !/handler/i.test(t.name) ? t.name : undefined;
    return {
      id: t.id,
      label: [name, t.language].filter((v) => v && v !== 'und').join(' — ') || `Track ${t.id}`,
      codec,
      codecName,
      sampleRate: t.audio?.sample_rate ?? 48000,
      channels: t.audio?.channel_count ?? 2,
      description,
    };
  });
}

/**
 * Extract frames of one track from `fromTime` on. mp4box has the sample
 * table after the header, so this is real random access: it tells us the
 * file offset to resume from and we read only from there.
 */
export async function demuxMp4AudioTrack(
  file: File,
  trackId: number,
  fromTime: number,
  onFrame: (frame: EncodedAudioFrame) => void,
  signal: AbortSignal,
  backpressure?: () => Promise<void>,
): Promise<void> {
  const { createFile } = await import('mp4box');
  const mp4 = createFile();

  mp4.onSamples = (_id, _user, samples) => {
    for (const s of samples) {
      const timestamp = s.cts / s.timescale;
      const duration = s.duration / s.timescale;
      if (timestamp + duration < fromTime) continue;
      onFrame({ data: s.data, timestamp, duration });
    }
  };

  const info = await loadHeader(file, mp4);
  if (!info || signal.aborted) return;

  mp4.setExtractionOptions(trackId, null, { nbSamples: 100 });
  mp4.start();
  const { offset } = mp4.seek(fromTime, true);
  await append(file, mp4, offset, file.size, { signal, backpressure });
  mp4.flush();
  mp4.stop();
}
