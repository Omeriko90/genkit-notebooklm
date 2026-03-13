FROM node:22-slim

WORKDIR /app

# Copy everything at once
COPY . .

# Install and build
RUN npm install --ignore-scripts
RUN npx prisma generate
RUN npm run build

# Cloud Run will use PORT environment variable
EXPOSE 8080

CMD npx prisma migrate deploy && npm start 