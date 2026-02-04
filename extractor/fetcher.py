"""
Article fetching logic for the Email Content Extractor Service
"""

import asyncio
from typing import Optional
from dataclasses import dataclass

import httpx
from trafilatura import extract


@dataclass
class FetchedArticle:
    """Result of fetching an article from a URL"""
    url: str
    content: Optional[str] = None
    title: Optional[str] = None
    error: Optional[str] = None


# Default headers to mimic a browser request
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


async def fetch_article_content(
    url: str,
    timeout: float = 10.0,
    max_content_length: int = 5000
) -> FetchedArticle:
    """
    Fetch and extract article content from a URL.
    
    Args:
        url: The URL to fetch
        timeout: Request timeout in seconds
        max_content_length: Maximum length of extracted content
        
    Returns:
        FetchedArticle with content or error message
    """
    try:
        async with httpx.AsyncClient(
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            timeout=timeout
        ) as client:
            response = await client.get(url)
            response.raise_for_status()
            
            html = response.text
            
            # Extract main content using trafilatura
            content = extract(
                html,
                include_links=False,
                include_images=False,
                include_tables=False,
                no_fallback=False
            )
            
            # Extract title
            title = extract(html, output_format='xml')
            if title and '<title>' in title:
                import re
                title_match = re.search(r'<title>([^<]+)</title>', title)
                title = title_match.group(1) if title_match else None
            else:
                title = None
            
            if content:
                return FetchedArticle(
                    url=url,
                    content=content[:max_content_length],
                    title=title
                )
            else:
                return FetchedArticle(
                    url=url,
                    error="Could not extract content from page"
                )
                
    except httpx.TimeoutException:
        return FetchedArticle(url=url, error="Request timed out")
    except httpx.HTTPStatusError as e:
        return FetchedArticle(url=url, error=f"HTTP error: {e.response.status_code}")
    except httpx.RequestError as e:
        return FetchedArticle(url=url, error=f"Request failed: {str(e)}")
    except Exception as e:
        return FetchedArticle(url=url, error=f"Extraction failed: {str(e)}")


async def fetch_multiple_articles(
    urls: list[str],
    timeout: float = 10.0,
    max_content_length: int = 5000,
    max_concurrent: int = 5
) -> dict[str, FetchedArticle]:
    """
    Fetch multiple articles concurrently.
    
    Args:
        urls: List of URLs to fetch
        timeout: Request timeout per URL
        max_content_length: Maximum content length per article
        max_concurrent: Maximum concurrent requests
        
    Returns:
        Dictionary mapping URL to FetchedArticle
    """
    semaphore = asyncio.Semaphore(max_concurrent)
    
    async def fetch_with_semaphore(url: str) -> tuple[str, FetchedArticle]:
        async with semaphore:
            result = await fetch_article_content(url, timeout, max_content_length)
            return url, result
    
    tasks = [fetch_with_semaphore(url) for url in urls]
    results = await asyncio.gather(*tasks)
    
    return dict(results)
