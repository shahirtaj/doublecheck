// Server component for /s/[slug]. Reads the saved share payload from Upstash
// Redis and renders a read-only view of the schedule. Returns a friendly
// 404-style message if the slug is missing or the entry has expired.

import { Redis } from "@upstash/redis";
import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { SharedScheduleView } from "./SharedScheduleView";

const redis = Redis.fromEnv();

type RivalryPlacement = {
  teamA: number;
  teamB: number;
  pinnedWeek: number | null;
  placedWeek: number;
};

type SharedPayload = {
  format: { teamCount: number; weekCount: number };
  leagueName?: string;
  seasonYear?: number;
  teams: string[];
  schedule: {
    weeks: [number, number][][];
    // Optional: home/away display assignments. Older share links predate
    // this field; SharedScheduleView falls back to weeks when absent.
    displayWeeks?: [number, number][][];
    doubledPairs: string[];
    // Optional: pre-v2 share links don't include this; treated as empty.
    rivalryPlacements?: RivalryPlacement[];
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
  if (
    obj.seasonYear !== undefined &&
    (typeof obj.seasonYear !== "number" || !Number.isInteger(obj.seasonYear))
  ) {
    return false;
  }
  if (!Array.isArray(obj.teams)) return false;
  const schedule = obj.schedule as Record<string, unknown> | undefined;
  if (!schedule) return false;
  if (!Array.isArray(schedule.weeks)) return false;
  if (!Array.isArray(schedule.doubledPairs)) return false;
  if (schedule.displayWeeks !== undefined && !Array.isArray(schedule.displayWeeks)) {
    return false;
  }
  if (schedule.rivalryPlacements !== undefined && !Array.isArray(schedule.rivalryPlacements)) {
    return false;
  }
  return true;
}

const getShareData = cache(async (slug: string): Promise<unknown> => {
  try {
    return await redis.get(`share:${slug}`);
  } catch {
    return null;
  }
});

export async function generateMetadata({
  params,
}: {
  // Next.js 15 makes params a Promise; awaiting a sync object is a no-op on 14
  // so this stays forward-compatible without a runtime branch.
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await getShareData(slug);
  const fallbackTitle = "DoubleCheck - Shared Schedule";
  const fallbackDescription = "View this shared fantasy football schedule on DoubleCheck";

  if (!isValidPayload(data)) {
    return {
      title: fallbackTitle,
      description: fallbackDescription,
      openGraph: {
        title: fallbackTitle,
        description: fallbackDescription,
        images: ["/og.png"],
      },
    };
  }

  const trimmedName = data.leagueName?.trim();
  const yearLabel = data.seasonYear ? `${data.seasonYear} ` : "";
  const title = trimmedName
    ? `DoubleCheck - ${trimmedName} ${yearLabel}Schedule`
    : fallbackTitle;
  const description = trimmedName
    ? `View the ${data.format.teamCount}-team / ${data.format.weekCount}-week schedule for ${trimmedName}`
    : fallbackDescription;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: ["/og.png"],
    },
  };
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

export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getShareData(slug);

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

      {!isValidPayload(data) ? (
        <NotFoundView />
      ) : (
        <SharedScheduleView
          format={data.format}
          leagueName={data.leagueName}
          seasonYear={data.seasonYear}
          teams={data.teams}
          weeks={data.schedule.weeks}
          displayWeeks={data.schedule.displayWeeks}
          doubledPairs={data.schedule.doubledPairs}
          rivalryPlacements={data.schedule.rivalryPlacements ?? []}
        />
      )}
    </div>
  );
}
