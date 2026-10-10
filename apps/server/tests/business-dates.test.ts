import { financePeriod, telegramDate } from '@saasflare-dev/api/business-dates';
import {
  businessToday,
  generateSchedule,
  planCreateSchema,
} from '@saasflare-dev/api/finance-contract';
import { expect, it } from 'vitest';

it('business date presets handle today, month start, year boundary and Taipei midnight', () => {
  expect(financePeriod('today', '2026-10-10')).toEqual({
    dateFrom: '2026-10-10',
    dateTo: '2026-10-10',
  });
  expect(financePeriod('month', '2026-10-01')).toEqual({
    dateFrom: '2026-10-01',
    dateTo: '2026-10-01',
  });
  expect(financePeriod('previous', '2027-01-01')).toEqual({
    dateFrom: '2026-12-01',
    dateTo: '2026-12-31',
  });
  expect(businessToday(new Date('2026-10-09T16:01:00Z'))).toBe('2026-10-10');
});
it.each([
  ['10/20', '2026-10-20'],
  ['12/31', '2026-12-31'],
  ['1/10', '2027-01-10'],
  ['9/20', '2027-09-20'],
  ['10/10', '2026-10-10'],
  ['2027/1/10', '2027-01-10'],
])('parses %s without guessing invalid dates', (input, expected) =>
  expect(telegramDate(input, '2026-10-10')).toBe(expected));
it.each([
  '2/30',
  '4/31',
  '13/1',
  '0/10',
  '1/0',
])('rejects invalid %s', (input) =>
  expect(() => telegramDate(input, '2026-10-10')).toThrow());
it('preserves preferred monthly 31st across February and accepts explicit custom schedules', () => {
  const input = planCreateSchema.parse({
    caseId: 'fictional',
    planType: 'monthly',
    firstPaymentDate: '2027-01-31',
    dayOfMonth: 31,
    totalAmount: 20000,
    perPaymentAmount: 5000,
  });
  expect(generateSchedule(input, '2026-10-10').map((s) => s.dueDate)).toEqual([
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
    '2027-04-30',
  ]);
  const custom = planCreateSchema.parse({
    caseId: 'fictional',
    planType: 'custom',
    totalAmount: 8000,
    schedules: [
      { dueDate: '2026-10-20', expectedAmount: 3000 },
      { dueDate: '2026-11-10', expectedAmount: 5000 },
    ],
  });
  expect(generateSchedule(custom, '2026-10-10')).toHaveLength(2);
});
