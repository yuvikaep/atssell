import { get, put } from '@vercel/blob';
import type { ObjectStorage } from '../storage.js';

/** Stores objects as private blobs in the project's Vercel Blob store (token from BLOB_READ_WRITE_TOKEN). */
export class VercelBlobStorage implements ObjectStorage {
  constructor(private readonly token?: string, private readonly prefix = '') {}

  private key(key: string) {
    if (!/^[a-z0-9/-]+$/i.test(key) || key.includes('..')) throw new Error('invalid storage key');
    return `${this.prefix}${key}`;
  }

  async put(key: string, data: Buffer, contentType: string) {
    await put(this.key(key), data, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true, token: this.token });
  }

  async get(key: string) {
    const res = await get(this.key(key), { access: 'private', token: this.token });
    if (!res || res.statusCode !== 200) throw new Error('missing object');
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }
}
