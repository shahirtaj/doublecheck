import type { ImportStatus } from "./types";

const PRIMARY_BTN_BASE =
  "border-0 px-5 py-2.5 rounded-md text-[13px] font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const NAV_BTN_BASE =
  "px-3.5 py-1.5 rounded-md text-xs cursor-pointer disabled:cursor-not-allowed disabled:opacity-40";

// Tailwind class atoms (mirrors the prototype's S object).
export const cls = {
  primaryBtnBase: PRIMARY_BTN_BASE,
  primaryBtn: `${PRIMARY_BTN_BASE} bg-gradient-to-br from-emerald-600 to-emerald-700 text-emerald-50 hover:from-emerald-500 hover:to-emerald-600`,
  secondaryBtn:
    "bg-transparent text-slate-400 border border-slate-600 px-4 py-2.5 rounded-md text-[13px] cursor-pointer hover:border-slate-500 hover:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed",
  navBtn: NAV_BTN_BASE,
  dangerBtn: `${NAV_BTN_BASE} bg-red-600 text-emerald-50 font-semibold hover:bg-red-500`,
  cancelBtn: `${NAV_BTN_BASE} bg-transparent border border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300`,
  rowDangerBtn:
    "bg-red-600 text-emerald-50 text-[10px] font-semibold px-1.5 py-0.5 border-0 rounded cursor-pointer hover:bg-red-500",
  rowCancelBtn:
    "bg-transparent text-[10px] text-slate-400 px-1.5 py-0.5 border border-slate-600 hover:border-slate-500 rounded cursor-pointer",
  rowOutlineRed:
    "bg-transparent text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 border border-red-700 hover:border-red-600 rounded cursor-pointer",
  outlineBtn:
    "bg-transparent border px-4 py-2.5 rounded-md text-[13px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
  outlineEmerald:
    "border-emerald-700 text-emerald-400 hover:border-emerald-600 hover:text-emerald-300",
  outlineRed:
    "border-red-700 text-red-400 hover:border-red-600 hover:text-red-300",
  card: "bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-[700px] mx-auto",
  cardTitle: "text-base font-bold text-emerald-50 mb-1.5",
  hint: "text-xs text-slate-400 leading-relaxed mb-3",
  subSection: "bg-slate-900 border border-slate-700 rounded-lg p-3.5 mb-3",
  sectionTitle: "text-[13px] font-bold text-slate-200 mb-1.5",
  teamInput:
    "flex-1 bg-transparent border-0 outline-none text-slate-200 text-[13px] py-1",
  error: "text-red-400 text-xs mt-3",
  leagueInput:
    "flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2.5 py-2 text-[13px] text-slate-200 outline-none focus:border-slate-500",
};

export function statusToneClass(status: ImportStatus): string {
  if (status === "error") return "text-red-400";
  if (status === "ready") return "text-emerald-400";
  return "text-slate-400";
}
