FROM node:22-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy everything at once
COPY . .

# Install and build
RUN npm install --ignore-scripts
RUN npx prisma generate
RUN npm run build

# Cloud Run will use PORT environment variable
EXPOSE 8080

CMD npx prisma migrate deploy && npm start 