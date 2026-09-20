"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { pollAction } from "./actions";

/** Poll interval while an account sync is running, and otherwise (price refresh). */
const SYNCING_POLL_MS = 3_000;
const IDLE_POLL_MS = 45_000;

/**
 * Keeps the page current without WebSockets: polls the server (which refreshes
 * prices when due — never the account history) and re-renders when account
 * data or prices changed. Paused while the tab is hidden.
 */
export function LiveRefresh({ stamp, syncing }: { stamp: string; syncing: boolean }) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const s = await pollAction();
        if (!cancelled && s.stamp !== stamp) router.refresh();
      } catch {
        // Offline or server restarting: try again on the next tick.
      }
    };
    const id = setInterval(tick, syncing ? SYNCING_POLL_MS : IDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stamp, syncing, router]);
  return null;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} sec ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleString();
}

/** "2 min ago", kept current on the client; exact time on hover. */
export function Ago({ iso }: { iso: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);
  if (!iso) return <span>never</span>;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{now === null ? new Date(iso).toLocaleString() : ago(iso, now)}</time>;
}
