// Custom 404 for any route that doesn't match. Next.js renders this for both
// hard 404s (unknown paths) and for notFound() calls from server components.

import Link from "next/link";

export default function NotFound() {
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
        <h2 className="text-base font-bold text-emerald-50 mb-2">Page Not Found</h2>
        <p className="text-xs text-slate-400 leading-relaxed mb-4">
          The page you&apos;re looking for doesn&apos;t exist. Head back to{" "}
          <a href="https://doublecheckff.com" className="text-emerald-400 hover:text-emerald-300">
            doublecheckff.com
          </a>{" "}
          to generate a schedule.
        </p>
        <Link
          href="/"
          className="inline-block bg-gradient-to-br from-emerald-600 to-emerald-700 text-emerald-50 border-0 px-5 py-2.5 rounded-md text-[13px] font-semibold cursor-pointer hover:from-emerald-500 hover:to-emerald-600"
        >
          Back to DoubleCheck
        </Link>
      </div>
    </div>
  );
}
