'use client';

import type { AudioContainer, AudioTrackInfo, EncodedAudioFrame } from './types';
import { demuxMkvAudioTrack } from './mkvAudioDemux';
import { demuxMp4AudioTrack } from './mp4AudioDemux';
import { WasmAudioDecoder, needsWasm } from './wasmDecoder';
import { parseAacConfig } from './aac';

// Media seconds decoded and scheduled ahead of the playhead. Small on purpose:
// frames already scheduled can't follow a later playbackRate change exactly.
const LOOKAHEAD = 1.0;
// Compressed frames held between demuxer and decoder before we stall the
// demuxer. This must comfortably exceed one batch: E-AC3 runs ~31 frames a
// second, so a 5 s batch is ~157 frames and a 64-frame cap starved every one
// of them into a short, separately-decoded fragment.
const QUEUE_HIGH = 512;
const MAX_DECODE_QUEUE = 8;
// Past this much divergence from the video clock we restart from its position.
// video.currentTime advances in frame-sized steps (~42 ms at 24 fps), so the
// steady-state threshold must sit well above that jitter. The first check
// after a (re)start is tighter: it absorbs the element's play-start latency.
const RESYNC_THRESHOLD = 0.12;
// Past this, the playhead really moved and the pipeline must restart.
const HARD_RESYNC_THRESHOLD = 1.0;
const FIRST_CHECK_THRESHOLD = 0.06;
const TICK_MS = 50;

export type EngineStatus = 'loading-decoder' | 'starting' | 'playing' | 'stopped' | 'error';

// Media seconds of compressed frames handed to the WASM decoder per call.
// Large enough that ffmpeg's per-invocation overhead is negligible, small
// enough that a seek doesn't waste much work.
const WASM_BATCH_SECONDS = 5;

/**
 * Plays one alternate audio track of a local file in lockstep with the
 * <video> element that is playing the (muted) original.
 *
 * Pipeline: container demuxer → WebCodecs AudioDecoder → AudioBufferSourceNodes
 * scheduled on an AudioContext. The context time is anchored to the video's
 * currentTime; pause/resume suspends/resumes the context, seeks restart the
 * pipeline at the new position, and playbackRate changes (the room's drift
 * correction) are mirrored onto every scheduled node.
 */
export class AudioTrackEngine {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private decoder: AudioDecoder | null = null;
  private decoderConfig: AudioDecoderConfig | null = null;
  private wasm: WasmAudioDecoder | null = null;
  private wasmBatch: EncodedAudioFrame[] = [];
  private wasmBusy = false;
  private demuxDone = false;
  private stats = {
    batches: 0,
    reanchors: 0,
    resyncs: 0,
    lastBatchMs: 0,
    dropped: 0,
    seekedEvents: 0,
    lastResync: 'none',
  };
  private abort: AbortController | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private queue: EncodedAudioFrame[] = [];
  private spaceWaiters: Array<() => void> = [];
  private tickTimer: number | null = null;
  private driftCounter = 0;

  private anchorCtx = 0;
  private anchorMedia = 0;
  private rate = 1;
  /** Media time up to which frames have been handed to the decoder. */
  private decodedUntil = 0;
  /** Outputs before this are stale (from before the last resync). */
  private minAcceptedTs = 0;
  private gotFirstOutput = false;
  private checkedSinceResync = false;

  private file: File | null = null;
  private container: AudioContainer = 'mp4';
  private track: AudioTrackInfo | null = null;

  constructor(
    private video: HTMLVideoElement,
    private onStatus: (status: EngineStatus, detail?: string) => void,
  ) {}

  async start(file: File, container: AudioContainer, track: AudioTrackInfo) {
    this.stop();
    if (!track.codec) {
      this.onStatus('error', `${track.codecName} isn't decodable in this browser`);
      return;
    }
    this.file = file;
    this.container = container;
    this.track = track;

    if (needsWasm(track.codec)) {
      // No browser ships these decoders; fall back to ffmpeg-in-WASM.
      this.onStatus('loading-decoder');
      this.wasm = new WasmAudioDecoder(track.codec, track.channels, track.sampleRate);
      try {
        await this.wasm.init();
      } catch (e) {
        this.wasm = null;
        const why = e instanceof Error ? `: ${e.message}` : '';
        this.onStatus('error', `couldn't load the ${track.codecName} decoder${why}`);
        return;
      }
      if (this.track !== track) return; // superseded while loading
      this.decoderConfig = null;
    } else {
      // HE-AAC is coded at half its playback rate, so trust the config bytes
      // over the container's advertised rate.
      const aac = track.codec === 'aac' ? parseAacConfig(track.description) : null;
      this.decoderConfig = {
        codec: aac?.codec ?? (track.codec === 'aac' ? 'mp4a.40.2' : 'opus'),
        sampleRate: aac?.sampleRate ?? track.sampleRate,
        numberOfChannels: aac?.channels ?? track.channels,
        description: track.description,
      };
      try {
        const support = await AudioDecoder.isConfigSupported(this.decoderConfig);
        if (!support.supported) throw new Error('unsupported');
      } catch {
        this.onStatus('error', `${track.codecName} isn't decodable in this browser`);
        return;
      }
    }

    this.ctx = new AudioContext({ sampleRate: this.decoderConfig?.sampleRate ?? track.sampleRate });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.video.volume;
    this.gain.connect(this.ctx.destination);

    this.video.muted = true;
    this.video.addEventListener('seeked', this.onSeeked);
    this.video.addEventListener('ratechange', this.onRateChange);
    this.video.addEventListener('volumechange', this.onVolumeChange);

    this.onStatus('starting');
    this.stats.lastResync = 'start';
    this.resync(this.video.currentTime);
    this.tickTimer = window.setInterval(this.tick, TICK_MS);
  }

  stop() {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('ratechange', this.onRateChange);
    this.video.removeEventListener('volumechange', this.onVolumeChange);

    this.abort?.abort();
    this.abort = null;
    this.stopSources();
    this.queue.length = 0;
    this.releaseWaiters();

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Already closed after an error.
      }
      this.decoder = null;
    }
    this.wasm = null;
    this.wasmBatch.length = 0;
    this.wasmBusy = false;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gain = null;
    }
    if (this.file) {
      this.video.muted = false;
      this.onStatus('stopped');
    }
    this.file = null;
    this.track = null;
  }

  // --- pipeline -----------------------------------------------------------

  private resync(fromMedia: number) {
    if (!this.ctx || !this.file || !this.track) return;
    if (!this.decoderConfig && !this.wasm) return;
    this.stats.resyncs++;

    this.abort?.abort();
    this.abort = new AbortController();
    this.stopSources();
    this.queue.length = 0;
    this.releaseWaiters();

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // ignore
      }
      this.decoder = null;
    }
    if (this.decoderConfig) {
      this.decoder = new AudioDecoder({
        output: this.onDecoded,
        error: (e) => this.fail(e.message),
      });
      this.decoder.configure(this.decoderConfig);
    }
    this.wasmBatch.length = 0;
    this.wasmBusy = false;
    this.demuxDone = false;

    this.rate = this.video.playbackRate || 1;
    this.anchorCtx = this.ctx.currentTime;
    this.anchorMedia = fromMedia;
    this.decodedUntil = fromMedia;
    this.minAcceptedTs = fromMedia - 0.1;
    this.gotFirstOutput = false;
    this.checkedSinceResync = false;
    this.driftCounter = 0;

    const signal = this.abort.signal;
    const onFrame = (frame: EncodedAudioFrame) => {
      if (signal.aborted) return;
      this.queue.push(frame);
    };
    const backpressure = () =>
      this.queue.length < QUEUE_HIGH || signal.aborted
        ? Promise.resolve()
        : new Promise<void>((r) => this.spaceWaiters.push(r));

    const demux =
      this.container === 'mp4'
        ? demuxMp4AudioTrack(this.file, this.track.id, fromMedia, onFrame, signal, backpressure)
        : demuxMkvAudioTrack(this.file, this.track.id, fromMedia, onFrame, signal, backpressure);
    demux
      .then(() => {
        if (!signal.aborted) this.demuxDone = true;
      })
      .catch((e) => {
        if (!signal.aborted) this.fail(e instanceof Error ? e.message : 'demux failed');
      });
  }

  /**
   * Re-align to the video clock without disturbing the demuxer or decoder.
   * Already-scheduled audio belongs to the old mapping, so it is dropped;
   * frames still in flight are replayed against the new anchor.
   */
  private reanchor() {
    if (!this.ctx) return;
    this.stats.reanchors++;
    this.stopSources();
    this.anchorMedia = this.video.currentTime;
    this.anchorCtx = this.ctx.currentTime;
    this.minAcceptedTs = this.video.currentTime - 0.1;
  }

  private tick = () => {
    const ctx = this.ctx;
    if (!ctx || (!this.decoder && !this.wasm)) return;

    const shouldRun = !this.video.paused && !this.video.seeking && !this.video.ended;
    if (shouldRun && ctx.state === 'suspended') ctx.resume().catch(() => {});
    else if (!shouldRun && ctx.state === 'running') ctx.suspend().catch(() => {});

    const nowMedia = this.expectedMedia();
    if (this.wasm) this.pumpWasm(nowMedia);
    else this.pumpWebCodecs(nowMedia);

    if (shouldRun && ++this.driftCounter % 10 === 0) {
      const drift = this.video.currentTime - nowMedia;
      const threshold = this.checkedSinceResync ? RESYNC_THRESHOLD : FIRST_CHECK_THRESHOLD;
      this.checkedSinceResync = true;
      if (Math.abs(drift) > HARD_RESYNC_THRESHOLD) {
        // A real jump: start the pipeline over at the new position.
        this.stats.lastResync = `drift ${(drift * 1000).toFixed(0)}ms`;
        this.resync(this.video.currentTime);
      } else if (Math.abs(drift) > threshold) {
        // Ordinary clock drift between the element and the AudioContext.
        // Re-anchor in place: restarting the demuxer would re-read the file
        // from byte zero, which on a feature-length MKV means seconds of
        // silence every time the two clocks wander apart.
        this.reanchor();
      }
    }
  };

  /** WebCodecs path: one compressed frame in, one AudioData out. */
  private pumpWebCodecs(nowMedia: number) {
    const decoder = this.decoder;
    if (!decoder) return;
    while (
      this.queue.length > 0 &&
      this.decodedUntil < nowMedia + LOOKAHEAD &&
      decoder.decodeQueueSize < MAX_DECODE_QUEUE &&
      decoder.state === 'configured'
    ) {
      const f = this.queue.shift()!;
      this.releaseWaiters();
      try {
        decoder.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round(f.timestamp * 1e6),
            duration: Math.round(f.duration * 1e6),
            data: f.data,
          }),
        );
      } catch (e) {
        this.fail(e instanceof Error ? e.message : 'decode failed');
        return;
      }
      this.decodedUntil = f.timestamp + f.duration;
    }
  }

  /**
   * WASM path: ffmpeg decodes a batch at a time, so gather WASM_BATCH_SECONDS
   * of frames and hand them over as one elementary stream.
   */
  private pumpWasm(nowMedia: number) {
    if (this.wasmBusy || this.decodedUntil >= nowMedia + LOOKAHEAD) return;

    while (this.queue.length > 0) {
      const batchStart = this.wasmBatch[0]?.timestamp;
      const next = this.queue[0];
      if (batchStart !== undefined && next.timestamp - batchStart >= WASM_BATCH_SECONDS) break;
      this.wasmBatch.push(this.queue.shift()!);
      this.releaseWaiters();
    }
    const batch = this.wasmBatch;
    const first = batch[0];
    if (!first) return;
    const span =
      batch[batch.length - 1].timestamp + batch[batch.length - 1].duration - first.timestamp;
    // Every batch is a separate ffmpeg run, so don't decode a short one just
    // because the demuxer hasn't caught up — wait, unless the file ended or
    // we're about to run out of scheduled audio.
    const starving = this.decodedUntil <= nowMedia + 0.25;
    if (span < WASM_BATCH_SECONDS && !this.demuxDone && !starving) return;

    this.wasmBatch = [];
    this.wasmBusy = true;
    const decoder = this.wasm;
    const generation = this.abort;
    const startedAt = performance.now();
    decoder!
      .decode(batch)
      .then((pcm) => {
        this.stats.batches++;
        this.stats.lastBatchMs = Math.round(performance.now() - startedAt);
        this.wasmBusy = false;
        // A resync while decoding invalidates this batch.
        if (!pcm || this.abort !== generation) return;
        this.schedulePcm(pcm.channelData, pcm.sampleRate, first.timestamp);
      })
      .catch(() => {
        this.wasmBusy = false;
      });
    this.decodedUntil = first.timestamp + span;
  }

  private onDecoded = (data: AudioData) => {
    if (!this.ctx || !this.gain) {
      data.close();
      return;
    }
    const ts = data.timestamp / 1e6;
    if (ts < this.minAcceptedTs) {
      data.close();
      return;
    }
    const channelData: Float32Array<ArrayBuffer>[] = [];
    for (let ch = 0; ch < data.numberOfChannels; ch++) {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
      channelData.push(plane);
    }
    const rate = data.sampleRate;
    data.close();
    this.schedulePcm(channelData, rate, ts);
  };

  /** Hand decoded PCM to Web Audio, positioned by the anchor mapping. */
  private schedulePcm(channelData: Float32Array<ArrayBuffer>[], sampleRate: number, ts: number) {
    const ctx = this.ctx;
    const gain = this.gain;
    if (!ctx || !gain || channelData.length === 0) return;
    if (ts < this.minAcceptedTs) return;

    const buffer = ctx.createBuffer(channelData.length, channelData[0].length, sampleRate);
    for (let ch = 0; ch < channelData.length; ch++) buffer.copyToChannel(channelData[ch], ch);

    const startAt = this.anchorCtx + (ts - this.anchorMedia) / this.rate;
    const now = ctx.currentTime;
    const durationCtx = buffer.duration / this.rate;
    if (startAt + durationCtx <= now) {
      this.stats.dropped++; // decoded too late to be heard
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.rate;
    source.connect(gain);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    if (startAt < now) {
      source.start(now, (now - startAt) * this.rate);
    } else {
      source.start(startAt);
    }
    this.sources.add(source);

    if (!this.gotFirstOutput) {
      this.gotFirstOutput = true;
      this.onStatus('playing');
    }
  }

  // --- video mirroring ----------------------------------------------------

  private onSeeked = () => {
    this.stats.seekedEvents++;
    this.stats.lastResync = `seeked@${this.video.currentTime.toFixed(1)}`;
    this.resync(this.video.currentTime);
  };

  private onRateChange = () => {
    if (!this.ctx) return;
    // Re-anchor at our own expected position so the rate change doesn't also
    // inject the video clock's jitter; the drift check catches real divergence.
    const media = this.expectedMedia();
    this.anchorMedia = media;
    this.anchorCtx = this.ctx.currentTime;
    this.rate = this.video.playbackRate || 1;
    for (const s of this.sources) s.playbackRate.value = this.rate;
  };

  private onVolumeChange = () => {
    if (this.gain) this.gain.gain.value = this.video.volume;
    // The native mute button would bring the original track back on top of
    // ours; keep the element muted while we own audio.
    if (!this.video.muted) this.video.muted = true;
  };

  // --- helpers ------------------------------------------------------------

  private expectedMedia() {
    if (!this.ctx) return this.video.currentTime;
    return this.anchorMedia + (this.ctx.currentTime - this.anchorCtx) * this.rate;
  }

  private stopSources() {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
        s.disconnect();
      } catch {
        // Not started yet or already ended.
      }
    }
    this.sources.clear();
  }

  private releaseWaiters() {
    if (this.queue.length < QUEUE_HIGH || this.abort?.signal.aborted) {
      const waiters = this.spaceWaiters;
      this.spaceWaiters = [];
      for (const w of waiters) w();
    }
  }

  private fail(detail: string) {
    this.stop();
    // After stop(), so the error isn't overwritten by its 'stopped' status.
    this.onStatus('error', detail);
  }

  /** Dev-only introspection for the browser test harness. */
  debugState() {
    return {
      ctxState: this.ctx?.state,
      ctxTime: this.ctx?.currentTime,
      anchorCtx: this.anchorCtx,
      anchorMedia: this.anchorMedia,
      rate: this.rate,
      expectedMedia: this.expectedMedia(),
      videoTime: this.video.currentTime,
      decodedUntil: this.decodedUntil,
      queued: this.queue.length,
      liveSources: this.sources.size,
      decodeQueue: this.decoder?.decodeQueueSize,
      decoderState: this.decoder?.state,
      ...this.stats,
    };
  }
}
