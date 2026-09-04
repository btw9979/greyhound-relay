"use client";

import { useEffect } from "react";

/**
 * Best-effort defense-in-depth on top of the manifest's `orientation:
 * "portrait"` — the Screen Orientation Lock API is only available in a
 * fullscreen/standalone context in most browsers (and not at all in iOS
 * Safari home-screen apps), so this silently no-ops wherever it isn't.
 */
export function useOrientationLock() {
  useEffect(() => {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
    };
    orientation?.lock?.("portrait").catch(() => {});
  }, []);
}
