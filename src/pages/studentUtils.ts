/**
 * studentUtils.ts
 * Shared student search and display utilities.
 * Import from any page — no per-page logic needed.
 */

/**
 * Returns true if student matches the search query.
 * Searches: name (partial) + regno (partial)
 */
export function matchesStudentSearch(student: any, query: string): boolean {
  if (!query) return true;
  const raw = query.trim();
  if (!raw) return true;

  // R/r prefix -> search by regno
  if (/^r\d+$/i.test(raw)) {
    const num = raw.slice(1);
    const regno = student.regno ? String(student.regno) : '';
    return regno.includes(num);
  }

  // Pure number -> search by QCA ID
  if (/^\d+$/.test(raw)) {
    const qcaId = student.qca_id != null ? String(student.qca_id) : '';
    return qcaId.includes(raw);
  }

  // Otherwise -> search by name
  const q = raw.toLowerCase();
  return !!(student.name?.toLowerCase().includes(q));
}

/**
 * Returns zero-padded regno string (3 digits).
 * e.g. regno "74" → "074", null/empty → "000"
 */
export function formatRegno(regno: string | null | undefined): string {
  if (!regno) return '000';
  const n = parseInt(regno);
  return isNaN(n) ? regno : String(n).padStart(3, '0');
}

/**
 * Reg no for display: "74" → "074". Non-numeric reg nos (e.g. club members)
 * are shown as-is; empty or placeholder values ("—") give "".
 * Unlike formatRegno, never returns "000" or "NaN".
 */
export function fmtRegNo(regno: string | number | null | undefined): string {
  const t = String(regno ?? '').trim();
  if (!t || t === '—' || t === '-') return '';
  const n = parseInt(t, 10);
  return isNaN(n) ? t : String(n).padStart(3, '0');
}

/**
 * Sorts students by regno numerically, nulls last, then by id.
 */
export function sortByRegno(students: any[]): any[] {
  return [...students].sort((a, b) => {
    const an = a.regno ? parseInt(a.regno) : null;
    const bn = b.regno ? parseInt(b.regno) : null;
    if (an === null && bn === null) return (a.id ?? 0) - (b.id ?? 0);
    if (an === null) return 1;
    if (bn === null) return -1;
    return an - bn;
  });
}
