import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:py-24">
      <h1 className="text-3xl sm:text-4xl font-extrabold uppercase tracking-tight text-emerald-50">
        DoubleCheck
      </h1>
      <p className="mt-3 text-sm text-slate-400">
        Fair rotational schedules for fantasy football leagues.
      </p>
      <Link
        href="/generate"
        className="mt-8 inline-block rounded-md bg-gradient-to-br from-emerald-600 to-emerald-700 px-5 py-2.5 text-sm font-semibold text-emerald-50 hover:from-emerald-500 hover:to-emerald-600"
      >
        Generate a schedule →
      </Link>
    </main>
  );
}
