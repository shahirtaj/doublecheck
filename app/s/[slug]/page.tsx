// Server component for /s/[slug]. Reads the saved share payload from Vercel KV
// and renders a read-only view of the schedule. Returns a friendly 404-style
// message if the slug is missing or the entry has expired.

import { kv } from "@vercel/kv";
import { SharedScheduleView } from "./SharedScheduleView";

type SharedPayload = {
  format: { teamCount: number; weekCount: number };
  leagueName?: string;
  teams: string[];
  schedule: {
    weeks: [number, number][][];
    doubledPairs: string[];
  };
};

function isValidPayload(v: unknown): v is SharedPayload {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  const format = obj.format as Record<string, unknown> | undefined;
  if (
    !format ||
    typeof format.teamCount !== "number" ||
    typeof format.weekCount !== "number"
  ) {
    return false;
  }
  if (obj.leagueName !== undefined && typeof obj.leagueName !== "string") return false;
  if (!Array.isArray(obj.teams)) return false;
  const schedule = obj.schedule as Record<string, unknown> | undefined;
  if (!schedule) return false;
  if (!Array.isArray(schedule.weeks)) return false;
  if (!Array.isArray(schedule.doubledPairs)) return false;
  return true;
}

function NotFoundView() {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto text-center">
      <h2 className="text-base font-bold text-emerald-50 mb-2">Link expired or not found</h2>
      <p className="text-xs text-slate-400 leading-relaxed">
        Shared schedules expire after 365 days. Ask whoever sent you the link to regenerate it
        at{" "}
        <a
          href="https://doublecheckff.com"
          className="text-emerald-400 hover:text-emerald-300"
        >
          doublecheckff.com
        </a>
        .
      </p>
    </div>
  );
}

export default async function SharePage({ params }: { params: { slug: string } }) {
  let data: unknown = null;
  try {
    data = await kv.get(`share:${params.slug}`);
  } catch {
    data = null;
  }

  return (
    <div className="min-h-screen px-4 py-6 text-slate-200 font-mono">
      <div className="text-center mb-7">
        <h1 className="text-xl sm:text-2xl font-extrabold text-emerald-50 uppercase tracking-tight">
          DoubleCheck
        </h1>
        <p className="text-[11px] text-slate-500 mt-1 tracking-wider">
          Fair schedules for fantasy football leagues
        </p>
      </div>

      {!isValidPayload(data) ? (
        <NotFoundView />
      ) : (
        <SharedScheduleView
          format={data.format}
          leagueName={data.leagueName}
          teams={data.teams}
          weeks={data.schedule.weeks}
          doubledPairs={data.schedule.doubledPairs}
        />
      )}
    </div>
  );
}
