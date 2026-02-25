import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
export const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const r2Enabled = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL;

const s3Client = r2Enabled
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID!,
        secretAccessKey: R2_SECRET_ACCESS_KEY!,
      },
    })
  : null;

export async function uploadFileToR2(
  localFilePath: string,
  destinationKey: string,
  contentType: string = "audio/mpeg"
): Promise<string> {
  if (!s3Client || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    console.warn("R2 not configured, skipping upload");
    return localFilePath;
  }

  const fileBuffer = await fs.readFile(localFilePath);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: destinationKey,
      Body: fileBuffer,
      ContentType: contentType,
    })
  );

  const publicUrl = `${R2_PUBLIC_URL}/${destinationKey}`;
  console.log(`Uploaded to R2: ${publicUrl}`);
  return publicUrl;
}
