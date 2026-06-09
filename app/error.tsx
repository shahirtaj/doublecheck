"use client";

// Next.js App Router error boundary for the homepage. Catches client-side
// crashes in app/page.tsx (typically corrupt localStorage payloads after a
// schema change, or unexpected import-response shapes that slip past the
// route-handler guards). Reset both clears the saved state and asks Next.js
// to re-render the segment.

import { useEffect } from "react";
import Link from "next/link";
import { Footer } from "./components/Footer";

const STORAGE_KEY = "ff-rotational-scheduler";

export default function HomeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error] Client error:", error);
  }, [error]);

  function handleReset() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage may be unavailable; reset anyway.
    }
    reset();
  }

  return (
    <div className="min-h-dvh flex flex-col px-4 py-6 text-slate-200">
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
          DoubleCheck hit an unexpected error. Resetting will clear your saved
          league history and reload the page.
        </p>
        <button
          onClick={handleReset}
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

      <Footer />
    </div>
  );
}
