import { strToU8, zipSync } from 'fflate';
import { exportCollectorLedger } from './collector-finance';
import type { Context } from './context';
import { financeRangeSchema } from './finance-contract';

const escapeXml = (value: string) =>
  value
    .split('')
    .filter(
      (c) => c.charCodeAt(0) >= 32 || [9, 10, 13].includes(c.charCodeAt(0)),
    )
    .join('')
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[c] ?? c,
    );
export function settlementWorkbook(
  rows: {
    receivedDate: string;
    agentCode: string;
    customerName: string;
    returnAmount: number;
  }[],
) {
  const data: (string | number)[][] = [
    ['日期', '代理/代號', '客戶', '金額', '類型'],
    ...rows.map((r) => [
      r.receivedDate.replaceAll('-', '/'),
      r.agentCode,
      r.customerName,
      r.returnAmount,
      '收',
    ]),
  ];
  return financialWorkbook(data);
}
export function financialWorkbook(data: (string | number)[][]) {
  const sheet = data
    .map(
      (row, index) =>
        `<row r="${index + 1}">${row
          .map((cell, col) => {
            const ref = `${String.fromCharCode(65 + col)}${index + 1}`;
            return typeof cell === 'number'
              ? `<c r="${ref}"><v>${cell}</v></c>`
              : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
          })
          .join('')}</row>`,
    )
    .join('');
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
      '_rels/.rels': strToU8(
        `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      'xl/workbook.xml': strToU8(
        `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="應回帳款" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="3" width="24" customWidth="1"/><col min="4" max="5" width="16" customWidth="1"/></cols><sheetData>${sheet}</sheetData></worksheet>`,
      ),
    },
    { level: 6 },
  );
}
export async function exportSettlements(context: Context, raw: unknown) {
  const range = financeRangeSchema.parse(raw);
  return exportCollectorLedger(context, {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
  });
}
