type Props = {
  name: string; // league name; may be empty/whitespace
  yearLabel: string; // e.g. "2026 " (trailing space) or "" when no year
  fallback: string; // rendered when name is empty
  className?: string; // caller supplies size/color/margin
};

export function ScheduleHeading({
  name,
  yearLabel,
  fallback,
  className,
}: Props) {
  const trimmed = name.trim();
  return (
    <h2 className={`${className ?? ""} min-w-0 break-words`.trim()}>
      {trimmed ? (
        <>
          {trimmed}{" "}
          <span className="whitespace-nowrap">{yearLabel}Schedule</span>
        </>
      ) : (
        fallback
      )}
    </h2>
  );
}
