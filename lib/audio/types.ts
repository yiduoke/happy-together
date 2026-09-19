export type AudioContainer = 'mp4' | 'mkv';

export type AudioCodecId = 'aac' | 'opus';

export interface AudioTrackInfo {
  /** Track id inside its container (MP4 track_id / Matroska TrackNumber). */
  id: number;
  label: string;
  /** Null when the browser can't decode this codec — shown but not selectable. */
  codec: AudioCodecId | null;
  /** Human-readable codec name, for the "unsupported" hint. */
  codecName: string;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig for AAC, OpusHead for Opus. */
  description?: Uint8Array;
}

/** One compressed frame from the demuxer, timestamps in seconds. */
export interface EncodedAudioFrame {
  data: Uint8Array;
  timestamp: number;
  duration: number;
}

export function containerOf(fileName: string): AudioContainer | null {
  if (/\.(mkv|webm)$/i.test(fileName)) return 'mkv';
  if (/\.(mp4|m4v|mov)$/i.test(fileName)) return 'mp4';
  return null;
}
