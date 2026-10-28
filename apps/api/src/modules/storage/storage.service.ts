import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

type StorageDriver = 'rustfs' | 'b2';

@Injectable()
export class StorageService implements OnModuleInit {
  private client!: S3Client;
  private bucket!: string;
  private publicBaseUrl: string | null = null;
  private uploadExpires!: number;
  private playbackExpires!: number;
  private imageExpires!: number;
  private driver!: StorageDriver;

  // Credenciais do B2 (para a API nativa)
  private b2KeyId!: string;
  private b2ApplicationKey!: string;
  private b2BucketId!: string;
  private b2DownloadUrl!: string;
  private b2AuthToken!: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const driver = (this.config.get<string>('STORAGE_DRIVER', 'rustfs') ??
      'rustfs') as StorageDriver;
    this.driver = driver;

    const isTest = this.config.get<string>('NODE_ENV') === 'test';

    if (driver === 'b2') {
      const endpoint = this.config.getOrThrow<string>('B2_MEDIA_ENDPOINT');
      const region = this.config.get<string>('B2_MEDIA_REGION', 'us-east-005');
      this.b2KeyId = this.config.getOrThrow<string>('B2_KEY_ID');
      this.b2ApplicationKey = this.config.getOrThrow<string>('B2_APPLICATION_KEY');

      this.bucket = this.config.getOrThrow<string>('B2_MEDIA_BUCKET');
      this.publicBaseUrl =
        this.config.get<string>('B2_IMAGE_PUBLIC_URL') ?? null;

      this.client = new S3Client({
        region,
        endpoint,
        credentials: { accessKeyId: this.b2KeyId, secretAccessKey: this.b2ApplicationKey },
        forcePathStyle: true,
      });

      // Só autentica no B2 se não for ambiente de teste
      if (!isTest) {
        await this.authorizeB2();
      }
    } else {
      const endpoint = this.config.getOrThrow<string>('S3_ENDPOINT');
      const region = this.config.get<string>('S3_REGION', 'us-east-1');
      const accessKeyId = this.config.getOrThrow<string>('S3_ACCESS_KEY');
      const secretAccessKey = this.config.getOrThrow<string>('S3_SECRET_KEY');
      const forcePathStyle =
        this.config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true';

      this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
      this.client = new S3Client({
        region,
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle,
      });
    }

    this.uploadExpires = parseInt(
      this.config.get<string>('SIGNED_URL_UPLOAD_EXPIRES', '900'),
      10,
    );
    this.playbackExpires = parseInt(
      this.config.get<string>('SIGNED_URL_PLAYBACK_EXPIRES', '300'),
      10,
    );
    this.imageExpires = parseInt(
      this.config.get<string>('SIGNED_URL_IMAGE_EXPIRES', '31536000'),
      10,
    );

    console.log(
      `   Storage: ${this.driver.toUpperCase()} • bucket: ${this.bucket}`,
    );
  }

  private async authorizeB2() {
    const auth = Buffer.from(`${this.b2KeyId}:${this.b2ApplicationKey}`).toString('base64');

    // 1. Autoriza a conta
    const authRes = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!authRes.ok) throw new Error(`B2 auth failed: ${authRes.statusText}`);
    const authData = await authRes.json();
    this.b2AuthToken = authData.authorizationToken;
    this.b2DownloadUrl = authData.apiInfo.storageApi.downloadUrl;

    // 2. Obtém o bucketId (necessário para o download authorization)
    const listRes = await fetch(`${authData.apiInfo.storageApi.bucketUrl}/b2api/v4/b2_list_buckets`, {
      method: 'POST',
      headers: {
        Authorization: this.b2AuthToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: authData.accountId, bucketName: this.bucket }),
    });
    if (!listRes.ok) throw new Error(`B2 list buckets failed: ${listRes.statusText}`);
    const listData = await listRes.json();
    if (!listData.buckets || listData.buckets.length === 0) {
      throw new Error(`B2 bucket '${this.bucket}' not found`);
    }
    this.b2BucketId = listData.buckets[0].bucketId;
  }

  getDriver(): StorageDriver {
    return this.driver;
  }

  getBucket(): string {
    return this.bucket;
  }

  async getUploadUrl(key: string, contentType: string): Promise<string> {
    if (!key) throw new Error('Key obrigatória');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: this.uploadExpires,
    });
  }

  async getPlaybackUrl(key: string): Promise<{ url: string; expiresAt: Date }> {
    if (!key) throw new Error('Key obrigatória');

    if (this.driver === 'b2') {
      // Gera um token de download via API nativa do B2
      const res = await fetch(`${this.b2DownloadUrl}/b2api/v4/b2_get_download_authorization`, {
        method: 'POST',
        headers: {
          Authorization: this.b2AuthToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucketId: this.b2BucketId,
          fileNamePrefix: key,
          validDurationInSeconds: this.playbackExpires,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`B2 download auth failed: ${err}`);
      }

      const data = await res.json();
      const token = data.authorizationToken;

      // Monta a URL de download (formato nativo do B2)
      const url = `${this.b2DownloadUrl}/file/${this.bucket}/${key}?Authorization=${token}`;

      return {
        url,
        expiresAt: new Date(Date.now() + this.playbackExpires * 1000),
      };
    }

    // Fallback para rustfs (SDK da AWS)
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.playbackExpires,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + this.playbackExpires * 1000),
    };
  }

  async getImageUrl(key: string): Promise<string> {
    if (!key) throw new Error('Key obrigatória');
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: this.imageExpires });
  }

  async objectExists(key: string): Promise<boolean> {
    if (!key) return false;
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    if (!key) return;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
