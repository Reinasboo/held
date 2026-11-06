import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = "assets";
let client: S3Client | undefined;

function getStorageClient(): S3Client {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("Neon Object Storage credentials are not configured.");
  }
  if (!client) {
    client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }
  return client;
}

export async function putEventCover(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await getStorageClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "private, max-age=300",
    }),
  );
}

export async function deleteEventCover(key: string): Promise<void> {
  await getStorageClient().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );
}

export function createEventCoverUrl(key: string): Promise<string> {
  return getSignedUrl(
    getStorageClient(),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 300 },
  );
}
