FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for lxml and newspaper3k
RUN apt-get update && apt-get install -y \
    libxml2-dev \
    libxslt-dev \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download NLTK data for newspaper3k
RUN python -c "import nltk; nltk.download('punkt')"

COPY . .

EXPOSE 8081

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
