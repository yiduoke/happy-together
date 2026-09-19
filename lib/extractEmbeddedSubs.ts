'use client';

// Browsers never expose subtitle tracks embedded in local MKV files, so we
// parse the container ourselves: stream the file through an EBML parser and
// rebuild each text track as WebVTT.

export type ExtractedTrack = {
  label: string;
  vttUrl: string;
};

type Cue = { start: number; end: number; text: string };

function msToVtt(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(t, 3)}`;
}

// ASS/SSA dialogue carries `{\...}` style override blocks and \N line breaks.
function cleanText(text: string) {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/gi, '\n')
    .trim();
}

function cuesToVttUrl(cues: Cue[]) {
  const body = cues
    .filter((c) => c.text)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`)
    .join('\n\n');
  return URL.createObjectURL(new Blob([`WEBVTT\n\n${body}`], { type: 'text/vtt' }));
}

/**
 * Extract embedded subtitle tracks from an MKV file. Resolves with one VTT
 * object-URL per text track; resolves [] for non-MKV containers or files
 * without text tracks. onProgress reports 0..1 as the file streams through.
 */
export async function extractEmbeddedSubs(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<ExtractedTrack[]> {
  if (!/\.(mkv|webm)$/i.test(file.name)) return [];
  const { SubtitleParser } = await import('matroska-subtitles');

  return new Promise(async (resolve) => {
    const parser = new SubtitleParser();
    const cuesByTrack = new Map<number, Cue[]>();
    const labelByTrack = new Map<number, string>();
    let sawTracks = false;

    parser.once('tracks', (tracks: Array<{ number: number; language?: string; name?: string }>) => {
      sawTracks = true;
      for (const t of tracks) {
        labelByTrack.set(
          t.number,
          [t.name, t.language].filter(Boolean).join(' — ') || `Track ${t.number}`,
        );
        cuesByTrack.set(t.number, []);
      }
    });

    parser.on(
      'subtitle',
      (sub: { text: string; time: number; duration?: number }, trackNumber: number) => {
        cuesByTrack.get(trackNumber)?.push({
          start: sub.time,
          end: sub.time + (sub.duration ?? 3000),
          text: cleanText(sub.text),
        });
      },
    );

    const finish = () => {
      resolve(
        Array.from(cuesByTrack.entries())
          .filter(([, cues]) => cues.length > 0)
          .map(([num, cues]) => ({
            label: labelByTrack.get(num) || `Track ${num}`,
            vttUrl: cuesToVttUrl(cues),
          })),
      );
    };

    // The parser closes itself as soon as it sees a Tracks list with no text
    // subtitles. Writing to it then returns false forever and 'drain' never
    // fires, so every wait below must also unblock on the stream dying.
    let closed = false;
    const markClosed = () => {
      closed = true;
    };
    parser.on('finish', markClosed);
    parser.on('close', markClosed);
    parser.on('error', markClosed);

    const waitForCapacity = () =>
      new Promise<void>((resolveWait) => {
        const settle = () => {
          parser.off('drain', settle);
          parser.off('finish', settle);
          parser.off('close', settle);
          parser.off('error', settle);
          resolveWait();
        };
        parser.once('drain', settle);
        parser.once('finish', settle);
        parser.once('close', settle);
        parser.once('error', settle);
      });

    try {
      const reader = file.stream().getReader();
      let read = 0;
      for (;;) {
        // Bail before writing: a file whose only subtitles are bitmaps
        // (VobSub/PGS) declares no text tracks, and the parser is already gone.
        if (closed || (sawTracks && cuesByTrack.size === 0)) break;
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        onProgress?.(read / file.size);
        // The parser is a node-style Writable; respect backpressure so we
        // don't buffer the whole movie in memory.
        if (!parser.write(value)) await waitForCapacity();
      }
      reader.cancel().catch(() => {});
    } catch {
      // Fall through: whatever cues we already collected are still usable.
    } finally {
      try {
        if (!closed) parser.end();
      } catch {
        // Already ended.
      }
      finish();
    }
  });
}
