'use client';

import type { AudioTrackInfo } from './types';

/**
 * Plays a local file through MediaSource with the chosen audio track.
 *
 * The previous design decoded the alternate audio ourselves and played it
 * beside the picture, chasing `video.currentTime` to stay aligned. That is the
 * inverse of how real players work — VLC, mpv and Kodi make audio the master
 * clock and time the video to it — and chasing a clock we don't own meant
 * permanent drift, stalls and chop.
 *
 * Here the file is remuxed to fragmented MP4 and appended to one SourceBuffer,
 * so the browser decodes both streams and owns synchronisation exactly as it
 * does for any ordinary video. Codecs browsers refuse (AC-3, E-AC-3) are
 * re-encoded to AAC on the way through; remuxing alone wouldn't help, because
 * MSE rejects them too.
 *
 * Conversion is paced against the playhead. It runs at around a hundred times
 * realtime, so left alone it fills the SourceBuffer to its hard quota within
 * seconds — and a full buffer only drains as fast as the film plays, so every
 * later append fails and the converted range stops growing for good. Holding
 * the converter a fixed distance ahead keeps the buffer inside its quota and
 * the output off the heap.
 */

/** How far ahead of the viewer to convert before waiting for them. */
const LEAD_SECONDS = 120;
/** How much already-played media to keep, for short seeks backwards. */
const KEEP_BEHIND_SECONDS = 180;
/** What to fall back to when the buffer is full regardless. */
const MIN_BEHIND_SECONDS = 20;

export type MseStatus = 'preparing' | 'playing' | 'error' | 'stopped';

interface RunningConversion {
  cancel(): Promise<void>;
  execute(): Promise<unknown>;
  onProgress?: (p: number) => void;
}

export interface MsePlayerStats {
  bytes: number;
  mime: string;
  startMs: number;
  progress: number;
  startedAtMedia: number;
  /** Where playback should pick up again once the new source has data. */
  resumeAt: number;
  /** Conversions restarted because a seek landed outside the buffer. */
  restarts: number;
  /** How long the last such restart took to produce playable data. */
  lastRestartMs: number;
}

export class MsePlayer {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private conversion: RunningConversion | null = null;
  private stopped = false;
  private startedAt = 0;

  private mb: typeof import('mediabunny') | null = null;
  private file: File | null = null;
  private track: AudioTrackInfo | null = null;
  private onSeeking: (() => void) | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every restart. Chunks still in flight from the conversion we
   * just cancelled carry the old number and are dropped, so they can't be
   * appended after the timestampOffset has moved.
   */
  private generation = 0;

  readonly stats: MsePlayerStats = {
    bytes: 0,
    mime: '',
    startMs: 0,
    progress: 0,
    startedAtMedia: 0,
    resumeAt: 0,
    restarts: 0,
    lastRestartMs: 0,
  };

  constructor(
    private video: HTMLVideoElement,
    private onStatus: (status: MseStatus, detail?: string) => void,
  ) {}

  async start(file: File, track: AudioTrackInfo, duration: number) {
    this.stopped = false;
    this.startedAt = performance.now();
    // Read the playhead before anything awaits: loading the decoder takes
    // long enough for the element to be reset underneath us.
    const resumeAt = this.video.currentTime;
    const from = Math.max(0, resumeAt - 0.5);
    this.stats.startedAtMedia = from;
    this.stats.resumeAt = resumeAt;
    this.onStatus('preparing');

    this.file = file;
    this.track = track;

    const mb = await import('mediabunny');
    this.mb = mb;
    if (track.codec === 'ac3' || track.codec === 'eac3') {
      // The AC-3 family needs a decoder no browser ships.
      const { registerAc3Decoder } = await import('@mediabunny/ac3');
      registerAc3Decoder();
    }
    if (this.stopped) return;

    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.objectUrl = URL.createObjectURL(mediaSource);
    const opened = new Promise<void>((resolve) =>
      mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }),
    );
    this.video.src = this.objectUrl;
    await opened;
    if (this.stopped) return;

    try {
      mediaSource.duration = duration;
    } catch {
      // Some browsers refuse before the first buffer exists; harmless.
    }

    const mime = await this.beginConversion(from);
    if (this.stopped) return;
    this.stats.mime = mime;
    if (!MediaSource.isTypeSupported(mime)) {
      // Bump the generation so the writer stops waiting for a SourceBuffer
      // we're never going to create.
      this.generation++;
      this.onStatus('error', `browser can't play ${mime}`);
      return;
    }

    const sb = mediaSource.addSourceBuffer(mime);
    this.sourceBuffer = sb;
    // Converted output starts at zero; shift it back onto the film's timeline
    // so the room's play/pause/seek and the subtitles still line up.
    sb.timestampOffset = from;
    let restored = false;
    sb.addEventListener('updateend', () => {
      // Swapping src rewound the element; put the viewer back where they were
      // as soon as the converted stream has something to seek to.
      if (!restored && resumeAt > 0 && sb.buffered.length > 0) {
        restored = true;
        this.video.currentTime = resumeAt;
      }
    });

    // A seek away from what we've converted would otherwise stall forever:
    // the conversion only ever runs forwards from where it started, and
    // eviction keeps throwing away what's behind the playhead.
    this.onSeeking = () => this.handleSeek();
    this.video.addEventListener('seeking', this.onSeeking);

    this.stats.startMs = Math.round(performance.now() - this.startedAt);
    this.onStatus('playing');
  }

  /**
   * Convert from `at`, appending as it goes. Resolves with the output MIME
   * type, which is only known once the conversion is under way.
   */
  private async beginConversion(at: number): Promise<string> {
    const mb = this.mb!;
    const gen = this.generation;
    const input = new mb.Input({ source: new mb.BlobSource(this.file!), formats: mb.ALL_FORMATS });
    // Returning a promise from write() is what throttles the conversion:
    // mediabunny won't produce the next chunk until this one is in the buffer.
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.stopped || gen !== this.generation) return;
        this.stats.bytes += chunk.byteLength;
        await this.waitForRoom(gen);
        await this.append(chunk, gen);
      },
    });
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new mb.AppendOnlyStreamTarget(writable),
    });

    const conversion = (await mb.Conversion.init({
      input,
      output,
      trim: { start: at },
      // Keep only the chosen track: the browser can't pick for us.
      audio: (inputTrack: { id: number }) =>
        inputTrack.id === this.track!.id
          ? ({ codec: 'aac' } as const)
          : ({ discard: true } as const),
    })) as unknown as RunningConversion;
    if (this.stopped || gen !== this.generation) {
      await conversion.cancel().catch(() => {});
      return '';
    }
    this.conversion = conversion;
    conversion.onProgress = (p: number) => {
      this.stats.progress = p;
    };

    // getMimeType only resolves once the output knows its tracks, which
    // happens during execute — so start the conversion before asking.
    const running = conversion.execute();
    running
      .then(() => {
        if (gen === this.generation) this.drainThenEnd();
      })
      .catch((e: unknown) => {
        if (this.stopped || gen !== this.generation) return;
        this.onStatus('error', e instanceof Error ? e.message : 'conversion failed');
      });
    return output.getMimeType();
  }

  private handleSeek() {
    if (this.stopped || !this.sourceBuffer) return;
    if (this.buffered(this.video.currentTime)) return;
    // Dragging the scrubber fires this continuously; only act once the
    // target settles, or we'd restart the conversion on every pixel.
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.buffered(this.video.currentTime)) return;
      void this.restartAt(Math.max(0, this.video.currentTime - 0.2));
    }, 150);
  }

  private buffered(t: number) {
    const sb = this.sourceBuffer;
    if (!sb) return false;
    for (let i = 0; i < sb.buffered.length; i++) {
      // Leave a margin at the edge: sitting on the very end still stalls.
      if (t >= sb.buffered.start(i) && t < sb.buffered.end(i) - 0.2) return true;
    }
    return false;
  }

  /** Re-run the conversion from `at`, discarding what we have. */
  private async restartAt(at: number) {
    const sb = this.sourceBuffer;
    if (!sb || this.stopped) return;
    const began = performance.now();
    this.generation++;
    this.stats.restarts++;
    this.onStatus('preparing');

    try {
      await this.conversion?.cancel();
    } catch {
      // Already finished.
    }
    this.conversion = null;
    if (this.stopped) return;

    // Drop everything rather than juggling disjoint ranges against the
    // buffer quota: reconverting runs at ~100x realtime, so it's cheaper.
    try {
      if (sb.updating) sb.abort();
      if (sb.buffered.length > 0) await this.removeAll(sb);
    } catch {
      // A failed remove just means we keep the old range; harmless.
    }
    if (this.stopped) return;

    try {
      sb.timestampOffset = at;
    } catch {
      // Refused only while updating, which we've just waited out.
    }
    this.stats.startedAtMedia = at;
    await this.beginConversion(at);
    if (this.stopped) return;
    this.stats.lastRestartMs = Math.round(performance.now() - began);
    this.onStatus('playing');
  }

  private removeAll(sb: SourceBuffer) {
    return new Promise<void>((resolve) => {
      const done = () => {
        sb.removeEventListener('updateend', done);
        resolve();
      };
      sb.addEventListener('updateend', done);
      try {
        sb.remove(0, Infinity);
      } catch {
        done();
      }
    });
  }

  /** Hold the converter back until the viewer is within LEAD_SECONDS. */
  private async waitForRoom(gen: number) {
    while (!this.stopped && gen === this.generation && this.lead() > LEAD_SECONDS) {
      this.evictBehind(KEEP_BEHIND_SECONDS);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Seconds of converted media sitting ahead of the playhead. */
  private lead() {
    const sb = this.sourceBuffer;
    if (!sb || sb.buffered.length === 0) return 0;
    return sb.buffered.end(sb.buffered.length - 1) - this.video.currentTime;
  }

  /**
   * Append one chunk, resolving once it has landed. Waits for the
   * SourceBuffer to exist, since the first chunks arrive before we know the
   * MIME type — and it takes those chunks to work it out.
   */
  private append(chunk: Uint8Array, gen: number) {
    return new Promise<void>((resolve) => {
      const attempt = () => {
        if (this.stopped || gen !== this.generation) return resolve();
        const sb = this.sourceBuffer;
        if (!sb || sb.updating) {
          setTimeout(attempt, 20);
          return;
        }
        const done = () => {
          sb.removeEventListener('updateend', done);
          resolve();
        };
        try {
          sb.addEventListener('updateend', done);
          sb.appendBuffer(chunk as BufferSource);
        } catch (e) {
          sb.removeEventListener('updateend', done);
          if (e instanceof Error && e.name === 'QuotaExceededError') {
            // Pacing normally prevents this, but bitrate varies: give up the
            // seek-backwards margin and retry rather than stalling forever.
            this.evictBehind(MIN_BEHIND_SECONDS);
            setTimeout(attempt, 250);
            return;
          }
          this.onStatus('error', e instanceof Error ? e.message : 'append failed');
          resolve();
        }
      };
      attempt();
    });
  }

  private evictBehind(keepSeconds: number) {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || sb.buffered.length === 0) return;
    const start = sb.buffered.start(0);
    const cutoff = Math.max(start, this.video.currentTime - keepSeconds);
    if (cutoff > start) {
      try {
        sb.remove(start, cutoff);
      } catch {
        // Will be retried the next time round.
      }
    }
  }

  private drainThenEnd() {
    if (this.stopped) return;
    if (this.sourceBuffer?.updating) {
      setTimeout(() => this.drainThenEnd(), 50);
      return;
    }
    try {
      if (this.mediaSource?.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      // Already ended.
    }
  }

  /** Restore the element to the original file, keeping the position. */
  async stop(originalUrl: string | null) {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.onSeeking) {
      this.video.removeEventListener('seeking', this.onSeeking);
      this.onSeeking = null;
    }
    const at = this.video.currentTime;
    try {
      await this.conversion?.cancel();
    } catch {
      // Already finished.
    }
    this.conversion = null;
    this.sourceBuffer = null;
    this.mediaSource = null;
    if (originalUrl) {
      this.video.src = originalUrl;
      this.video.currentTime = at;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.onStatus('stopped');
  }

  debugState() {
    return { ...this.stats, lead: Math.round(this.lead()) };
  }
}
