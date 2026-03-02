# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Runtime stage
FROM node:20-slim

# Install Chromium dependencies required by Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies (without postinstall to avoid Chrome download)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built output from builder
COPY --from=builder /app/build ./build

# Explicitly download the pinned Chrome version used by Puppeteer
RUN node node_modules/puppeteer/install.mjs 2>/dev/null || \
    node -e "import('./node_modules/puppeteer/install.mjs')" 2>/dev/null || true

ENV MCP_TRANSPORT=http
ENV MCP_PORT=3000
ENV MCP_BASE_URL=http://localhost:3000
ENV PDF_TTL_MS=600000
ENV PUPPETEER_NO_SANDBOX=true

EXPOSE 3000

CMD ["node", "build/index.js"]
