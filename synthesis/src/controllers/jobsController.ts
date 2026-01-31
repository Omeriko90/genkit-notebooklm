import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { Provider, Interval } from '@prisma/client';
import { buildGmailQuery, gmailGetMessageText, gmailListMessageIds, GmailCredentials, RefreshedCredentials } from '../integrations/gmail';
import { extractEmailContent, isExtractorHealthy, ExtractedArticle } from '../integrations/extractor';
import { createPodcastFromText } from '../synthesis';
import { PodcastOptions } from '../schemas/podcast';
import { decrypt, encrypt } from '../lib/encryption';

const DEFAULT_PODCAST_OPTIONS: PodcastOptions = {
  format: 'interview',
  speakers: [
    { name: 'Host', voiceId: 'en-US-Studio-Q' },
    { name: 'Guest', voiceId: 'en-US-Studio-O' },
  ],
};

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

export const jobsController = {
  createUsersPodcasts: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const start = startOfUtcDay(now);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

      
      const maxEmailsPerNewsletter = Number(req.body?.maxEmailsPerNewsletter ?? 10);
      const gmailFetchConcurrency = Number(req.body?.gmailFetchConcurrency ?? 8);

      const users = await prisma.user.findMany({
        // where: {
        //   newsletters: {
        //     some: {
        //       isActive: true,
        //       nextRun: { gte: start, lt: end },
        //     },
        //   },
        // },
        include: {
          emailAccounts: { where: { provider: Provider.GMAIL } },
          newsletters: {
            where: { isActive: true, nextRun: { gte: start, lt: end } },
          },
        },
      });

      const perUserResults = [];

      for (const user of users) {
        const gmailAccount = user.emailAccounts[0];
        const userResult: any = { userId: user.id, emailAccountId: gmailAccount?.id, newsletters: [] };

        if (!gmailAccount?.accessToken) {
          userResult.error = 'No Gmail email account with accessToken found for user';
          perUserResults.push(userResult);
          continue;
        }

        // Build credentials object with refresh token support
        let credentials: GmailCredentials = {
          accessToken: decrypt(gmailAccount.accessToken),
          refreshToken: gmailAccount.refreshToken ? decrypt(gmailAccount.refreshToken) : undefined,
          expiresAt: gmailAccount.expiresAt,
        };

        // Helper to update credentials if they were refreshed
        const updateCredentialsIfRefreshed = async (refreshed?: RefreshedCredentials) => {
          if (refreshed) {
            credentials = { ...credentials, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
            await prisma.emailAccount.update({
              where: { id: gmailAccount.id },
              data: { accessToken: encrypt(refreshed.accessToken), expiresAt: refreshed.expiresAt },
            });
          }
        };

        const listResult = await gmailListMessageIds({
          credentials,
          q: 'from:info@tipranks.com',
          maxResults: Math.max(1, Math.min(50, maxEmailsPerNewsletter)),
        });

        const messages = await Promise.all(
          listResult.messageIds.map(id => 
            gmailGetMessageText({ credentials, messageId: id })
          )
        );
        const extractedEmails = await mapWithConcurrency(
          messages,
          4, // Concurrency for extraction
          async (email) => {
            if (!email.message.html) {
              // No HTML, use plain text
              return {
                subject: email.message.headers['Subject'],
                from: email.message.headers['From'],
                date: email.message.headers['Date'],
                articles: [{ text: email.message.text }] as ExtractedArticle[],
              };
            }
            
            try {
              const extracted = await extractEmailContent({ html: email.message.html, text: email.message.text });
              return {
                subject: email.message.headers['Subject'],
                from: email.message.headers['From'],
                date: email.message.headers['Date'],
                articles: extracted.articles,
              };
            } catch (err) {
              // Fallback to plain text if extraction fails
              console.error('Python extraction failed, falling back to plain text:', err);
              return {
                  subject: email.message.headers['Subject'],
                from: email.message.headers['From'],
                date: email.message.headers['Date'],
                articles: [{ text: email.message.text }] as ExtractedArticle[],
              };
            }
          }
        );
        // return res.json({
        //   status: 'success',
        //   extractedEmails,
        // });
        await updateCredentialsIfRefreshed(listResult.refreshedCredentials);

        for (const newsletter of user.newsletters) {
          try {
            const afterUnixSeconds = Math.floor(((newsletter.lastRun ?? start).getTime()) / 1000);
            const q = buildGmailQuery({
              selectedEmails: newsletter.selectedEmails ?? [],
              afterUnixSeconds,
            });

            const listResult = await gmailListMessageIds({
              credentials,
              q,
              maxResults: Math.max(1, Math.min(50, maxEmailsPerNewsletter)),
            });
            await updateCredentialsIfRefreshed(listResult.refreshedCredentials);

            // Fetch emails from Gmail
            const emails = await mapWithConcurrency(
              listResult.messageIds,
              Math.max(1, Math.min(20, gmailFetchConcurrency)),
              async (id) => {
                const result = await gmailGetMessageText({ credentials, messageId: id });
                await updateCredentialsIfRefreshed(result.refreshedCredentials);
                return result.message;
              }
            );

            // Extract structured content using Python service
            const extractedEmails = await mapWithConcurrency(
              emails,
              4, // Concurrency for extraction
              async (email) => {
                if (!email.html) {
                  // No HTML, use plain text
                  return {
                    subject: email.headers['Subject'],
                    from: email.headers['From'],
                    date: email.headers['Date'],
                    articles: [{ text: email.text }] as ExtractedArticle[],
                  };
                }
                
                try {
                  const extracted = await extractEmailContent({ html: email.html, text: email.text });
                  return {
                    subject: email.headers['Subject'],
                    from: email.headers['From'],
                    date: email.headers['Date'],
                    articles: extracted.articles,
                  };
                } catch (err) {
                  // Fallback to plain text if extraction fails
                  console.error('Python extraction failed, falling back to plain text:', err);
                  return {
                    subject: email.headers['Subject'],
                    from: email.headers['From'],
                    date: email.headers['Date'],
                    articles: [{ text: email.text }] as ExtractedArticle[],
                  };
                }
              }
            );

            // Combine extracted articles into text for podcast generation
            const combinedText = extractedEmails
              .map((email) => {
                const header = `From: ${email.from ?? ''}\nSubject: ${email.subject ?? ''}\nDate: ${email.date ?? ''}`.trim();
                
                // Format each article with its link
                const articlesText = email.articles
                  .map((article) => {
                    let text = article.text;
                    if (article.link) {
                      text += `\n\n[Read more: ${article.link}]`;
                    }
                    if (article.title) {
                      text = `### ${article.title}\n\n${text}`;
                    }
                    return text;
                  })
                  .join('\n\n---\n\n');
                
                return `${header}\n\n${articlesText}`.trim();
              })
              .filter(Boolean)
              .join('\n\n===\n\n');

            const podcast = await createPodcastFromText(combinedText, DEFAULT_PODCAST_OPTIONS);

            const history = await prisma.newsletterHistory.create({
              data: {
                newsletterId: newsletter.id,
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

            const nextRun = addInterval(now, newsletter.interval);
            await prisma.newsletter.update({
              where: { id: newsletter.id },
              data: { lastRun: now, nextRun },
            });

            userResult.newsletters.push({
              newsletterId: newsletter.id,
              fetchedEmailCount: emails.length,
              historyId: history.id,
              podcast,
              nextRun: nextRun.toISOString(),
            });
          } catch (e: unknown) {
            userResult.newsletters.push({
              newsletterId: newsletter.id,
              error: e instanceof Error ? e.message : 'Unknown error',
            });
          }
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

