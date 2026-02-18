"""
Pydantic models for the Email Content Extractor Service
"""

from pydantic import BaseModel, Field
from typing import Optional


class EmailInput(BaseModel):
    """Input model for email extraction"""
    html: str
    text: Optional[str] = None
    base_url: Optional[str] = None  # For resolving relative URLs
    fetch_timeout: float = Field(
        default=30.0,
        description="Timeout in seconds for fetching each article"
    )
    max_fetch_content: int = Field(
        default=5000,
        description="Maximum character length for fetched article content"
    )


class ArticleOutput(BaseModel):
    """A single article/section extracted from the email"""
    text: str
    link: Optional[str] = None
    link_text: Optional[str] = None
    title: Optional[str] = None
    # Fetched content fields
    fetched_content: Optional[str] = Field(
        default=None,
        description="Full article content fetched from the link"
    )
    fetched_title: Optional[str] = Field(
        default=None,
        description="Title extracted from the fetched article"
    )
    fetched_url: Optional[str] = Field(
        default=None,
        description="Final URL after redirects (useful for tracking links)"
    )
    fetch_error: Optional[str] = Field(
        default=None,
        description="Error message if fetching failed"
    )
    fetch_method: Optional[str] = Field(
        default=None,
        description="Method used to fetch: 'httpx' or 'playwright'"
    )


class ExtractionResult(BaseModel):
    """Result of email content extraction"""
    articles: list[ArticleOutput]
    all_links: list[dict]
    main_content: Optional[str] = None
    articles_fetched: bool = Field(
        default=False,
        description="Whether article content was fetched from links"
    )


class ResolveUrlsInput(BaseModel):
    """Input for URL resolution endpoint"""
    urls: list[str] = Field(
        description="List of URLs to resolve (tracking links will be followed to final destination)"
    )
    timeout: float = Field(
        default=10.0,
        description="Timeout in seconds for resolving each URL"
    )


class ResolvedUrl(BaseModel):
    """A single resolved URL"""
    original_url: str
    final_url: Optional[str] = None
    error: Optional[str] = None


class ResolveUrlsResult(BaseModel):
    """Result of URL resolution"""
    urls: list[ResolvedUrl]
