"use client";

import { useEffect } from "react";

/**
 * Keeps the screen from sleeping/dimming while the calling component is
 * mounted. The browser releases the lock whenever the tab goes into the
 * background (e.g. a visibility change), so this re-acquires it on every
 * "visible" transition — silently, since the coach glancing at the sideline
 * screen shouldn't ever see this fail. Unsupported browsers (no Wake Lock
 * API) just no-op.
 */
export function useWakeLock() {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    async function acquire() {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Non-fatal — e.g. low battery mode, or the tab isn't visible yet.
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && !cancelled) acquire();
    }

    acquire();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      sentinel?.release().catch(() => {});
    };
  }, []);
}
