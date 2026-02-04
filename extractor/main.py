"""
Email Content Extractor Service

A FastAPI microservice that extracts structured content from newsletter emails.
Extracts article text and "read more" links using BeautifulSoup and trafilatura.
"""

from fastapi import FastAPI, HTTPException
from bs4 import BeautifulSoup
from trafilatura import extract

from models import EmailInput, ExtractionResult, ArticleOutput
from extractors import extract_links_from_html, extract_articles_from_newsletter
from fetcher import fetch_multiple_articles

app = FastAPI(
    title="Email Content Extractor",
    description="Extracts structured content from newsletter emails",
    version="1.0.0"
)


@app.post("/extract", response_model=ExtractionResult)
async def extract_content(email: EmailInput):
    """
    Extract structured content from a newsletter email.
    
    Returns articles with their text content and "read more" links.
    Optionally fetches full article content from the links when fetch_articles=true.
    """
    try:
        soup = BeautifulSoup(email.html, 'lxml')
        
        # Remove script, style, and hidden elements
        for element in soup.find_all(['script', 'style', 'noscript']):
            element.decompose()
        
        # Extract all links
        all_links = extract_links_from_html(soup, email.base_url)
        
        # Extract articles
        articles = extract_articles_from_newsletter(soup, email.base_url)
        
        # Use trafilatura for main content extraction as fallback
        main_content = None
        if not articles:
            main_content = extract(email.html, include_links=True, include_images=False)
            if main_content:
                # Find a prominent link
                prominent_link = next(
                    (l for l in all_links if l['is_read_more'] or len(l['text']) > 10),
                    None
                )
                articles.append(ArticleOutput(
                    text=main_content[:2000],
                    link=prominent_link['url'] if prominent_link else None,
                    link_text=prominent_link['text'] if prominent_link else None
                ))
        
        # Fetch article content if requested
        articles_fetched = False
        if email.fetch_articles and articles:
            # Collect URLs to fetch
            urls_to_fetch = [a.link for a in articles if a.link]
            
            if urls_to_fetch:
                # Fetch all articles concurrently
                fetched_results = await fetch_multiple_articles(
                    urls=urls_to_fetch,
                    timeout=email.fetch_timeout,
                    max_content_length=email.max_fetch_content
                )
                
                # Update articles with fetched content
                for article in articles:
                    if article.link and article.link in fetched_results:
                        fetched = fetched_results[article.link]
                        article.fetched_content = fetched.content
                        article.fetched_title = fetched.title
                        article.fetch_error = fetched.error
                
                articles_fetched = True
        
        return ExtractionResult(
            articles=articles,
            all_links=all_links,
            main_content=main_content,
            articles_fetched=articles_fetched
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e)}")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8081)
