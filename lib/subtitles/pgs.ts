'use client';

/**
 * PGS (Presentation Graphic Stream) subtitle decoding — the image subtitles
 * BluRay rips carry.
 *
 * A display set is a run of segments: a composition saying where the image
 * goes, a window, a palette, and one or more object segments holding a
 * run-length-encoded bitmap. A later set with no object clears the screen.
 *
 * As with VobSub, no OCR is involved: the result is pixels for a canvas.
 */

export interface PgsImage {
  /** Position and size in the authoring resolution given by the composition. */
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface PgsDisplaySet {
  /** Null when this set only clears the previous subtitle. */
  image: PgsImage | null;
  /** Authoring resolution, for scaling onto the picture. */
  videoWidth: number;
  videoHeight: number;
}

const SEG_PDS = 0x14;
const SEG_ODS = 0x15;
const SEG_PCS = 0x16;

/** BT.709 limited range, which is what HD discs author in. */
function ycrcbToRgb(y: number, cr: number, cb: number) {
  const yy = ((y - 16) * 255) / 219;
  const r = yy + 1.5748 * (cr - 128);
  const g = yy - 0.1873 * (cb - 128) - 0.4681 * (cr - 128);
  const b = yy + 1.8556 * (cb - 128);
  return [r, g, b];
}

/**
 * Decode one display set. `data` is the inflated block payload: a sequence of
 * [type:1][size:2][payload] segments.
 */
export function decodePgsDisplaySet(data: Uint8Array): PgsDisplaySet | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const palette = new Uint8ClampedArray(256 * 4);
  let videoWidth = 1920;
  let videoHeight = 1080;
  let objX = 0;
  let objY = 0;
  let width = 0;
  let height = 0;
  const rleParts: Uint8Array[] = [];
  let sawObject = false;

  let p = 0;
  while (p + 3 <= data.length) {
    const type = data[p];
    const size = view.getUint16(p + 1);
    const body = p + 3;
    if (body + size > data.length) break;

    if (type === SEG_PCS) {
      videoWidth = view.getUint16(body);
      videoHeight = view.getUint16(body + 2);
      const objectCount = data[body + 10];
      if (objectCount > 0 && size >= 19) {
        // object_id:2, window_id:1, flags:1, x:2, y:2
        objX = view.getUint16(body + 15);
        objY = view.getUint16(body + 17);
      }
    } else if (type === SEG_PDS) {
      // palette_id:1, version:1, then 5 bytes per entry
      for (let q = body + 2; q + 5 <= body + size; q += 5) {
        const id = data[q];
        const [r, g, b] = ycrcbToRgb(data[q + 1], data[q + 2], data[q + 3]);
        palette[id * 4] = r;
        palette[id * 4 + 1] = g;
        palette[id * 4 + 2] = b;
        palette[id * 4 + 3] = data[q + 4];
      }
    } else if (type === SEG_ODS) {
      sawObject = true;
      // object_id:2, version:1, sequence_flags:1, then on the first segment
      // data_length:3, width:2, height:2 before the RLE data.
      const flags = data[body + 3];
      const isFirst = (flags & 0x80) !== 0;
      if (isFirst) {
        width = view.getUint16(body + 7);
        height = view.getUint16(body + 9);
        rleParts.push(data.subarray(body + 11, body + size));
      } else {
        rleParts.push(data.subarray(body + 4, body + size));
      }
    }
    p = body + size;
  }

  if (!sawObject || width <= 0 || height <= 0) {
    return { image: null, videoWidth, videoHeight };
  }

  // Objects may be split across segments; the RLE stream is their concatenation.
  const total = rleParts.reduce((n, part) => n + part.length, 0);
  const rle = new Uint8Array(total);
  let at = 0;
  for (const part of rleParts) {
    rle.set(part, at);
    at += part.length;
  }

  const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < rle.length && y < height) {
    const first = rle[i++];
    let run = 1;
    let color = first;
    if (first === 0) {
      const second = rle[i++];
      if (second === 0) {
        // End of line.
        y++;
        x = 0;
        continue;
      }
      const long = (second & 0x40) !== 0;
      const coloured = (second & 0x80) !== 0;
      run = long ? ((second & 0x3f) << 8) | rle[i++] : second & 0x3f;
      color = coloured ? rle[i++] : 0;
    }
    const o = color * 4;
    const alpha = palette[o + 3];
    if (alpha > 0) {
      for (let k = 0; k < run && x + k < width; k++) {
        const px = (y * width + x + k) * 4;
        rgba[px] = palette[o];
        rgba[px + 1] = palette[o + 1];
        rgba[px + 2] = palette[o + 2];
        rgba[px + 3] = alpha;
      }
    }
    // Lines are terminated by an explicit 0x00 0x00, so only that advances y.
    // Wrapping here as well skipped every other line, which showed up as
    // stripes through the glyphs.
    x += run;
  }

  return { image: { x: objX, y: objY, width, height, rgba }, videoWidth, videoHeight };
}
