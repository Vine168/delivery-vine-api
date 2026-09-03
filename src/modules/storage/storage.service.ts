import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { FileVisibility } from '../../generated/prisma/enums.js';

export interface PutObjectInput {
  objectKey: string;
  body: Buffer;
  mimeType: string;
  visibility: FileVisibility;
  originalFilename?: string;
}

/**
 * The only place that knows about MinIO/S3.
 *
 * Two buckets, deliberately: a public one for avatars and vehicle photos, and a
 * private one for anything a driver would not want indexed — national IDs,
 * licences, proof-of-delivery photos, KHQR images. Private objects leave the
 * system only as short-lived presigned URLs minted per request.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: MinioClient;
  private readonly publicBucket: string;
  private readonly privateBucket: string;
  private readonly region: string;
  private readonly signedUrlTtl: number;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    const endPoint = this.config.getOrThrow<string>('storage.endpoint');
    const port = this.config.get<number>('storage.port', 9000);
    const useSSL = this.config.get<boolean>('storage.useSSL', false);

    this.client = new MinioClient({
      endPoint,
      port,
      useSSL,
      accessKey: this.config.getOrThrow<string>('storage.accessKey'),
      secretKey: this.config.getOrThrow<string>('storage.secretKey'),
      region: this.config.get<string>('storage.region', 'us-east-1'),
    });

    this.publicBucket = this.config.get<string>('storage.publicBucket', 'deliver-public');
    this.privateBucket = this.config.get<string>('storage.bucket', 'deliver');
    this.region = this.config.get<string>('storage.region', 'us-east-1');
    this.signedUrlTtl = this.config.get<number>('storage.signedUrlTtlSeconds', 900);
    this.publicBaseUrl = `${useSSL ? 'https' : 'http'}://${endPoint}:${port}`;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket(this.privateBucket, false);
    await this.ensureBucket(this.publicBucket, true);
  }

  bucketFor(visibility: FileVisibility): string {
    return visibility === FileVisibility.PUBLIC ? this.publicBucket : this.privateBucket;
  }

  async put(input: PutObjectInput): Promise<void> {
    const bucket = this.bucketFor(input.visibility);

    try {
      await this.client.putObject(bucket, input.objectKey, input.body, input.body.length, {
        'Content-Type': input.mimeType,
        ...(input.originalFilename
          ? { 'Content-Disposition': `inline; filename="${encodeURIComponent(input.originalFilename)}"` }
          : {}),
      });
    } catch (error) {
      this.logger.error(`Upload to ${bucket}/${input.objectKey} failed: ${String(error)}`);
      throw AppException.serviceUnavailable(ResponseCode.STORAGE_UNAVAILABLE, 'Could not store the file.');
    }
  }

  /**
   * A URL the client can fetch. Public objects get a stable URL; private ones
   * get a presigned URL that expires, so a leaked link stops working.
   */
  async urlFor(objectKey: string, visibility: FileVisibility): Promise<string> {
    if (visibility === FileVisibility.PUBLIC) {
      return `${this.publicBaseUrl}/${this.publicBucket}/${objectKey}`;
    }

    try {
      return await this.client.presignedGetObject(this.privateBucket, objectKey, this.signedUrlTtl);
    } catch (error) {
      this.logger.error(`Could not presign ${objectKey}: ${String(error)}`);
      throw AppException.serviceUnavailable(ResponseCode.STORAGE_UNAVAILABLE);
    }
  }

  async remove(objectKey: string, visibility: FileVisibility): Promise<void> {
    try {
      await this.client.removeObject(this.bucketFor(visibility), objectKey);
    } catch (error) {
      // Deleting storage is best effort: the database row is the record of
      // truth and a missing object must not fail the caller's request.
      this.logger.warn(`Could not remove ${objectKey}: ${String(error)}`);
    }
  }

  private async ensureBucket(bucket: string, publicRead: boolean): Promise<void> {
    try {
      const exists = await this.client.bucketExists(bucket);
      if (!exists) {
        await this.client.makeBucket(bucket, this.region);
        this.logger.log(`Created bucket ${bucket}`);
      }

      if (publicRead) {
        await this.client.setBucketPolicy(bucket, JSON.stringify(publicReadPolicy(bucket)));
      }
    } catch (error) {
      this.logger.error(`Storage bucket ${bucket} is not usable: ${String(error)}`);
    }
  }
}

/** Read-only access to objects, and nothing else — no listing, no writes. */
function publicReadPolicy(bucket: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  };
}
