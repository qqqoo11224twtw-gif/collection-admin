import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';

const statuses = [
  'pending',
  'assigned',
  'follow_up',
  'installment',
  'settled',
  'unresolved',
] as const;
const sources = [
  'manual',
  'poster_builder',
  'telegram_ai',
  'historical_import',
] as const;
const names = [
  '示範星河',
  '示範星河',
  '示範雲杉',
  '示範月石',
  '示範晴島',
  '示範青禾',
];
export const DEMO_AGENT_ID = 'demo-agent';
export const DEMO_CASES = Array.from({ length: 18 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  const createdAt = Date.UTC(2026, 9, 1, 8) + index * 3600000;
  return {
    id: `demo-case-${number}`,
    caseNo: `DEMO-2026-${number}`,
    code: `DEMO-${number}`,
    customerName: names[index % names.length],
    address: `虛構市示範區測試路 ${index + 1} 號（非真實地址）`,
    amountDue: (index + 1) * 1250,
    status: statuses[index % statuses.length],
    revisitStatus:
      index % 3 === 0
        ? ('recommended' as const)
        : index % 3 === 1
          ? ('pending' as const)
          : ('not_required' as const),
    revisitReason: index % 3 === 0 ? '僅供示範：建議確認聯絡時間。' : '',
    source: sources[index % sources.length],
    assignedAgentId: index % 3 === 0 ? DEMO_AGENT_ID : null,
    createdAt,
    updatedAt: createdAt + 3600000,
  };
});
export const DEMO_MEDIA = DEMO_CASES.slice(0, 6).flatMap((record, index) =>
  Array.from({ length: index % 2 === 0 ? 3 : 1 }, (_, order) => ({
    id: `${record.id}-media-${order + 1}`,
    caseId: record.id,
    storageKey: `demo/${record.id}/image-${order + 1}.png`,
    originalFilename: `demo-document-${index + 1}-${order + 1}.png`,
    mediaType: 'image/png' as const,
    sortOrder: order + 1,
    sha256: DEMO_IMAGES[order % DEMO_IMAGES.length].sha256,
    createdAt: record.createdAt + order * 1000,
    fixture: order % DEMO_IMAGES.length,
  })),
);
