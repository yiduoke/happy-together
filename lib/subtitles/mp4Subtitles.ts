'use client';

import type { ScannedTrack } from './scanSubtitles';
import { cuesToVttUrl, type VttCue } from './vtt';

/**
 * Pulls text subtitle tracks out of an MP4/MOV.
 *
 * Browsers only demux MP4 subtitle tracks out of a *network* URL (and not even
 * reliably there); with a blob: source Chrome exposes nothing but video and
 * audio, so the file has to be read here. Only the `moov` box and the sample
 * bytes are touched — `mdat` is skipped by offset — so a feature-length film
 * costs a few hundred kilobytes of reads rather than the whole 500 MB.
 *
 * Only 3GPP timed text (`tx3g`) is handled, which is what ffmpeg/mp4box write
 * when muxing SubRip or WebVTT into MP4. CEA-608/708 and bitmap tracks are
 * left alone.
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

const LANGUAGE_NAMES: Record<string, string> = {
  eng: 'English',
  spa: 'Spanish',
  fra: 'French',
  fre: 'French',
  deu: 'German',
  ger: 'German',
  ita: 'Italian',
  por: 'Portuguese',
  rus: 'Russian',
  jpn: 'Japanese',
  zho: 'Chinese',
  chi: 'Chinese',
  kor: 'Korean',
  ara: 'Arabic',
  heb: 'Hebrew',
  hun: 'Hungarian',
  pol: 'Polish',
  nld: 'Dutch',
  dut: 'Dutch',
  swe: 'Swedish',
  dan: 'Danish',
  nor: 'Norwegian',
  fin: 'Finnish',
  tur: 'Turkish',
  ell: 'Greek',
  gre: 'Greek',
  ces: 'Czech',
  cze: 'Czech',
  ron: 'Romanian',
  rum: 'Romanian',
  ukr: 'Ukrainian',
  srp: 'Serbian',
  hrv: 'Croatian',
  bul: 'Bulgarian',
  slk: 'Slovak',
  slo: 'Slovak',
  slv: 'Slovenian',
  est: 'Estonian',
  lav: 'Latvian',
  lit: 'Lithuanian',
  isl: 'Icelandic',
  ice: 'Icelandic',
  fas: 'Persian',
  per: 'Persian',
  hin: 'Hindi',
  vie: 'Vietnamese',
  ind: 'Indonesian',
  tha: 'Thai',
  msa: 'Malay',
  may: 'Malay',
  eus: 'Basque',
  baq: 'Basque',
  cat: 'Catalan',
};

interface Box {
  type: string;
  /** First byte of the payload (after the header). */
  start: number;
  /** One past the last byte of the box. */
  end: number;
}

function boxType(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function boxAt(view: DataView, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null;
  let size = view.getUint32(offset);
  const type = boxType(view, offset + 4);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = Number(view.getBigUint64(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < header || offset + size > limit) return null;
  return { type, start: offset + header, end: offset + size };
}

function* children(view: DataView, start: number, end: number): Generator<Box> {
  let offset = start;
  for (;;) {
    const box = boxAt(view, offset, end);
    if (!box) return;
    yield box;
    offset = box.end;
  }
}

function findChild(view: DataView, parent: Box, type: string): Box | null {
  for (const box of children(view, parent.start, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

function readLanguages(code: number) {
  if (code === 0) return 'und';
  return [10, 5, 0].map((shift) => String.fromCharCode(0x60 + ((code >> shift) & 0x1f))).join('');
}

interface Table {
  codec: string;
  timescale: number;
  language: string;
  sizes: number[];
  /** Seconds. */
  starts: number[];
  /** Seconds. */
  durations: number[];
  offsets: number[];
}

function parseStts(view: DataView, box: Box) {
  const count = view.getUint32(box.start + 4);
  const out: Array<{ count: number; delta: number }> = [];
  for (let i = 0; i < count; i++) {
    const at = box.start + 8 + i * 8;
    if (at + 8 > box.end) break;
    out.push({ count: view.getUint32(at), delta: view.getUint32(at + 4) });
  }
  return out;
}

function parseStsz(view: DataView, box: Box) {
  const constant = view.getUint32(box.start + 4);
  const count = view.getUint32(box.start + 8);
  if (constant !== 0) return new Array<number>(count).fill(constant);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = box.start + 12 + i * 4;
    if (at + 4 > box.end) break;
    sizes.push(view.getUint32(at));
  }
  return sizes;
}

function parseStsc(view: DataView, box: Box) {
  const count = view.getUint32(box.start + 4);
  const out: Array<{ firstChunk: number; perChunk: number }> = [];
  for (let i = 0; i < count; i++) {
    const at = box.start + 8 + i * 12;
    if (at + 12 > box.end) break;
    out.push({ firstChunk: view.getUint32(at), perChunk: view.getUint32(at + 4) });
  }
  return out;
}

function parseChunkOffsets(view: DataView, box: Box) {
  const count = view.getUint32(box.start + 4);
  const wide = box.type === 'co64';
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = box.start + 8 + i * (wide ? 8 : 4);
    if (at + (wide ? 8 : 4) > box.end) break;
    offsets.push(wide ? Number(view.getBigUint64(at)) : view.getUint32(at));
  }
  return offsets;
}

function readTable(view: DataView, trak: Box): Table | null {
  const mdia = findChild(view, trak, 'mdia');
  if (!mdia) return null;
  const hdlr = findChild(view, mdia, 'hdlr');
  if (!hdlr) return null;
  const handler = boxType(view, hdlr.start + 8);
  if (handler !== 'sbtl' && handler !== 'text') return null;

  const mdhd = findChild(view, mdia, 'mdhd');
  const minf = findChild(view, mdia, 'minf');
  const stbl = minf && findChild(view, minf, 'stbl');
  if (!mdhd || !stbl) return null;

  const version = view.getUint32(mdhd.start) >>> 24;
  const timescale =
    version === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12);
  if (!timescale) return null;
  const language = readLanguages(view.getUint16(mdhd.start + (version === 1 ? 32 : 20)));

  const stsd = findChild(view, stbl, 'stsd');
  if (!stsd) return null;
  const entries = view.getUint32(stsd.start + 4);
  if (entries < 1) return null;
  const codec = boxType(view, stsd.start + 12);
  if (codec !== 'tx3g') return null;

  const stts = findChild(view, stbl, 'stts');
  const stsz = findChild(view, stbl, 'stsz');
  const stsc = findChild(view, stbl, 'stsc');
  const stco = findChild(view, stbl, 'stco') ?? findChild(view, stbl, 'co64');
  if (!stts || !stsz || !stsc || !stco) return null;

  const sizes = parseStsz(view, stsz);
  if (!sizes.length) return null;
  const offsets = new Array<number>(sizes.length).fill(0);
  const starts = new Array<number>(sizes.length).fill(0);
  const durations = new Array<number>(sizes.length).fill(0);

  const timeEntries = parseStts(view, stts);
  let timeIndex = 0;
  let remaining = 0;
  let delta = 0;
  let elapsed = 0;
  for (let i = 0; i < sizes.length; i++) {
    while (remaining === 0 && timeIndex < timeEntries.length) {
      remaining = timeEntries[timeIndex].count;
      delta = timeEntries[timeIndex].delta;
      timeIndex++;
    }
    starts[i] = elapsed / timescale;
    durations[i] = delta / timescale;
    elapsed += delta;
    remaining = Math.max(0, remaining - 1);
  }

  const chunkOffsets = parseChunkOffsets(view, stco);
  const chunkMap = parseStsc(view, stsc);
  if (!chunkOffsets.length || !chunkMap.length) return null;
  let mapIndex = 0;
  let sample = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length && sample < sizes.length; chunk++) {
    while (mapIndex + 1 < chunkMap.length && chunkMap[mapIndex + 1].firstChunk <= chunk) {
      mapIndex++;
    }
    const perChunk = chunkMap[mapIndex]?.perChunk ?? 1;
    let cursor = chunkOffsets[chunk - 1];
    for (let k = 0; k < perChunk && sample < sizes.length; k++) {
      offsets[sample] = cursor;
      cursor += sizes[sample];
      sample++;
    }
  }
  if (sample < sizes.length) offsets.length = sample;

  return { codec, timescale, language, sizes, starts, durations, offsets };
}

async function findMoov(file: File) {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = boxType(head, 4);
    let header = 8;
    if (size === 1) {
      size = Number(head.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < header) return null;
    if (type === 'moov') return { start: offset + header, size: size - header };
    offset += size;
  }
  return null;
}

function decodeTx3g(bytes: Uint8Array) {
  if (bytes.length < 2) return '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Math.min(view.getUint16(0), bytes.length - 2);
  if (length === 0) return '';
  return new TextDecoder().decode(bytes.subarray(2, 2 + length)).trim();
}

export async function scanMp4Subtitles(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ScannedTrack[]> {
  const moov = await findMoov(file);
  if (!moov) return [];

  const view = new DataView(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
  const root: Box = { type: 'moov', start: 0, end: view.byteLength };
  const tables: Table[] = [];
  for (const box of children(view, root.start, root.end)) {
    if (box.type !== 'trak') continue;
    const table = readTable(view, box);
    if (table) tables.push(table);
  }

  const out: ScannedTrack[] = [];
  for (const table of tables) {
    if (signal?.aborted) break;
    const count = table.offsets.length;
    const cues: VttCue[] = [];
    let index = 0;
    while (index < count) {
      if (signal?.aborted) break;
      // Samples in one chunk sit back to back: fetch the whole run in a read.
      let end = index + 1;
      let cursor = table.offsets[index] + table.sizes[index];
      while (end < count && table.offsets[end] === cursor && table.sizes[end] > 0) {
        cursor += table.sizes[end];
        end++;
      }
      const start = table.offsets[index];
      const buffer = new Uint8Array(await file.slice(start, cursor).arrayBuffer());
      for (let i = index; i < end; i++) {
        const from = table.offsets[i] - start;
        const text = decodeTx3g(buffer.subarray(from, from + table.sizes[i]));
        if (!text) {
          // An empty sample clears the screen; the cue before it ends here.
          const previous = cues[cues.length - 1];
          if (previous) previous.end = table.starts[i] * 1000;
        } else {
          cues.push({
            start: table.starts[i] * 1000,
            end: (table.starts[i] + table.durations[i]) * 1000,
            text,
          });
        }
      }
      index = end;
      onProgress?.(index / count);
    }
    if (cues.length) {
      const name = LANGUAGE_NAMES[table.language];
      out.push({
        kind: 'text',
        label: name ?? (table.language === 'und' ? 'Subtitles' : table.language.toUpperCase()),
        vttUrl: cuesToVttUrl(cues),
      });
    }
  }
  return out;
}
