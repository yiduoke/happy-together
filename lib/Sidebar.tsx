'use client';

import * as React from 'react';
import { RoomEvent, Track } from 'livekit-client';
import {
  CarouselLayout,
  ConnectionStateToast,
  LayoutContextProvider,
  ParticipantTile,
  RoomAudioRenderer,
  formatChatMessageLinks,
  useCreateLayoutContext,
  useTracks,
} from '@livekit/components-react';
import { Chat, ControlBar, useChat } from '@livekit/components-react';
import { playDing } from './ding';

/**
 * Conference sidebar built for a narrow column: webcam tiles stacked on top,
 * chat below (tiles stay visible while chatting), icon-only controls at the
 * bottom. Replaces the stock VideoConference prefab, whose layout assumes it
 * owns the whole window.
 */
// Mirrors WidgetState from @livekit/components-core (not a direct dependency)
type WidgetState = { showChat: boolean; unreadMessages: number; showSettings?: boolean };

export function Sidebar(props: { SettingsComponent?: React.ComponentType }) {
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
            flex: widgetState.showChat ? '0 0 35%' : 1,
            minHeight: 0,
            display: 'flex',
          }}
        >
          <CarouselLayout tracks={tracks} orientation="vertical">
            <ParticipantTile />
          </CarouselLayout>
        </div>
        {/* Chat stays mounted so history survives toggling */}
        <Chat
          style={{
            display: widgetState.showChat ? 'grid' : 'none',
            flex: 1,
            minHeight: 0,
            width: '100%',
          }}
          messageFormatter={formatChatMessageLinks}
        />
        <ControlBar
          variation="minimal"
          controls={{ chat: true, settings: !!props.SettingsComponent }}
        />
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
