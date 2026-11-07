export interface VttCue {
  start: number;
  end: number;
  text: string;
}

function msToVtt(ms: number) {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(
    Math.floor((ms % 60000) / 1000),
  )}.${pad(Math.floor(ms % 1000), 3)}`;
}

/** Turns cues (in milliseconds) into a blob URL a <track> element can consume. */
export function cuesToVttUrl(cues: VttCue[]) {
  const body = cues
    .filter((c) => c.text)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`)
    .join('\n\n');
  return URL.createObjectURL(new Blob([`WEBVTT\n\n${body}`], { type: 'text/vtt' }));
}
