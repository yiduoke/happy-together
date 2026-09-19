'use client';

/**
 * DVD/VobSub (SPU) subtitle decoding.
 *
 * A VobSub packet is a run-length-encoded 4-colour bitmap plus a control
 * sequence that says where to put it, which palette entries to use and how
 * transparent each of the four colours is. The palette itself lives in the
 * track's CodecPrivate (the `.idx` sidecar text).
 *
 * Nothing here needs OCR: the result is pixels, which we hand to a canvas.
 */

export interface VobSubImage {
  /** Position and size in the *authoring* resolution (see parseIdx). */
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface IdxInfo {
  palette: number[];
  /** Coordinate space the packets are authored in, e.g. 1920x1080. */
  width: number;
  height: number;
}

export function parseIdx(codecPrivate: Uint8Array): IdxInfo {
  const text = new TextDecoder().decode(codecPrivate);
  const paletteMatch = /palette:\s*([0-9a-fA-F,\s]+)/.exec(text);
  const palette = paletteMatch
    ? paletteMatch[1]
        .split(',')
        .map((s) => parseInt(s.trim(), 16))
        .filter((n) => Number.isFinite(n))
    : [];
  const sizeMatch = /size:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
  return {
    palette,
    width: sizeMatch ? Number(sizeMatch[1]) : 720,
    height: sizeMatch ? Number(sizeMatch[2]) : 480,
  };
}

const MAX_DIMENSION = 4096;

/** Decode one SPU packet. Returns null if the packet is malformed. */
export function decodeVobSubPacket(buf: Uint8Array, palette: number[]): VobSubImage | null {
  if (buf.length < 4) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const controlOffset = view.getUint16(2);
  if (controlOffset + 4 > buf.length) return null;

  let paletteIdx = [0, 1, 2, 3];
  let alpha = [0, 15, 15, 15];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let rleEven = 0;
  let rleOdd = 0;

  // Control sequences are a linked list: [delay][addr of next][commands…].
  let seq = controlOffset;
  for (let guard = 0; guard < 64; guard++) {
    if (seq + 4 > buf.length) break;
    const next = view.getUint16(seq + 2);
    let p = seq + 4;
    let done = false;
    while (p < buf.length && !done) {
      const cmd = buf[p++];
      switch (cmd) {
        case 0x00: // forced display
        case 0x01: // start display
        case 0x02: // stop display
          break;
        // Both tables are stored highest-colour-first, so colour 0 — the
        // background, and the one that must stay transparent — is the LOW
        // nibble of the second byte.
        case 0x03: // palette indices for the 4 colours
          if (p + 2 > buf.length) return null;
          paletteIdx = [buf[p + 1] & 15, buf[p + 1] >> 4, buf[p] & 15, buf[p] >> 4];
          p += 2;
          break;
        case 0x04: // alpha for the 4 colours
          if (p + 2 > buf.length) return null;
          alpha = [buf[p + 1] & 15, buf[p + 1] >> 4, buf[p] & 15, buf[p] >> 4];
          p += 2;
          break;
        case 0x05: // display area, 12 bits per edge
          if (p + 6 > buf.length) return null;
          x1 = (buf[p] << 4) | (buf[p + 1] >> 4);
          x2 = ((buf[p + 1] & 15) << 8) | buf[p + 2];
          y1 = (buf[p + 3] << 4) | (buf[p + 4] >> 4);
          y2 = ((buf[p + 4] & 15) << 8) | buf[p + 5];
          p += 6;
          break;
        case 0x06: // byte offsets of the even and odd line fields
          if (p + 4 > buf.length) return null;
          rleEven = view.getUint16(p);
          rleOdd = view.getUint16(p + 2);
          p += 4;
          break;
        default: // 0xff terminates, anything else is unknown — stop
          done = true;
          break;
      }
    }
    if (next === seq || next === 0 || next >= buf.length) break;
    seq = next;
  }

  const width = x2 - x1 + 1;
  const height = y2 - y1 + 1;
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;

  const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const colors = paletteIdx.map((i) => palette[i] ?? 0);
  const alphas = alpha.map((a) => Math.round((a / 15) * 255));

  // Lines are stored in two interleaved fields: even lines then odd lines.
  const decodeField = (startByte: number, firstLine: number) => {
    let bytePos = startByte;
    let highNibble = true;
    const nextNibble = () => {
      if (bytePos >= buf.length) return 0;
      const b = buf[bytePos];
      const n = highNibble ? b >> 4 : b & 15;
      if (highNibble) highNibble = false;
      else {
        highNibble = true;
        bytePos++;
      }
      return n;
    };

    for (let y = firstLine; y < height; y += 2) {
      let x = 0;
      while (x < width) {
        // A run is 1–4 nibbles; it ends once the accumulated value is large
        // enough to hold both the count and the 2-bit colour.
        let v = 0;
        for (let n = 1; n <= 4; n++) {
          v = (v << 4) | nextNibble();
          if (v >= 1 << (2 * n)) break;
        }
        const color = v & 3;
        let run = v >> 2;
        if (run === 0) run = width - x; // 0 means "to end of line"
        run = Math.min(run, width - x);
        const rgb = colors[color];
        const a = alphas[color];
        if (a > 0) {
          const r = (rgb >> 16) & 255;
          const g = (rgb >> 8) & 255;
          const b = rgb & 255;
          for (let i = 0; i < run; i++) {
            const o = (y * width + x + i) * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = a;
          }
        }
        x += run;
      }
      // Each line is byte-aligned.
      if (!highNibble) {
        highNibble = true;
        bytePos++;
      }
    }
  };

  decodeField(rleEven, 0);
  decodeField(rleOdd, 1);

  return { x: x1, y: y1, width, height, rgba };
}
