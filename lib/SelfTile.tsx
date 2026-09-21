'use client';

import * as React from 'react';
import { Track } from 'livekit-client';
import { ParticipantTile, TrackToggle, useMaybeTrackRefContext } from '@livekit/components-react';

/**
 * A participant tile that carries the mic and camera toggles on your own feed.
 *
 * The shared ControlBar lives at the foot of the sidebar, so collapsing the
 * sidebar takes the mute button with it — leaving no way to mute yourself
 * without expanding it again. Hanging the toggles on the tile keeps them
 * wherever your own picture is, in the sidebar or full screen.
 */
export function SelfTile() {
  const trackRef = useMaybeTrackRefContext();
  const isLocal = trackRef?.participant.isLocal ?? false;

  // The wrapper takes the place the tile used to occupy in the grid/carousel,
  // so ht-tile-wrap hands the tile's sizing back to it (see globals.css).

  return (
    <div className="ht-tile-wrap">
      <ParticipantTile />
      {isLocal && (
        <div
          style={{
            position: 'absolute',
            left: 6,
            bottom: 6,
            display: 'flex',
            gap: 4,
            padding: 3,
            borderRadius: 6,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)',
            // The tile underneath handles its own clicks (focus, pin).
            zIndex: 2,
          }}
        >
          <TrackToggle source={Track.Source.Microphone} showIcon />
          <TrackToggle source={Track.Source.Camera} showIcon />
        </div>
      )}
    </div>
  );
}
