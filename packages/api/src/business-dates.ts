import { businessToday, dateSchema } from './finance-contract';

export function telegramDate(text: string, today = businessToday()) {
  dateSchema.parse(today);
  const short = /^(\d{1,2})\/(\d{1,2})$/.exec(text.trim());
  if (!short) {
    const full = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text.trim());
    if (!full) throw new Error('INVALID_DATE');
    const value = dateSchema.parse(
      `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`,
    );
    if (value < today) throw new Error('DATE_IN_PAST');
    return value;
  }
  const suffix = `${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`;
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${suffix}`;
  // Validate the inferred year too (including leap-day rollover).
  return dateSchema.parse(`${candidate < today ? year + 1 : year}-${suffix}`);
}

export function financePeriod(
  period: 'today' | 'month' | 'previous',
  today = businessToday(),
) {
  dateSchema.parse(today);
  if (period === 'today') return { dateFrom: today, dateTo: today };
  if (period === 'month')
    return { dateFrom: `${today.slice(0, 7)}-01`, dateTo: today };
  const last = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0),
  )
    .toISOString()
    .slice(0, 10);
  return { dateFrom: `${last.slice(0, 7)}-01`, dateTo: last };
}
