'use client';

import * as React from 'react';
import { RoomEvent, Track } from 'livekit-client';
import {
  CarouselLayout,
  ConnectionStateToast,
  LayoutContextProvider,
  RoomAudioRenderer,
  formatChatMessageLinks,
  useCreateLayoutContext,
  useTracks,
} from '@livekit/components-react';
import { Chat, ControlBar, GridLayout, useChat } from '@livekit/components-react';
import { playDing } from './ding';
import { SelfTile } from './SelfTile';

/**
 * Conference sidebar built for a narrow column: webcam tiles stacked on top,
 * chat below (tiles stay visible while chatting), icon-only controls at the
 * bottom. Replaces the stock VideoConference prefab, whose layout assumes it
 * owns the whole window.
 *
 * In `webcamOnly` mode it does own the whole window: the film is hidden and
 * the tiles spread into a grid, for talking to each other once the film has
 * finished.
 */
// Mirrors WidgetState from @livekit/components-core (not a direct dependency)
type WidgetState = { showChat: boolean; unreadMessages: number; showSettings?: boolean };

export function Sidebar(props: {
  SettingsComponent?: React.ComponentType;
  webcamOnly?: boolean;
  onToggleWebcamOnly?: () => void;
}) {
  const [widgetState, setWidgetState] = React.useState<WidgetState>({
    showChat: false,
    unreadMessages: 0,
    showSettings: false,
  });
  const layoutContext = useCreateLayoutContext();

  // Ding on incoming messages (not our own)
  const { chatMessages } = useChat();
  const seenCount = React.useRef(0);
  React.useEffect(() => {
    const fresh = chatMessages.slice(seenCount.current);
    seenCount.current = chatMessages.length;
    if (fresh.some((m) => m.from && !m.from.isLocal)) {
      playDing();
    }
  }, [chatMessages]);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );

  return (
    <LayoutContextProvider value={layoutContext} onWidgetChange={setWidgetState}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          position: 'relative',
        }}
      >
        {/* Webcam tiles — shrink but stay visible while chat is open */}
        <div
          style={{
            flex: widgetState.showChat && !props.webcamOnly ? '0 0 35%' : 1,
            minHeight: 0,
            display: 'flex',
          }}
        >
          {props.webcamOnly ? (
            <GridLayout tracks={tracks}>
              <SelfTile />
            </GridLayout>
          ) : (
            <CarouselLayout tracks={tracks} orientation="vertical">
              <SelfTile />
            </CarouselLayout>
          )}
        </div>
        {/* Chat stays mounted so history survives toggling */}
        <Chat
          style={{
            display: widgetState.showChat ? 'grid' : 'none',
            flex: props.webcamOnly ? '0 0 320px' : 1,
            minHeight: 0,
            width: '100%',
          }}
          messageFormatter={formatChatMessageLinks}
        />
        {/* Wraps onto a second line in a narrow column: the stock control bar
            alone already fills ~260px, and a clipped button is the problem
            we're fixing, not one to add. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <ControlBar
            variation="minimal"
            controls={{ chat: true, settings: !!props.SettingsComponent }}
          />
          {props.onToggleWebcamOnly && (
            <button
              className="lk-button"
              onClick={props.onToggleWebcamOnly}
              title={
                props.webcamOnly ? 'Back to the film' : 'Hide the film and just talk (Esc to exit)'
              }
              style={{ whiteSpace: 'nowrap', fontSize: 12 }}
            >
              {props.webcamOnly ? '🎬 Film' : '💬 Just chat'}
            </button>
          )}
        </div>
        {props.SettingsComponent && (
          <div
            className="lk-settings-menu-modal"
            style={{ display: widgetState.showSettings ? 'block' : 'none' }}
          >
            <props.SettingsComponent />
          </div>
        )}
      </div>
      <RoomAudioRenderer />
      <ConnectionStateToast />
    </LayoutContextProvider>
  );
}
