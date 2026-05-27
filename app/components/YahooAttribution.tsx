type YahooAttributionProps = {
  className?: string;
};

// Per Yahoo Fantasy Sports API terms, surfaces using Yahoo data must display
// the Yahoo Fantasy logo unmodified (no recolor, rotation, disproportionate
// resize, or co-branding) alongside a "Fantasy data provided by Yahoo Fantasy"
// credit that links back to Yahoo Fantasy. Parent gates rendering on platform.
export function YahooAttribution({ className }: YahooAttributionProps) {
  return (
    <div
      className={`flex flex-col items-center gap-1.5 ${className ?? ""}`.trim()}
    >
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/yahoo-fantasy.svg"
          alt="Yahoo Fantasy"
          height={60}
          style={{ height: 60, width: "auto" }}
        />
      </div>
      <p className="text-[11px] text-slate-400">
        Fantasy data provided by{" "}
        <a
          href="https://sports.yahoo.com/fantasy/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-300 underline hover:text-slate-200"
        >
          Yahoo Fantasy
        </a>
      </p>
    </div>
  );
}
