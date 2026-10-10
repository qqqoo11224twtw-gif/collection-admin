import type { Context } from './context';
/** Deprecated schedules are historical records. Case status no longer mutates them. */
export function closeTerminalInstallments(
  _context: Context,
  _caseId: string,
  _token: string,
) {
  return [] as D1PreparedStatement[];
}
