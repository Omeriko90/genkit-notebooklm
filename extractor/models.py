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
    fetch_articles: bool = Field(
        default=False,
        description="If true, fetch full article content from 'read more' links"
    )
    fetch_timeout: float = Field(
        default=10.0,
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
    fetch_error: Optional[str] = Field(
        default=None,
        description="Error message if fetching failed"
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
