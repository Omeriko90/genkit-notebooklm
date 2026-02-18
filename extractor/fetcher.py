"""
Article fetching logic for the Email Content Extractor Service

Supports multiple fetching strategies:
1. Fast HTTP fetch with browser-like headers (default)
2. Headless browser fetch via Playwright (fallback for anti-bot protected sites)
3. Browserless.io cloud browser (best for bypassing Cloudflare and bot detection)
"""

import asyncio
import os
import re
from typing import Optional
from dataclasses import dataclass
from urllib.parse import urlparse
from pathlib import Path

import httpx
from trafilatura import extract

# Load .env file if it exists
try:
    from dotenv import load_dotenv
    # Try to find .env in current directory, parent, or sibling directories
    possible_paths = [
        Path(__file__).parent / '.env',                    # extractor/.env
        Path(__file__).parent.parent / '.env',              # project root/.env
        Path(__file__).parent.parent / 'synthesis' / '.env', # synthesis/.env
    ]
    for env_path in possible_paths:
        if env_path.exists():
            load_dotenv(env_path)
            break
except ImportError:
    pass  # dotenv not installed, rely on system environment variables

# Try to import playwright, but make it optional
try:
    from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

# Try to import playwright-stealth for bypassing bot detection
try:
    from playwright_stealth import stealth_async
    STEALTH_AVAILABLE = True
except ImportError:
    STEALTH_AVAILABLE = False

# Browserless.io configuration
BROWSERLESS_API_KEY = os.environ.get("BROWSERLESS_API_KEY", "")
BROWSERLESS_ENABLED = bool(BROWSERLESS_API_KEY)


@dataclass
class FetchedArticle:
    """Result of fetching an article from a URL"""
    url: str
    content: Optional[str] = None
    title: Optional[str] = None
    error: Optional[str] = None
    fetch_method: Optional[str] = None  # 'httpx' or 'playwright'
    final_url: Optional[str] = None  # The final URL after redirects (if different from original)


# Comprehensive browser-like headers
def get_browser_headers(url: str) -> dict:
    """Generate realistic browser headers for a URL"""
    parsed = urlparse(url)
    
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Sec-Ch-Ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Cache-Control": "max-age=0",
        "Referer": f"{parsed.scheme}://{parsed.netloc}/",
    }


# HTTP status codes that should trigger Playwright fallback
FALLBACK_STATUS_CODES = {403, 401, 406, 429, 503}


def extract_content_and_title(html: str, max_content_length: int) -> tuple[Optional[str], Optional[str]]:
    """Extract main content and title from HTML"""
    # Extract main content using trafilatura
    content = extract(
        html,
        include_links=False,
        include_images=False,
        include_tables=False,
        no_fallback=False
    )
    
    # Extract title
    title = None
    title_match = re.search(r'<title[^>]*>([^<]+)</title>', html, re.IGNORECASE)
    if title_match:
        title = title_match.group(1).strip()
    
    if content:
        content = content[:max_content_length]
    
    return content, title


async def resolve_tracking_url(url: str, timeout: float = 10.0) -> tuple[str, Optional[str]]:
    """
    Resolve a tracking/redirect URL to its final destination.
    
    Returns:
        tuple of (final_url, error_message)
    """
    try:
        async with httpx.AsyncClient(
            headers=get_browser_headers(url),
            follow_redirects=True,
            timeout=timeout
        ) as client:
            response = await client.get(url)
            # Return the final URL after all redirects
            return str(response.url), None
    except httpx.HTTPStatusError as e:
        # Even on error, check if we got redirected before the error
        if e.response.history:
            # Return the last successful redirect URL
            return str(e.response.history[-1].url), None
        return url, f"HTTP error: {e.response.status_code}"
    except Exception as e:
        return url, str(e)


async def fetch_with_httpx(
    url: str,
    timeout: float = 10.0,
    max_content_length: int = 5000
) -> FetchedArticle:
    """
    Fetch article using httpx with browser-like headers.
    
    Returns FetchedArticle with error if fetch fails (caller may retry with Playwright).
    """
    try:
        async with httpx.AsyncClient(
            headers=get_browser_headers(url),
            follow_redirects=True,
            timeout=timeout
        ) as client:
            response = await client.get(url)
            response.raise_for_status()
            
            # Track the final URL after redirects
            final_url = str(response.url)
            
            html = response.text
            content, title = extract_content_and_title(html, max_content_length)
            
            if content:
                return FetchedArticle(
                    url=url,
                    final_url=final_url if final_url != url else None,
                    content=content,
                    title=title,
                    fetch_method="httpx"
                )
            else:
                return FetchedArticle(
                    url=url,
                    final_url=final_url if final_url != url else None,
                    error="Could not extract content from page",
                    fetch_method="httpx"
                )
                
    except httpx.TimeoutException:
        return FetchedArticle(url=url, error="Request timed out", fetch_method="httpx")
    except httpx.HTTPStatusError as e:
        return FetchedArticle(
            url=url, 
            error=f"HTTP error: {e.response.status_code}",
            fetch_method="httpx"
        )
    except httpx.RequestError as e:
        return FetchedArticle(url=url, error=f"Request failed: {str(e)}", fetch_method="httpx")
    except Exception as e:
        return FetchedArticle(url=url, error=f"Extraction failed: {str(e)}", fetch_method="httpx")


async def fetch_with_browserless(
    url: str,
    timeout: float = 60.0,
    max_content_length: int = 5000
) -> FetchedArticle:
    """
    Fetch article using Browserless.io cloud browser service.
    
    Browserless handles Cloudflare and other bot detection automatically.
    Requires BROWSERLESS_API_KEY environment variable.
    """
    if not PLAYWRIGHT_AVAILABLE:
        return FetchedArticle(
            url=url,
            error="Playwright not installed. Run: pip install playwright",
            fetch_method="browserless"
        )
    
    if not BROWSERLESS_ENABLED:
        return FetchedArticle(
            url=url,
            error="Browserless not configured. Set BROWSERLESS_API_KEY environment variable.",
            fetch_method="browserless"
        )
    
    try:
        async with async_playwright() as p:
            # Connect to Browserless.io cloud browser
            browserless_url = f"wss://chrome.browserless.io?token={BROWSERLESS_API_KEY}"
            
            browser = await p.chromium.connect_over_cdp(browserless_url)
            
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
            )
            
            page = await context.new_page()
            
            # Navigate to URL
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            
            # Wait for Cloudflare challenge to complete (if present)
            for _ in range(15):  # Check up to 15 times (30 seconds total)
                await page.wait_for_timeout(2000)
                
                html = await page.content()
                
                # Check if we're still on a challenge page
                if "Verifying you are human" in html or "checking your browser" in html.lower() or "Just a moment" in html:
                    continue  # Still on challenge page, wait more
                
                # Check if we got actual content
                if "challenge-platform" not in html and len(html) > 5000:
                    break  # Likely got past the challenge
            
            # Try to wait for article content
            try:
                await page.wait_for_selector("article, main, .content, .article-body, .post-content, p", timeout=5000)
            except:
                pass
            
            # Capture final URL after all redirects
            final_url = page.url
            
            # Get the page content
            html = await page.content()
            
            await browser.close()
            
            content, title = extract_content_and_title(html, max_content_length)
            
            if content:
                return FetchedArticle(
                    url=url,
                    final_url=final_url if final_url != url else None,
                    content=content,
                    title=title,
                    fetch_method="browserless"
                )
            else:
                return FetchedArticle(
                    url=url,
                    final_url=final_url if final_url != url else None,
                    error="Could not extract content from page (Browserless)",
                    fetch_method="browserless"
                )
                
    except PlaywrightTimeout:
        return FetchedArticle(url=url, error="Browser navigation timed out (Browserless)", fetch_method="browserless")
    except Exception as e:
        return FetchedArticle(url=url, error=f"Browserless fetch failed: {str(e)}", fetch_method="browserless")


async def fetch_with_playwright(
    url: str,
    timeout: float = 30.0,
    max_content_length: int = 5000
) -> FetchedArticle:
    """
    Fetch article using Playwright headless browser (local).
    
    This is slower but handles JavaScript-rendered content and anti-bot protection.
    """
    if not PLAYWRIGHT_AVAILABLE:
        return FetchedArticle(
            url=url,
            error="Playwright not installed. Run: pip install playwright && playwright install chromium",
            fetch_method="playwright"
        )
    
    try:
        async with async_playwright() as p:
            # Launch with args to avoid detection
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                ]
            )
            
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
                java_script_enabled=True,
                bypass_csp=True,
            )
            
            page = await context.new_page()
            
            # Apply stealth to avoid bot detection
            if STEALTH_AVAILABLE:
                await stealth_async(page)
            else:
                # Fallback: Remove webdriver property to avoid detection
                await page.add_init_script("""
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => undefined
                    });
                """)
            
            # Navigate to URL
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            
            # Wait for Cloudflare challenge to complete (if present)
            # Cloudflare challenges typically take 3-8 seconds
            for _ in range(10):  # Check up to 10 times (20 seconds total)
                await page.wait_for_timeout(2000)
                
                html = await page.content()
                
                # Check if we're still on a challenge page
                if "Verifying you are human" in html or "checking your browser" in html.lower():
                    continue  # Still on challenge page, wait more
                
                # Check if we got redirected to actual content
                if "challenge-platform" not in html and len(html) > 5000:
                    break  # Likely got past the challenge
            
            # Try to wait for article content to appear
            try:
                await page.wait_for_selector("article, main, .content, .article-body, .post-content", timeout=5000)
            except:
                pass  # Continue even if selector not found
            
            # Capture final URL after all redirects
            final_url = page.url
            
            # Get the page content
            html = await page.content()
            
            await browser.close()
            
            content, title = extract_content_and_title(html, max_content_length)
            
            if content:
                return FetchedArticle(
                    url=url,
                    final_url=final_url if final_url != url else None,
                    content=content,
                    title=title,
                    fetch_method="playwright"
                )
            else:
                return FetchedArticle(
                    url=url,
                    final_url=final_url if final_url != url else None,
                    error="Could not extract content from page (Playwright)",
                    fetch_method="playwright"
                )
                
    except PlaywrightTimeout:
        return FetchedArticle(url=url, error="Browser navigation timed out", fetch_method="playwright")
    except Exception as e:
        return FetchedArticle(url=url, error=f"Browser fetch failed: {str(e)}", fetch_method="playwright")


async def fetch_article_content(
    url: str,
    timeout: float = 10.0,
    max_content_length: int = 5000,
    use_playwright_fallback: bool = True
) -> FetchedArticle:
    """
    Fetch and extract article content from a URL.
    
    Strategy:
    1. Resolve tracking URL to final destination (if it's a redirect)
    2. Try fast httpx fetch with browser-like headers on the final URL
    3. If blocked (403, 401, etc.), fall back to:
       a. Browserless.io (if configured) - best for Cloudflare bypass
       b. Local Playwright (if Browserless not available)
    
    Args:
        url: The URL to fetch
        timeout: Request timeout in seconds
        max_content_length: Maximum length of extracted content
        use_playwright_fallback: Whether to try Playwright/Browserless if httpx fails
        
    Returns:
        FetchedArticle with content or error message
    """
    original_url = url
    final_url = None
    
    # Step 1: Try to resolve tracking URL to final destination
    # This helps when the tracking domain (email.example.com) blocks content requests
    # but the final destination (example.com/article) is accessible
    resolved_url, resolve_error = await resolve_tracking_url(url, timeout)
    if resolved_url and resolved_url != url:
        final_url = resolved_url
        url = resolved_url  # Use the resolved URL for fetching
    
    # Step 2: Try with httpx (fast)
    result = await fetch_with_httpx(url, timeout, max_content_length)
    
    # Preserve the original URL and final URL info
    result.url = original_url
    if final_url:
        result.final_url = final_url
    
    # Step 3: Check if we should fall back to browser-based fetching
    if use_playwright_fallback and result.error:
        should_fallback = False
        
        # Check for HTTP errors that suggest anti-bot protection
        if result.error.startswith("HTTP error:"):
            try:
                status_code = int(result.error.split(": ")[1])
                should_fallback = status_code in FALLBACK_STATUS_CODES
            except (IndexError, ValueError):
                pass
        
        # Also try browser if content extraction failed
        if "Could not extract content" in (result.error or ""):
            should_fallback = True
        
        if should_fallback:
            browser_result = None
            
            # Step 3a: Try Browserless.io first (if configured) - best for Cloudflare
            if BROWSERLESS_ENABLED:
                browser_result = await fetch_with_browserless(
                    url,
                    timeout=max(timeout, 60.0),  # Browserless needs time for challenges
                    max_content_length=max_content_length
                )
                
                if browser_result.content:
                    browser_result.url = original_url
                    if final_url:
                        browser_result.final_url = final_url
                    return browser_result
            
            # Step 3b: Fall back to local Playwright (if Browserless failed or not configured)
            if PLAYWRIGHT_AVAILABLE and (not BROWSERLESS_ENABLED or not browser_result or not browser_result.content):
                playwright_result = await fetch_with_playwright(
                    url,
                    timeout=max(timeout, 30.0),
                    max_content_length=max_content_length
                )
                
                if playwright_result.content:
                    playwright_result.url = original_url
                    if final_url:
                        playwright_result.final_url = final_url
                    return playwright_result
                
                # Build error message with all fallback attempts
                fallback_errors = []
                if BROWSERLESS_ENABLED and browser_result:
                    fallback_errors.append(f"Browserless: {browser_result.error}")
                fallback_errors.append(f"Playwright: {playwright_result.error}")
                
                result.error = f"{result.error} (Fallbacks failed: {'; '.join(fallback_errors)})"
    
    return result


async def fetch_multiple_articles(
    urls: list[str],
    timeout: float = 10.0,
    max_content_length: int = 5000,
    max_concurrent: int = 5,
    use_playwright_fallback: bool = True
) -> dict[str, FetchedArticle]:
    """
    Fetch multiple articles concurrently.
    
    Args:
        urls: List of URLs to fetch
        timeout: Request timeout per URL
        max_content_length: Maximum content length per article
        max_concurrent: Maximum concurrent requests
        use_playwright_fallback: Whether to try Playwright if httpx fails
        
    Returns:
        Dictionary mapping URL to FetchedArticle
    """
    semaphore = asyncio.Semaphore(max_concurrent)
    
    async def fetch_with_semaphore(url: str) -> tuple[str, FetchedArticle]:
        async with semaphore:
            result = await fetch_article_content(
                url, 
                timeout, 
                max_content_length,
                use_playwright_fallback
            )
            return url, result
    
    tasks = [fetch_with_semaphore(url) for url in urls]
    results = await asyncio.gather(*tasks)
    
    return dict(results)
