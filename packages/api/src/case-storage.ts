import { DEMO_MEDIA } from '@saasflare-dev/db/demo-cases';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import { systemLog } from './system-log';

export interface PrivateCaseStorage {
  read(key: string): Promise<ArrayBuffer | null>;
  write(key: string, bytes: ArrayBuffer, mediaType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class DemoCaseStorage implements PrivateCaseStorage {
  constructor(private readonly bucket?: R2Bucket) {}
  async read(key: string) {
    const stored = await this.bucket?.get(key);
    if (stored) return stored.arrayBuffer();
    const media = DEMO_MEDIA.find((item) => item.storageKey === key);
    if (!media) return null;
    return Uint8Array.from(atob(DEMO_IMAGES[media.fixture].base64), (char) =>
      char.charCodeAt(0),
    ).buffer;
  }
  async write(key: string, bytes: ArrayBuffer, mediaType: string) {
    if (!this.bucket) throw new Error('Missing local private storage');
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: mediaType },
    });
  }
  async delete(key: string) {
    if (!this.bucket) throw new Error('Missing local private storage');
    await this.bucket.delete(key);
  }
}

// No public domain, signed URL or S3 API key. Keep the bucket private.
export class R2CaseStorage implements PrivateCaseStorage {
  constructor(private readonly bucket: R2Bucket) {}
  async read(key: string) {
    const object = await this.bucket.get(key);
    return object ? object.arrayBuffer() : null;
  }
  async write(key: string, bytes: ArrayBuffer, mediaType: string) {
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: mediaType },
    });
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}

export function privateCaseStorage(bindings: {
  DB?: D1Database;
  CASE_STORAGE_MODE?: string;
  SERVER_URL?: string;
  CASE_BUCKET?: R2Bucket;
}): PrivateCaseStorage {
  const observed = (storage: PrivateCaseStorage): PrivateCaseStorage =>
    !bindings.DB
      ? storage
      : {
          async read(key) {
            try {
              const result = await storage.read(key);
              await systemLog(bindings.DB as D1Database, {
                category: 'storage',
                event: 'R2_READ_SUCCESS',
              });
              return result;
            } catch {
              await systemLog(bindings.DB as D1Database, {
                category: 'storage',
                event: 'R2_READ_FAILED',
                status: 'failed',
                level: 'error',
                errorCode: 'R2_READ_FAILED',
              });
              throw new Error('R2_READ_FAILED');
            }
          },
          async write(key, bytes, type) {
            try {
              await storage.write(key, bytes, type);
              await systemLog(bindings.DB as D1Database, {
                category: 'storage',
                event: 'R2_UPLOAD_SUCCESS',
              });
            } catch {
              await systemLog(bindings.DB as D1Database, {
                category: 'storage',
                event: 'R2_UPLOAD_FAILED',
                status: 'failed',
                level: 'error',
                errorCode: 'R2_UPLOAD_FAILED',
              });
              throw new Error('R2_UPLOAD_FAILED');
            }
          },
          async delete(key) {
            try {
              await storage.delete(key);
              await systemLog(bindings.DB as D1Database, {
                category: 'storage',
                event: 'R2_DELETE_SUCCESS',
              });
            } catch {
              await systemLog(bindings.DB as D1Database, {
                category: 'storage',
                event: 'R2_DELETE_FAILED',
                status: 'failed',
                level: 'error',
                errorCode: 'R2_DELETE_FAILED',
              });
              throw new Error('R2_DELETE_FAILED');
            }
          },
        };
  if (
    bindings.CASE_STORAGE_MODE === 'demo' &&
    /^http:\/\/localhost(?::\d+)?\/?$/.test(bindings.SERVER_URL ?? '')
  )
    return observed(new DemoCaseStorage(bindings.CASE_BUCKET));
  if (bindings.CASE_STORAGE_MODE === 'r2' && bindings.CASE_BUCKET)
    return observed(new R2CaseStorage(bindings.CASE_BUCKET));
  throw new Error('Private case storage is not configured.');
}
