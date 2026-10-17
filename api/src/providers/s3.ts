import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ObjectStorage } from '../storage.js';

/** The one method of the AWS client we use, so tests can pass a fake. */
export interface S3Like { send(command: PutObjectCommand | GetObjectCommand): Promise<any> }

/** Stores objects in an S3 (or S3-compatible) bucket, encrypted at rest, under a fixed key prefix. */
export class S3Storage implements ObjectStorage {
  constructor(private readonly client: S3Like, private readonly bucket: string, private readonly prefix = '') {}

  private key(key: string) {
    if (!/^[a-z0-9/-]+$/i.test(key) || key.includes('..')) throw new Error('invalid storage key');
    return `${this.prefix}${key}`;
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }

  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
    if (!res.Body) throw new Error('missing object');
    return Buffer.from(await res.Body.transformToByteArray());
  }
}
