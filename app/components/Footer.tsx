// Shared site footer rendered at the bottom of every page-level view
// (homepage, shared schedule, error boundaries, 404). The `mt-auto` pins it to
// the viewport bottom inside the `min-h-dvh flex flex-col` page wrapper when
// content is short. No hooks, so it works in both server and client components.

export function Footer() {
  return (
    <footer className="max-w-[700px] mx-auto mt-auto pt-7 text-center text-[11px] text-slate-500">
      <a
        href="https://github.com/shahirtaj/doublecheck/issues"
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-slate-700 hover:text-slate-400 hover:decoration-slate-500"
      >
        Report a bug
      </a>
      <span className="mx-2">·</span>
      <a
        href="https://buymeacoffee.com/shahirtaj"
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-slate-700 hover:text-slate-400 hover:decoration-slate-500"
      >
        Buy me a coffee
      </a>
    </footer>
  );
}
