import { DEMO_MEDIA } from '@saasflare-dev/db/demo-cases';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';

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
  CASE_STORAGE_MODE?: string;
  SERVER_URL?: string;
  CASE_BUCKET?: R2Bucket;
}): PrivateCaseStorage {
  if (
    bindings.CASE_STORAGE_MODE === 'demo' &&
    /^http:\/\/localhost(?::\d+)?\/?$/.test(bindings.SERVER_URL ?? '')
  )
    return new DemoCaseStorage(bindings.CASE_BUCKET);
  if (bindings.CASE_STORAGE_MODE === 'r2' && bindings.CASE_BUCKET)
    return new R2CaseStorage(bindings.CASE_BUCKET);
  throw new Error('Private case storage is not configured.');
}
