"""
Extraction logic for the Email Content Extractor Service
"""

import re
from typing import Optional
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from constants import READ_MORE_REGEX
from models import ArticleOutput


def is_read_more_link(text: str) -> bool:
    """Check if link text indicates a 'read more' type link"""
    return bool(READ_MORE_REGEX.search(text))


def clean_url(url: str, base_url: Optional[str] = None) -> Optional[str]:
    """Clean and validate URL, resolve relative URLs"""
    if not url:
        return None
    
    url = url.strip()
    
    # Skip mailto, tel, javascript, anchors
    if url.startswith(('mailto:', 'tel:', 'javascript:', '#', 'data:')):
        return None
    
    # Resolve relative URLs
    if base_url and not url.startswith(('http://', 'https://')):
        url = urljoin(base_url, url)
    
    # Validate URL structure
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return None
    
    return url


def extract_links_from_html(soup: BeautifulSoup, base_url: Optional[str] = None) -> list[dict]:
    """Extract all links from HTML"""
    links = []
    seen_urls = set()
    
    for anchor in soup.find_all('a', href=True):
        url = clean_url(anchor['href'], base_url)
        if not url or url in seen_urls:
            continue
        
        seen_urls.add(url)
        text = anchor.get_text(strip=True)
        
        links.append({
            'url': url,
            'text': text,
            'is_read_more': is_read_more_link(text)
        })
    
    return links


def find_parent_content(element, max_chars: int = 1000) -> str:
    """Find meaningful parent content for a link"""
    # Walk up the DOM to find a container with substantial text
    for parent in element.parents:
        if parent.name in ['td', 'div', 'article', 'section', 'tr', 'li', 'p']:
            text = parent.get_text(separator=' ', strip=True)
            # Remove the link text itself from the content
            link_text = element.get_text(strip=True)
            text = text.replace(link_text, '').strip()
            
            if len(text) > 50:  # Meaningful content threshold
                return text[:max_chars]
    
    return ""


def extract_articles_from_newsletter(soup: BeautifulSoup, base_url: Optional[str] = None) -> list[ArticleOutput]:
    """Extract individual articles from a newsletter email"""
    articles = []
    seen_links = set()
    
    # Strategy 1: Find "read more" links and their surrounding content
    for anchor in soup.find_all('a', href=True):
        text = anchor.get_text(strip=True)
        
        if is_read_more_link(text):
            url = clean_url(anchor['href'], base_url)
            if not url or url in seen_links:
                continue
            
            seen_links.add(url)
            
            # Get parent content
            content = find_parent_content(anchor)
            
            # Try to find a title (h1-h4 or strong/b in parent)
            title = None
            for parent in anchor.parents:
                if parent.name in ['td', 'div', 'article', 'section']:
                    heading = parent.find(['h1', 'h2', 'h3', 'h4', 'strong', 'b'])
                    if heading:
                        title = heading.get_text(strip=True)
                        break
            
            if content:
                articles.append(ArticleOutput(
                    text=content,
                    link=url,
                    link_text=text,
                    title=title
                ))
    
    # Strategy 2: If no read-more links found, look for article-like structures
    if not articles:
        # Look for common newsletter article containers
        containers = soup.find_all(['article', 'div', 'td'], class_=re.compile(
            r'(article|story|post|item|content|entry)', re.IGNORECASE
        ))
        
        for container in containers[:10]:  # Limit to first 10
            text = container.get_text(separator=' ', strip=True)
            if len(text) < 100:  # Skip small containers
                continue
            
            # Find first meaningful link
            link_elem = container.find('a', href=True)
            url = clean_url(link_elem['href'], base_url) if link_elem else None
            
            if url and url not in seen_links:
                seen_links.add(url)
                articles.append(ArticleOutput(
                    text=text[:1000],
                    link=url,
                    link_text=link_elem.get_text(strip=True) if link_elem else None
                ))
    
    return articles
