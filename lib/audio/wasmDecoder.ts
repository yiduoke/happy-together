'use client';

import type { AudioCodecId, EncodedAudioFrame } from './types';

/**
 * Decodes the audio codecs no browser will touch — AC3, E-AC3, DTS, TrueHD —
 * by running ffmpeg's own decoders compiled to WebAssembly.
 *
 * Browsers omit these deliberately (patent licensing), which is why they play
 * silent everywhere. Bundling the decoder is what desktop players like VLC do;
 * this is the same trick, in a worker.
 *
 * Frames come from our container demuxer, so ffmpeg never sees the movie file:
 * it is handed a small elementary stream per batch, which keeps the whole file
 * out of WASM memory and makes seeking just "decode a different batch".
 */

// ffmpeg's -f name for each codec's raw elementary stream.
const RAW_FORMAT: Partial<Record<AudioCodecId, string>> = {
  ac3: 'ac3',
  eac3: 'eac3',
  dts: 'dts',
  truehd: 'truehd',
};

export function needsWasm(codec: AudioCodecId): boolean {
  return codec in RAW_FORMAT;
}

export interface DecodedPcm {
  channelData: Float32Array<ArrayBuffer>[];
  sampleRate: number;
}

type FFmpegInstance = import('@ffmpeg/ffmpeg').FFmpeg;

let loading: Promise<FFmpegInstance> | null = null;

/** Load (once per page) the ~31 MB ffmpeg core. */
export function loadWasmDecoder(onProgress?: (fraction: number) => void): Promise<FFmpegInstance> {
  if (!loading) {
    loading = (async () => {
      // Load the copies in /public rather than the bundled package: the
      // bundler rewrites the module's worker resolution and the class then
      // fails to spawn its core worker.
      const load = new Function(
        'url',
        'return import(/* webpackIgnore: true */ url)',
      ) as (url: string) => Promise<typeof import('@ffmpeg/ffmpeg')>;
      const { FFmpeg } = await load('/ffmpeg/classes.js');
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => onProgress?.(progress));
      await ffmpeg.load({
        coreURL: '/ffmpeg/ffmpeg-core.js',
        wasmURL: '/ffmpeg/ffmpeg-core.wasm',
        classWorkerURL: '/ffmpeg/worker.js',
      });
      return ffmpeg;
    })();
    loading.catch(() => {
      loading = null; // let a later attempt retry
    });
  }
  return loading;
}

export class WasmAudioDecoder {
  private ffmpeg: FFmpegInstance | null = null;
  private seq = 0;
  /** ffmpeg.exec() is single-threaded per instance; serialise calls. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private codec: AudioCodecId,
    private channels: number,
    private sampleRate: number,
  ) {}

  async init(onProgress?: (fraction: number) => void) {
    this.ffmpeg = await loadWasmDecoder(onProgress);
  }

  /**
   * Decode one batch of frames to interleaved-free float PCM. Frames must be
   * consecutive; the caller keeps track of the batch's start timestamp.
   */
  decode(frames: EncodedAudioFrame[]): Promise<DecodedPcm | null> {
    const run = async (): Promise<DecodedPcm | null> => {
      const ffmpeg = this.ffmpeg;
      const format = RAW_FORMAT[this.codec];
      if (!ffmpeg || !format || frames.length === 0) return null;

      const total = frames.reduce((n, f) => n + f.data.length, 0);
      const blob = new Uint8Array(total);
      let at = 0;
      for (const f of frames) {
        blob.set(f.data, at);
        at += f.data.length;
      }

      // Unique names: ffmpeg's virtual FS is shared across calls.
      const id = this.seq++;
      const inName = `in${id}.${format}`;
      const outName = `out${id}.pcm`;
      // Downmix to stereo: surround layouts break several encoders, and
      // viewers are on laptops and headphones anyway.
      const outChannels = Math.min(this.channels, 2);
      try {
        await ffmpeg.writeFile(inName, blob);
        const code = await ffmpeg.exec([
          '-hide_banner',
          '-f',
          format,
          '-i',
          inName,
          '-ac',
          String(outChannels),
          '-ar',
          String(this.sampleRate),
          '-f',
          'f32le',
          outName,
        ]);
        if (code !== 0) return null;
        const data = (await ffmpeg.readFile(outName)) as Uint8Array;
        // Copy off the WASM heap before it is reused, then de-interleave.
        const interleaved = new Float32Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
        const perChannel = Math.floor(interleaved.length / outChannels);
        const channelData: Float32Array<ArrayBuffer>[] = [];
        for (let ch = 0; ch < outChannels; ch++) {
          const plane = new Float32Array(perChannel);
          for (let i = 0; i < perChannel; i++) plane[i] = interleaved[i * outChannels + ch];
          channelData.push(plane);
        }
        return { channelData, sampleRate: this.sampleRate };
      } catch {
        return null;
      } finally {
        ffmpeg.deleteFile(inName).catch(() => {});
        ffmpeg.deleteFile(outName).catch(() => {});
      }
    };

    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next as Promise<DecodedPcm | null>;
  }
}
