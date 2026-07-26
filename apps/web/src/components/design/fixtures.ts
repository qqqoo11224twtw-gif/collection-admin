/**
 * Fixtures for the /design reference pages. Entirely invented — no real
 * customer, account or transaction data belongs in this template.
 *
 * The *shape* is deliberately realistic: seven columns, a monospace id, a
 * right-aligned amount spanning three orders of magnitude, and a mix of
 * statuses. Density problems only show up at realistic column counts and
 * value widths, so a toy two-column table would prove nothing.
 */

export type PaymentStatus = 'succeeded' | 'pending' | 'failed' | 'refunded';

export interface Payment {
  id: string;
  createdAt: string;
  customer: string;
  method: string;
  /** Minor units, negative for refunds. */
  amountCents: number;
  currency: string;
  status: PaymentStatus;
}

export const PAYMENTS: Payment[] = [
  {
    id: 'pay_8Kd92mQx',
    createdAt: '2026-07-27 14:32',
    customer: 'Northwind Traders',
    method: 'Visa ·· 4242',
    amountCents: 129900,
    currency: 'USD',
    status: 'succeeded',
  },
  {
    id: 'pay_7Jc81nRy',
    createdAt: '2026-07-27 13:07',
    customer: 'Globex Corporation',
    method: 'Wallet (USDC)',
    amountCents: 4200,
    currency: 'USD',
    status: 'pending',
  },
  {
    id: 'pay_6Hb70pSz',
    createdAt: '2026-07-27 11:54',
    customer: 'Initech',
    method: 'Mastercard ·· 5100',
    amountCents: 89000,
    currency: 'USD',
    status: 'succeeded',
  },
  {
    id: 'pay_5Ga69qTa',
    createdAt: '2026-07-27 09:21',
    customer: 'Umbrella Health',
    method: 'Visa ·· 1881',
    amountCents: -32500,
    currency: 'USD',
    status: 'refunded',
  },
  {
    id: 'pay_4Fz58rUb',
    createdAt: '2026-07-26 22:48',
    customer: 'Stark Industries',
    method: 'Wallet (USDC)',
    amountCents: 1450000,
    currency: 'USD',
    status: 'succeeded',
  },
  {
    id: 'pay_3Ey47sVc',
    createdAt: '2026-07-26 19:03',
    customer: 'Wayne Enterprises',
    method: 'Amex ·· 0005',
    amountCents: 76550,
    currency: 'USD',
    status: 'failed',
  },
  {
    id: 'pay_2Dx36tWd',
    createdAt: '2026-07-26 16:37',
    customer: 'Cyberdyne Systems',
    method: 'Visa ·· 4242',
    amountCents: 990,
    currency: 'USD',
    status: 'succeeded',
  },
  {
    id: 'pay_1Cw25uXe',
    createdAt: '2026-07-26 15:12',
    customer: 'Soylent Corp',
    method: 'Wallet (USDC)',
    amountCents: 250000,
    currency: 'USD',
    status: 'succeeded',
  },
  {
    id: 'pay_0Bv14vYf',
    createdAt: '2026-07-26 12:45',
    customer: 'Hooli',
    method: 'Mastercard ·· 5100',
    amountCents: 18075,
    currency: 'USD',
    status: 'pending',
  },
  {
    id: 'pay_9Au03wZg',
    createdAt: '2026-07-26 10:29',
    customer: 'Pied Piper',
    method: 'Visa ·· 9012',
    amountCents: 3299,
    currency: 'USD',
    status: 'succeeded',
  },
  {
    id: 'pay_8Zt92xAh',
    createdAt: '2026-07-25 23:58',
    customer: 'Vehement Capital',
    method: 'Wallet (USDC)',
    amountCents: 675000,
    currency: 'USD',
    status: 'succeeded',
  },
  {
    id: 'pay_7Ys81yBi',
    createdAt: '2026-07-25 20:14',
    customer: 'Massive Dynamic',
    method: 'Amex ·· 0005',
    amountCents: -12000,
    currency: 'USD',
    status: 'refunded',
  },
];

const AMOUNT_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Renders minor units as a signed decimal string, without the currency code. */
export function formatAmount(amountCents: number): string {
  return AMOUNT_FORMAT.format(amountCents / 100);
}

export const STATUS_LABEL: Record<PaymentStatus, string> = {
  succeeded: 'Succeeded',
  pending: 'Pending',
  failed: 'Failed',
  refunded: 'Refunded',
};
