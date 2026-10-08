export function generateCaseNumber(id: string, now: number) {
  return `CASE-${new Date(now).toISOString().slice(0, 10).replaceAll('-', '')}-${id.replaceAll('-', '').toUpperCase()}`;
}
