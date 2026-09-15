declare module 'mp4box' {
  export interface MP4Sample {
    number: number;
    track_id: number;
    timescale: number;
    dts: number;
    cts: number;
    duration: number;
    is_sync: boolean;
    data: Uint8Array;
  }

  export interface MP4AudioTrackInfo {
    id: number;
    codec: string;
    language?: string;
    name?: string;
    nb_samples: number;
    audio?: { sample_rate: number; channel_count: number };
  }

  export interface MP4Info {
    audioTracks: MP4AudioTrackInfo[];
    videoTracks: unknown[];
  }

  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onSamples?: (track_id: number, user: unknown, samples: MP4Sample[]) => void;
    onError?: (e: string) => void;
    appendBuffer(data: ArrayBuffer & { fileStart: number }): number;
    start(): void;
    stop(): void;
    flush(): void;
    seek(time: number, useRap?: boolean): { offset: number; time: number };
    setExtractionOptions(track_id: number, user?: unknown, options?: { nbSamples?: number }): void;
    getTrackById(id: number): {
      mdia: {
        minf: {
          stbl: {
            stsd: {
              entries: Array<{
                esds?: { esd: { descs: Array<{ descs: Array<{ data: Uint8Array }> }> } };
              }>;
            };
          };
        };
      };
    };
  }

  export function createFile(): MP4File;
}
