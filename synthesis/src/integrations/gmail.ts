import { google } from 'googleapis';
import { Base64 } from 'js-base64';

export interface GmailMessageContent {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  headers: Record<string, string | undefined>;
  text: string;      // Plain text version (stripped of HTML)
  html?: string;     // Full HTML with all links preserved
}

/** @deprecated Use GmailMessageContent instead */
export type GmailMessageText = GmailMessageContent;

export interface GmailCredentials {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
}

export interface RefreshedCredentials {
  accessToken: string;
  expiresAt: Date | null;
}

async function getGmailClient(credentials: GmailCredentials): Promise<{
  gmail: ReturnType<typeof google.gmail>;
  refreshedCredentials?: RefreshedCredentials;
}> {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  auth.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken ?? undefined,
  });

  let refreshedCredentials: RefreshedCredentials | undefined;

  // Check if token is expired or about to expire (within 5 minutes)
  const now = new Date();
  const bufferMs = 5 * 60 * 1000; // 5 minutes buffer
  const isExpired = credentials.expiresAt && credentials.expiresAt.getTime() - bufferMs < now.getTime();

  if (isExpired && credentials.refreshToken) {
    try {
      const { credentials: newCreds } = await auth.refreshAccessToken();
      auth.setCredentials(newCreds);
      
      refreshedCredentials = {
        accessToken: newCreds.access_token!,
        expiresAt: newCreds.expiry_date ? new Date(newCreds.expiry_date) : null,
      };
    } catch (err) {
      console.error('Failed to refresh access token:', err);
      throw new Error('Failed to refresh Gmail access token. User may need to re-authenticate.');
    }
  }

  return {
    gmail: google.gmail({ version: 'v1', auth }),
    refreshedCredentials,
  };
}

function buildSelectedEmailsQuery(selectedEmails: string[]): string {
  const cleaned = selectedEmails.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  return `(${cleaned.map((email) => `from:${email}`).join(' OR ')})`;
}

export function buildGmailQuery(params: { selectedEmails: string[]; afterUnixSeconds?: number }): string {
  const parts: string[] = [];
  const fromPart = buildSelectedEmailsQuery(params.selectedEmails);
  if (fromPart) parts.push(fromPart);
  if (params.afterUnixSeconds && params.afterUnixSeconds > 0) parts.push(`after:${params.afterUnixSeconds}`);
  return parts.join(' ').trim();
}

export interface GmailListResult {
  messageIds: string[];
  refreshedCredentials?: RefreshedCredentials;
}

export async function gmailListMessageIds(params: {
  credentials: GmailCredentials;
  q: string;
  maxResults?: number;
}): Promise<GmailListResult> {
  const { credentials, q, maxResults = 10 } = params;

  const { gmail, refreshedCredentials } = await getGmailClient(credentials);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults,
  });

  return {
    messageIds: (res.data.messages ?? []).map((m) => m.id!).filter(Boolean),
    refreshedCredentials,
  };
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recursively extracts content of a specific MIME type from an email payload.
 */
function extractContentByMimeType(payload: any, targetMimeType: string): string | undefined {
  if (!payload) return undefined;

  const mimeType = payload.mimeType as string | undefined;
  const bodyData = payload.body?.data as string | undefined;

  // Direct match
  if (bodyData && mimeType === targetMimeType) {
    return Base64.decode(bodyData);
  }

  // Search in multipart parts
  const parts = (payload.parts ?? []) as any[];
  for (const part of parts) {
    const content = extractContentByMimeType(part, targetMimeType);
    if (content) return content;
  }

  return undefined;
}

/**
 * Extracts both plain text and HTML from an email payload.
 */
function extractEmailContent(payload: any): { text: string; html?: string } {
  // Try to get text/plain first
  const plainText = extractContentByMimeType(payload, 'text/plain');
  
  // Try to get text/html
  const htmlContent = extractContentByMimeType(payload, 'text/html');

  // If we have plain text, use it; otherwise convert HTML to text
  const text = plainText ?? (htmlContent ? stripHtml(htmlContent) : '');

  return {
    text,
    html: htmlContent,
  };
}

export interface GmailMessageResult {
  message: GmailMessageContent;
  refreshedCredentials?: RefreshedCredentials;
}

/** Represents an article/section extracted from a newsletter email */
export interface EmailArticle {
  /** The text content/summary of the article */
  text: string;
  /** The "read more" or "continue reading" link, if found */
  link?: string;
  /** The link text (e.g., "Read more", "Continue reading") */
  linkText?: string;
}

/** Structured content extracted from an email */
export interface StructuredEmailContent {
  subject?: string;
  from?: string;
  date?: string;
  /** Individual articles/sections found in the email */
  articles: EmailArticle[];
  /** All links found in the email */
  allLinks: { text: string; url: string }[];
}

// Common patterns for "read more" links
const READ_MORE_PATTERNS = [
  /read\s*more/i,
  /continue\s*reading/i,
  /full\s*(story|article)/i,
  /learn\s*more/i,
  /see\s*more/i,
  /view\s*(full|more)/i,
  /click\s*here/i,
  /more\s*details/i,
  /read\s*the\s*(full|rest)/i,
];

/**
 * Extracts all links from HTML content
 */
function extractAllLinks(html: string): { text: string; url: string }[] {
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links: { text: string; url: string }[] = [];
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const text = stripHtml(match[2]).trim();
    if (url && !url.startsWith('mailto:') && !url.startsWith('#')) {
      links.push({ text, url });
    }
  }
  
  return links;
}

/**
 * Checks if a link is a "read more" type link
 */
function isReadMoreLink(linkText: string): boolean {
  return READ_MORE_PATTERNS.some(pattern => pattern.test(linkText));
}

/**
 * Parses email HTML into structured articles with their associated links.
 * Useful for newsletter emails that contain multiple stories/articles.
 */
export function parseEmailToArticles(message: GmailMessageContent): StructuredEmailContent {
  const result: StructuredEmailContent = {
    subject: message.headers['Subject'],
    from: message.headers['From'],
    date: message.headers['Date'],
    articles: [],
    allLinks: [],
  };

  if (!message.html) {
    // No HTML, just return the plain text as a single article
    if (message.text) {
      result.articles.push({ text: message.text });
    }
    return result;
  }

  // Extract all links
  result.allLinks = extractAllLinks(message.html);

  // Try to split content by common newsletter section patterns
  // Look for table cells, divs with significant content, or horizontal rules
  const sectionPatterns = [
    /<tr[^>]*>([\s\S]*?)<\/tr>/gi,           // Table rows (common in newsletters)
    /<div[^>]*class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,  // Article divs
    /<td[^>]*>([\s\S]*?)<\/td>/gi,           // Table cells
  ];

  // Simple approach: Find chunks of text followed by "read more" links
  const html = message.html;
  const allLinks = result.allLinks;
  
  // Find "read more" links and their surrounding context
  const readMoreLinks = allLinks.filter(link => isReadMoreLink(link.text));
  
  if (readMoreLinks.length > 0) {
    // We have structured content with read more links
    for (const link of readMoreLinks) {
      // Find the position of this link in the HTML
      const linkIndex = html.indexOf(link.url);
      if (linkIndex === -1) continue;
      
      // Extract text before this link (up to 1000 chars or previous link)
      const beforeLink = html.substring(Math.max(0, linkIndex - 2000), linkIndex);
      const textContent = stripHtml(beforeLink).trim();
      
      // Get last meaningful paragraph (at least 50 chars)
      const paragraphs = textContent.split(/\n\n+/).filter(p => p.length > 50);
      const articleText = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : textContent.slice(-500);
      
      if (articleText.length > 20) {
        result.articles.push({
          text: articleText.trim(),
          link: link.url,
          linkText: link.text,
        });
      }
    }
  }
  
  // If no articles found via read more links, treat the whole email as one article
  if (result.articles.length === 0) {
    // Find the most prominent link (first non-trivial link)
    const mainLink = allLinks.find(l => l.url.startsWith('http') && l.text.length > 0);
    
    result.articles.push({
      text: message.text,
      link: mainLink?.url,
      linkText: mainLink?.text,
    });
  }

  return result;
}

export async function gmailGetMessageText(params: {
  credentials: GmailCredentials;
  messageId: string;
}): Promise<GmailMessageResult> {
  const { credentials, messageId } = params;

  const { gmail, refreshedCredentials } = await getGmailClient(credentials);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const payloadHeaders = (res.data?.payload?.headers ?? []) as Array<{ name: string; value: string }>;
  const headers: Record<string, string | undefined> = {};
  for (const h of payloadHeaders) headers[h.name] = h.value;

  const { text, html } = extractEmailContent(res.data?.payload);

  return {
    message: {
      id: res.data?.id ?? messageId,
      threadId: res.data?.threadId ?? undefined,
      snippet: res.data?.snippet ?? undefined,
      internalDate: res.data?.internalDate ?? undefined,
      headers,
      text,
      html,
    },
    refreshedCredentials,
  };
}

