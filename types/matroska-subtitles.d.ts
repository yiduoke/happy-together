declare module 'matroska-subtitles' {
  import { Writable } from 'stream';

  export interface MatroskaTrack {
    number: number;
    language?: string;
    name?: string;
    type?: string;
  }

  export interface MatroskaSubtitle {
    text: string;
    time: number;
    duration?: number;
  }

  export class SubtitleParser extends Writable {
    once(event: 'tracks', listener: (tracks: MatroskaTrack[]) => void): this;
    on(event: 'tracks', listener: (tracks: MatroskaTrack[]) => void): this;
    on(
      event: 'subtitle',
      listener: (subtitle: MatroskaSubtitle, trackNumber: number) => void,
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class SubtitleParserBase extends Writable {}
}
