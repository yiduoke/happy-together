'use client';

/**
 * Reads an AAC AudioSpecificConfig — the bytes a container stores as
 * CodecPrivate (Matroska) or in the esds box (MP4).
 *
 * This matters for HE-AAC, which is coded at half the rate it plays back at:
 * the container advertises the base rate (say 24 kHz) while the decoder emits
 * double that. Assuming plain AAC-LC there gives the wrong codec string and an
 * AudioContext running at half speed.
 */

const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export interface AacConfig {
  /** WebCodecs codec string, e.g. mp4a.40.2 (LC) or mp4a.40.5 (HE). */
  codec: string;
  /** Rate the decoder actually outputs — doubled when SBR is present. */
  sampleRate: number;
  channels: number;
}

class BitReader {
  private pos = 0;
  constructor(private data: Uint8Array) {}
  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  get remaining() {
    return this.data.length * 8 - this.pos;
  }
}

export function parseAacConfig(description?: Uint8Array): AacConfig | null {
  if (!description || description.length < 2) return null;
  const r = new BitReader(description);

  let objectType = r.read(5);
  if (objectType === 31) objectType = 32 + r.read(6);

  const freqIndex = r.read(4);
  const baseRate = freqIndex === 15 ? r.read(24) : (SAMPLE_RATES[freqIndex] ?? 48000);
  const channels = r.read(4);

  let sbr = objectType === 5 || objectType === 29;
  let outputRate = baseRate;

  if (sbr) {
    // Explicit signalling: the extension rate follows immediately.
    const extIndex = r.read(4);
    outputRate = extIndex === 15 ? r.read(24) : (SAMPLE_RATES[extIndex] ?? baseRate * 2);
    objectType = r.read(5);
  } else {
    // GASpecificConfig: frameLengthFlag, dependsOnCoreCoder, extensionFlag.
    // These must be consumed or the sync extension below is bit-misaligned.
    r.read(1);
    if (r.read(1) === 1) r.read(14); // coreCoderDelay
    r.read(1);
    // Backward-compatible signalling: a 0x2B7 marker after the base config.
    if (r.remaining >= 16 && r.read(11) === 0x2b7) {
      const extType = r.read(5);
      if (extType === 5 && r.read(1) === 1) {
        sbr = true;
        const extIndex = r.read(4);
        outputRate = extIndex === 15 ? r.read(24) : (SAMPLE_RATES[extIndex] ?? baseRate * 2);
      }
    }
  }

  return {
    codec: `mp4a.40.${sbr ? 5 : objectType}`,
    sampleRate: outputRate,
    channels: channels || 2,
  };
}
