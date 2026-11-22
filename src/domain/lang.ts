/**
 * Normalization of the optional ISO 639-1 output language (`lang`).
 * Moved here from infrastructure/inbound/http.ts (phase 1B) — the HTTP adapter keeps
 * only the routing.
 */

/** Normalize the optional ISO 639-1 output language; null when invalid. */
export function normalizeLang(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return 'en';
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : null;
}
