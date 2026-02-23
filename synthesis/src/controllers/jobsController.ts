import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { Provider, Interval, EmailAccount, Newsletter } from '@prisma/client';
import { buildGmailQuery, gmailGetMessageText, gmailListMessageIds, GmailCredentials, RefreshedCredentials, GmailMessageContent } from '../integrations/gmail';
import { extractEmailContent, ExtractedArticle } from '../integrations/extractor';
import { createPodcastFromText } from '../synthesis';
import { PodcastOptions, PodcastResult } from '../schemas/podcast';
import { decrypt, encrypt } from '../lib/encryption';

// ============================================================================
// Types
// ============================================================================

interface ExtractedEmail {
  subject?: string;
  from?: string;
  date?: string;
  articles: ExtractedArticle[];
}

interface NewsletterProcessingOptions {
  maxEmailsPerNewsletter: number;
  gmailFetchConcurrency: number;
}

interface NewsletterResult {
  newsletterId: string;
  fetchedEmailCount?: number;
  historyId?: string;
  podcast?: PodcastResult;
  nextRun?: string;
  error?: string;
}

interface UserResult {
  userId: string;
  emailAccountId?: string;
  newsletters: NewsletterResult[];
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PODCAST_OPTIONS: PodcastOptions = {
  format: 'interview',
  speakers: [
    { name: 'Host', voiceId: 'en-US-Studio-Q' },
    { name: 'Guest', voiceId: 'en-US-Studio-O' },
  ],
};

// ============================================================================
// Utility Functions
// ============================================================================

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function addInterval(from: Date, interval: Interval): Date {
  const next = new Date(from.getTime());
  switch (interval) {
    case Interval.WEEKLY:
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case Interval.BIWEEKLY:
      next.setUTCDate(next.getUTCDate() + 14);
      return next;
    case Interval.MONTHLY:
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    default:
      return next;
  }
}

// ============================================================================
// Gmail Credential Helpers
// ============================================================================

function getGmailCredentials(emailAccount: EmailAccount): GmailCredentials | null {
  if (!emailAccount.accessToken) {
    return null;
  }
  return {
    accessToken: decrypt(emailAccount.accessToken),
    refreshToken: emailAccount.refreshToken ? decrypt(emailAccount.refreshToken) : undefined,
    expiresAt: emailAccount.expiresAt,
  };
}

function createCredentialsUpdater(
  emailAccountId: string,
  credentials: GmailCredentials
) {
  let currentCredentials = { ...credentials };

  return {
    getCredentials: () => currentCredentials,
    updateIfRefreshed: async (refreshed?: RefreshedCredentials) => {
      if (refreshed) {
        currentCredentials = {
          ...currentCredentials,
          accessToken: refreshed.accessToken,
          expiresAt: refreshed.expiresAt,
        };
        await prisma.emailAccount.update({
          where: { id: emailAccountId },
          data: {
            accessToken: encrypt(refreshed.accessToken),
            expiresAt: refreshed.expiresAt,
          },
        });
      }
    },
  };
}

// ============================================================================
// Email Fetching
// ============================================================================

async function fetchNewsletterEmails(
  credentialsManager: ReturnType<typeof createCredentialsUpdater>,
  newsletter: Newsletter,
  options: NewsletterProcessingOptions,
  startDate: Date
): Promise<GmailMessageContent[]> {
  const afterUnixSeconds = Math.floor(((newsletter.lastRun ?? startDate).getTime()) / 1000);
  const q = buildGmailQuery({
    selectedEmails: newsletter.selectedEmails ?? [],
    afterUnixSeconds,
  });

  const listResult = await gmailListMessageIds({
    credentials: credentialsManager.getCredentials(),
    q,
    maxResults: Math.max(1, Math.min(50, options.maxEmailsPerNewsletter)),
  });
  await credentialsManager.updateIfRefreshed(listResult.refreshedCredentials);

  const emails = await mapWithConcurrency(
    listResult.messageIds,
    Math.max(1, Math.min(20, options.gmailFetchConcurrency)),
    async (id) => {
      const result = await gmailGetMessageText({
        credentials: credentialsManager.getCredentials(),
        messageId: id,
      });
      await credentialsManager.updateIfRefreshed(result.refreshedCredentials);
      return result.message;
    }
  );

  return emails;
}

// ============================================================================
// Content Extraction
// ============================================================================

async function extractEmailsContent(emails: GmailMessageContent[]): Promise<ExtractedEmail[]> {
  return mapWithConcurrency(emails, 4, async (email) => {
    if (!email.html) {
      return {
        subject: email.headers['Subject'],
        from: email.headers['From'],
        date: email.headers['Date'],
        articles: [{ text: email.text }] as ExtractedArticle[],
      };
    }

    try {
      const extracted = await extractEmailContent({
        html: email.html,
        text: email.text,
        fetchTimeout: 30,
        maxFetchContent: 5000,
      });
      return {
        subject: email.headers['Subject'],
        from: email.headers['From'],
        date: email.headers['Date'],
        articles: extracted.articles,
      };
    } catch (err) {
      console.error('Python extraction failed, falling back to plain text:', err);
      return {
        subject: email.headers['Subject'],
        from: email.headers['From'],
        date: email.headers['Date'],
        articles: [{ text: email.text }] as ExtractedArticle[],
      };
    }
  });
}

// ============================================================================
// Podcast Input Building
// ============================================================================

function buildPodcastInput(extractedEmails: ExtractedEmail[]): string {
  return extractedEmails
    .map((email) => {
      const header = `From: ${email.from ?? ''}\nSubject: ${email.subject ?? ''}\nDate: ${email.date ?? ''}`.trim();

      const articlesText = email.articles
        .map((article) => {
          // Use fetched content if available, otherwise fall back to extracted text
          const content = article.fetched_content || article.text;
          const title = article.fetched_title || article.title;

          if (!content) {
            return null;
          }

          let text = content;
          if (title) {
            text = `### ${title}\n\n${text}`;
          }

          // Log if we used fetched content
          if (article.fetched_content) {
            console.log(`Using fetched content for article: ${title || article.link || 'untitled'} (method: ${article.fetch_method})`);
          } else if (article.fetch_error) {
            console.warn(`Fetch failed for ${article.link}: ${article.fetch_error}, using email snippet`);
          }

          return text;
        })
        .filter(Boolean)
        .join('\n\n---\n\n');

      return `${header}\n\n${articlesText}`.trim();
    })
    .filter(Boolean)
    .join('\n\n===\n\n');
}

// ============================================================================
// Newsletter Processing
// ============================================================================

async function generateNewsletterPodcast(
  combinedText: string,
  options: PodcastOptions = DEFAULT_PODCAST_OPTIONS
): Promise<PodcastResult> {
  return createPodcastFromText(combinedText, options);
}

async function saveNewsletterHistory(
  newsletterId: string,
  emails: GmailMessageContent[],
  podcast: PodcastResult
): Promise<string> {
  const history = await prisma.newsletterHistory.create({
    data: {
      newsletterId,
      summary: JSON.stringify({
        fetchedEmailCount: emails.length,
        podcast,
      }),
      emails: emails.map((e) => ({
        id: e.id,
        threadId: e.threadId,
        snippet: e.snippet,
        internalDate: e.internalDate,
        headers: e.headers,
      })),
    },
  });
  return history.id;
}

async function updateNewsletterSchedule(newsletterId: string, now: Date, interval: Interval): Promise<Date> {
  const nextRun = addInterval(now, interval);
  await prisma.newsletter.update({
    where: { id: newsletterId },
    data: { lastRun: now, nextRun },
  });
  return nextRun;
}

async function processNewsletter(
  credentialsManager: ReturnType<typeof createCredentialsUpdater>,
  newsletter: Newsletter,
  options: NewsletterProcessingOptions,
  startDate: Date,
  now: Date
): Promise<NewsletterResult> {
  try {
    // Step 1: Fetch emails from Gmail
    const emails = await fetchNewsletterEmails(credentialsManager, newsletter, options, startDate);

    // Step 2: Extract content (including fetching full article content)
    const extractedEmails = await extractEmailsContent(emails);

    // Step 3: Build podcast input text
    const combinedText = buildPodcastInput(extractedEmails);

    // Step 4: Generate podcast
    const podcast = await generateNewsletterPodcast(combinedText);

    // Step 5: Save history
    const historyId = await saveNewsletterHistory(newsletter.id, emails, podcast);

    // Step 6: Update schedule
    const nextRun = await updateNewsletterSchedule(newsletter.id, now, newsletter.interval);

    return {
      newsletterId: newsletter.id,
      fetchedEmailCount: emails.length,
      historyId,
      podcast,
      nextRun: nextRun.toISOString(),
    };
  } catch (e: unknown) {
    return {
      newsletterId: newsletter.id,
      error: e instanceof Error ? e.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Main Controller
// ============================================================================

export const jobsController = {
  // Test endpoint to fetch emails from info@tipranks.com
  testFetchAndExtract: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const maxEmails = Number(req.body?.maxEmails ?? 3);

      const users = await prisma.user.findMany({
        include: {
          emailAccounts: { where: { provider: Provider.GMAIL } },
        },
      });

      const user = users[0];
      if (!user) {
        return res.status(404).json({ error: 'No user found' });
      }

      const gmailAccount = user.emailAccounts[0];
      if (!gmailAccount) {
        return res.status(404).json({ error: 'No Gmail account found' });
      }

      const credentials = getGmailCredentials(gmailAccount);
      if (!credentials) {
        return res.status(400).json({ error: 'No credentials available' });
      }

      const credentialsManager = createCredentialsUpdater(gmailAccount.id, credentials);

      // Fetch emails from info@tipranks.com
      const listResult = await gmailListMessageIds({
        credentials: credentialsManager.getCredentials(),
        q: 'from:info@tipranks.com',
        maxResults: maxEmails,
      });
      await credentialsManager.updateIfRefreshed(listResult.refreshedCredentials);

      console.log(`Found ${listResult.messageIds.length} emails from info@tipranks.com`);

      // Fetch email content
      const emails = await mapWithConcurrency(
        listResult.messageIds,
        4,
        async (id) => {
          const result = await gmailGetMessageText({
            credentials: credentialsManager.getCredentials(),
            messageId: id,
          });
          await credentialsManager.updateIfRefreshed(result.refreshedCredentials);
          return result.message;
        }
      );

      console.log(`Fetched ${emails.length} emails`);

      // Extract content (this calls Python extractor which fetches article content)
      const extractedEmails = await extractEmailsContent(emails);

      console.log(`Extracted content from ${extractedEmails.length} emails`);

      // Build podcast input
      const combinedText = buildPodcastInput(extractedEmails);

      console.log(`Combined text length: ${combinedText.length} characters`);

      // Check if user wants to generate podcast
      const generatePodcast = req.body?.generatePodcast === true;

      let podcast = null;
      let localAudioPath = null;
      if (generatePodcast) {
        console.log('Generating podcast...');
        podcast = await generateNewsletterPodcast(combinedText);
        console.log('Podcast generated:', podcast);

        // Return local file path
        if (podcast.audioFilename) {
          const path = require('path');
          localAudioPath = path.join(process.cwd(), podcast.audioFilename);
          console.log('Audio saved to:', localAudioPath);
        }
      }

      // Return results
      return res.json({
        status: 'success',
        emailCount: emails.length,
        extractedEmails: extractedEmails.map(e => ({
          subject: e.subject,
          from: e.from,
          date: e.date,
          articleCount: e.articles.length,
          articles: e.articles.map(a => ({
            title: a.title,
            text: a.text?.substring(0, 200) + '...',
            link: a.link,
            fetched_content: a.fetched_content?.substring(0, 300) + (a.fetched_content ? '...' : null),
            fetched_title: a.fetched_title,
            fetch_method: a.fetch_method,
            fetch_error: a.fetch_error,
          })),
        })),
        combinedTextPreview: combinedText.substring(0, 1000) + '...',
        combinedTextLength: combinedText.length,
        podcast,
        localAudioPath,
      });
    } catch (error) {
      next(error);
    }
  },

  createUsersPodcasts: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const start = startOfUtcDay(now);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

      const options: NewsletterProcessingOptions = {
        maxEmailsPerNewsletter: Number(req.body?.maxEmailsPerNewsletter ?? 10),
        gmailFetchConcurrency: Number(req.body?.gmailFetchConcurrency ?? 8),
      };

      const users = await prisma.user.findMany({
        include: {
          emailAccounts: { where: { provider: Provider.GMAIL } },
          newsletters: {
            where: { isActive: true, nextRun: { gte: start, lt: end } },
          },
        },
      });

      const perUserResults: UserResult[] = [];

      for (const user of users) {
        const gmailAccount = user.emailAccounts[0];
        const userResult: UserResult = {
          userId: user.id,
          emailAccountId: gmailAccount?.id,
          newsletters: [],
        };

        if (!gmailAccount) {
          userResult.error = 'No Gmail email account found for user';
          perUserResults.push(userResult);
          continue;
        }

        const credentials = getGmailCredentials(gmailAccount);
        if (!credentials) {
          userResult.error = 'No Gmail email account with accessToken found for user';
          perUserResults.push(userResult);
          continue;
        }

        const credentialsManager = createCredentialsUpdater(gmailAccount.id, credentials);

        for (const newsletter of user.newsletters) {
          const result = await processNewsletter(
            credentialsManager,
            newsletter,
            options,
            start,
            now
          );
          userResult.newsletters.push(result);
        }

        perUserResults.push(userResult);
      }

      return res.json({
        status: 'success',
        ranAt: now.toISOString(),
        userCount: users.length,
        result: perUserResults,
      });
    } catch (error) {
      next(error);
    }
  },
};
