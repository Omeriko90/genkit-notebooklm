import axios from "axios";
import pdfParse from "pdf-parse";
import path from "path";
import mammoth from "mammoth"; // For .docx
import { lookup } from "dns/promises";

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
]);

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^f[cd]/i,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some(r => r.test(ip));
}

async function validateSafeUrl(urlString: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed');
  }

  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    throw new Error('URL not allowed');
  }

  const addresses = await lookup(parsed.hostname, { all: true }).catch(() => {
    throw new Error('Unable to resolve URL hostname');
  });

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('URL resolves to a private address');
    }
  }
}

export async function getTextFromUrl(url: string): Promise<{ isText: boolean, content: string }> {
  try {
    await validateSafeUrl(url);

    let buffer: Buffer;
    let contentType = "";

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      headers: {
        'Accept': '*/*'
      }
    });
    contentType = String(response.headers['content-type'] || "");
    buffer = Buffer.from(response.data);

    const extension = path.extname(url).toLowerCase();

    let text = "";
    let isText = false;

    if (contentType.includes("pdf") || extension === ".pdf") {
      const data = await pdfParse(buffer);
      text = data.text;
      isText = true;
    } else if (contentType.includes("plain") || extension === ".txt") {
      text = buffer.toString("utf-8");
      isText = true;
    } else if (contentType.includes("word") || extension === ".docx") {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      isText = true;
    } else if (extension === ".md") {
      text = buffer.toString("utf-8");
      isText = true;
    }

    return { isText, content: text };
  } catch (error) {
    console.error("Error processing file:", error);
    throw error;
  }
}

export function isUrl(text: string): boolean {
  const trimmed = text.trim();
  // Check for spaces
  if (trimmed.includes(' ')) {
    return false;
  }

  // Check for standard URLs
  try {
    new URL(trimmed);
    return true;
  } catch (_) {
    return false;
  }
}
