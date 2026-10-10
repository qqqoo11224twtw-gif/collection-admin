import { ORPCError } from '@orpc/server';

// Archived intake data remains readable; formal ingestion is permanently retired.
export function rejectRetiredIntake(): void {
  throw new ORPCError('FORBIDDEN', {
    message: 'INTAKE_DISABLED: 目前已改由後台建檔，此收件功能已停用。',
  });
}
