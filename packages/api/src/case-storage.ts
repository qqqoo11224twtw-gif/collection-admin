import { DEMO_MEDIA } from '@saasflare-dev/db/demo-cases';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';

export interface PrivateCaseStorage {
  read(key: string): Promise<ArrayBuffer | null>;
}

export class DemoCaseStorage implements PrivateCaseStorage {
  async read(key: string) {
    const media = DEMO_MEDIA.find((item) => item.storageKey === key);
    if (!media) return null;
    return Uint8Array.from(atob(DEMO_IMAGES[media.fixture].base64), (char) =>
      char.charCodeAt(0),
    ).buffer;
  }
}

// No public domain, signed URL or S3 API key. Keep the bucket private.
export class R2CaseStorage implements PrivateCaseStorage {
  constructor(private readonly bucket: R2Bucket) {}
  async read(key: string) {
    const object = await this.bucket.get(key);
    return object ? object.arrayBuffer() : null;
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
    return new DemoCaseStorage();
  if (bindings.CASE_STORAGE_MODE === 'r2' && bindings.CASE_BUCKET)
    return new R2CaseStorage(bindings.CASE_BUCKET);
  throw new Error('Private case storage is not configured.');
}
