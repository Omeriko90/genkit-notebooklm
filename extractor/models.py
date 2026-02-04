"""
Pydantic models for the Email Content Extractor Service
"""

from pydantic import BaseModel
from typing import Optional


class EmailInput(BaseModel):
    """Input model for email extraction"""
    html: str
    text: Optional[str] = None
    base_url: Optional[str] = None  # For resolving relative URLs


class ArticleOutput(BaseModel):
    """A single article/section extracted from the email"""
    text: str
    link: Optional[str] = None
    link_text: Optional[str] = None
    title: Optional[str] = None


class ExtractionResult(BaseModel):
    """Result of email content extraction"""
    articles: list[ArticleOutput]
    all_links: list[dict]
    main_content: Optional[str] = None
