'use client';

import React from 'react';

/** Copies the room URL so it can be pasted to a friend. */
export function CopyLinkButton() {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — select-and-copy fallback
      window.prompt('Copy the room link:', window.location.href);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      className="lk-button"
      style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
      onClick={onCopy}
    >
      {copied ? 'Copied!' : 'Copy room link'}
    </button>
  );
}
