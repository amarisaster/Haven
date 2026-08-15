// Parse a server timestamp safely.
//
// Haven's D1 stores times via SQLite `datetime('now')` → "YYYY-MM-DD HH:MM:SS" — UTC, but
// with NO timezone marker. A bare `new Date()` parses that zone-less string as LOCAL, so
// displayed times shift by the viewer's UTC offset on reload. (Optimistic sends use
// `toISOString()` with a trailing `Z`, so a just-sent message renders correctly until it's
// re-fetched from the server — which is the "the time changed when I came back" bug.)
//
// Fix: treat a zone-less server string as UTC. Strings that already carry a `Z` or a
// numeric ±hh:mm offset are trusted as-is.
export function parseServerDate(dateStr: string | null | undefined): Date {
  if (!dateStr) return new Date(NaN);
  const s = String(dateStr).trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s); // already has an explicit zone
  return new Date(s.replace(' ', 'T') + 'Z');                // zone-less → it's UTC
}
