import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regenerating the lockfile with npm < 11.11.0 strips the `libc` field from
// the Linux native optional entries that declare one (this bit PR #22, whose
// review restored them). Without `libc`, npm can't tell the glibc and musl
// variants apart when installing from the lockfile and installs both on
// Linux. If this suite fails after a dep bump, restore the fields (regenerate
// with npm >= 11.11.0) rather than loosening the test. Delete the test once
// everything that regenerates the lockfile runs npm >= 11.11.0.
//
// The guard covers the @next/swc (since Next 16.2.10), @rolldown/binding,
// and lightningcss families, whose Linux builds pair a -gnu and a -musl
// entry - hence the exact suffix match, which also skips their -gnueabihf
// builds. @unrs and @tailwindcss/oxide legitimately lack `libc`; @img/sharp
// publishes it too but names its variants -linux-* / -linuxmusl-*, and the
// three guarded families already catch a stripping npm.
const LIBC_ENTRY =
  /^node_modules\/(?:@next\/swc|@rolldown\/binding|lightningcss)-linux-[^/]+-(?:gnu|musl)$/;

describe("package-lock.json libc metadata", () => {
  const { packages } = JSON.parse(
    readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"),
  ) as { packages: Record<string, { libc?: string[] }> };

  const entries = Object.keys(packages).filter((key) => LIBC_ENTRY.test(key));

  it("finds the Linux gnu/musl native entries", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s keeps its libc field", (key) => {
    expect(packages[key]?.libc).toEqual([
      key.endsWith("-musl") ? "musl" : "glibc",
    ]);
  });
});
