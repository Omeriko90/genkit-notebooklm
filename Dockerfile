# Stage 1: Build Synthesis (Node.js)
FROM node:18-slim AS builder

WORKDIR /app/synthesis
COPY synthesis/package.json synthesis/package-lock.json* ./
RUN npm ci
COPY synthesis/ ./
RUN npx prisma generate
RUN npm run build

# Stage 2: Runtime with both Python + Node.js
FROM python:3.11-slim

# Install Node.js 18
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install system dependencies + supervisor + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2-dev \
    libxslt-dev \
    build-essential \
    supervisor \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
WORKDIR /app/extractor
COPY extractor/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Download NLTK data (used by newspaper3k)
RUN python -c "import nltk; nltk.download('punkt_tab', download_dir='/usr/local/nltk_data')"

# Copy extractor source
COPY extractor/ ./

# Copy built Synthesis from Stage 1
WORKDIR /app/synthesis
COPY --from=builder /app/synthesis/node_modules ./node_modules
COPY --from=builder /app/synthesis/dist ./dist
COPY --from=builder /app/synthesis/prisma ./prisma
COPY --from=builder /app/synthesis/package.json ./

# Re-run prisma generate for linux platform
RUN npx prisma generate

# Create tmp directory for ffmpeg mergeToFile
RUN mkdir -p /app/synthesis/tmp

# Copy supervisor config
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 8080

CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
