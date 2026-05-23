"use client";

// Error boundary for /s/[slug]. Catches client-side crashes when rendering a
// shared schedule (typically a malformed payload that slipped past the
// isValidPayload guard, or an unexpected runtime error in SharedScheduleView).
// Reset asks Next.js to re-render the segment. No localStorage clear here —
// the share page is read-only and doesn't write to local state.

import { useEffect } from "react";
import Link from "next/link";

export default function SharedScheduleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/s/[slug]/error] Client error:", error);
  }, [error]);

  return (
    <div className="min-h-screen px-4 py-6 text-slate-200 font-mono">
      <div className="text-center mb-7">
        <h1 className="text-xl sm:text-2xl font-extrabold text-emerald-50 uppercase tracking-tight">
          <Link href="/">DoubleCheck</Link>
        </h1>
        <p className="text-[11px] text-emerald-400 mt-1 tracking-wider">
          Fair schedules for fantasy football leagues
        </p>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto text-center">
        <h2 className="text-base font-bold text-emerald-50 mb-2">
          Something went wrong
        </h2>
        <p className="text-xs text-slate-400 leading-relaxed mb-4">
          We couldn&apos;t load this shared schedule. Try resetting, or ask
          whoever sent you the link to regenerate it at{" "}
          <a
            href="https://doublecheckff.com"
            className="text-emerald-400 hover:text-emerald-300"
          >
            doublecheckff.com
          </a>
          .
        </p>
        <button
          onClick={reset}
          className="bg-gradient-to-br from-emerald-600 to-emerald-700 text-emerald-50 border-0 px-5 py-2.5 rounded-md text-[13px] font-semibold cursor-pointer hover:from-emerald-500 hover:to-emerald-600"
        >
          Reset
        </button>
        {error.digest && (
          <p className="text-[10px] text-slate-600 mt-4">
            Error ID: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
