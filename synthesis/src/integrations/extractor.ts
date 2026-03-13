/**
 * Client for the Python Email Content Extractor service.
 * Sends email HTML to the Python service for structured content extraction.
 */

import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';

const EXTRACTOR_URL = process.env.EXTRACTOR_URL || 'http://localhost:8081';
const isCloudRun = !!process.env.K_SERVICE;

const auth = new GoogleAuth();

async function getAuthHeaders(): Promise<Record<string, string>> {
  if (!isCloudRun) return {};
  const client = await auth.getIdTokenClient(EXTRACTOR_URL);
  const headers = await client.getRequestHeaders();
  return headers;
}

export interface ExtractedArticle {
  text: string;
  link?: string;
  link_text?: string;
  title?: string;
  // Fetched content fields (from Python extractor)
  fetched_content?: string;
  fetched_title?: string;
  fetched_url?: string;
  fetch_error?: string;
  fetch_method?: 'httpx' | 'browserless' | 'playwright';
}

export interface ExtractionResult {
  articles: ExtractedArticle[];
  all_links: { url: string; text: string; is_read_more: boolean }[];
  main_content?: string;
  articles_fetched: boolean;
}

/**
 * Extract structured content from newsletter email HTML.
 * Calls the Python extraction microservice which also fetches full article content from links.
 */
export async function extractEmailContent(params: {
  html: string;
  text?: string;
  baseUrl?: string;
  fetchTimeout?: number;
  maxFetchContent?: number;
}): Promise<ExtractionResult> {
  const { html, text, baseUrl, fetchTimeout = 30, maxFetchContent = 5000 } = params;

  try {
    const authHeaders = await getAuthHeaders();
    const response = await axios.post<ExtractionResult>(`${EXTRACTOR_URL}/extract`, {
      html,
      text,
      base_url: baseUrl,
      fetch_timeout: fetchTimeout,
      max_fetch_content: maxFetchContent,
    }, {
      timeout: 120000, // 2 minute timeout to allow for article fetching
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
    });

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Email extractor service is not running. Start it with: cd extractor && python main.py');
      }
      throw new Error(`Extraction failed: ${error.response?.data?.detail || error.message}`);
    }
    throw error;
  }
}

/**
 * Check if the extractor service is healthy.
 */
export async function isExtractorHealthy(): Promise<boolean> {
  try {
    const authHeaders = await getAuthHeaders();
    const response = await axios.get(`${EXTRACTOR_URL}/health`, {
      timeout: 5000,
      headers: authHeaders,
    });
    return response.data?.status === 'healthy';
  } catch {
    return false;
  }
}
