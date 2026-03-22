# ═══════════════════════════════════════════════════════════════
#  Media Downloader — Production Docker Image
#  Node.js 20 + Python3 + yt-dlp + ffmpeg
#  Works on: Railway, Render, Fly.io, any Docker host
# ═══════════════════════════════════════════════════════════════

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-setuptools \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (latest stable)
RUN pip3 install -U yt-dlp --break-system-packages

# Verify installations
RUN yt-dlp --version && ffmpeg -version | head -1

# Set working directory
WORKDIR /app

# Copy package files first (layer caching)
COPY package.json ./

# Install Node dependencies (production only)
RUN npm install --production --no-audit --no-fund

# Copy application files
COPY server.js   ./
COPY cluster.js  ./

# Create public directory for the frontend HTML
RUN mkdir -p public

# Copy frontend if it exists (optional)
COPY public/ ./public/ 2>/dev/null || true

# Non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start server
CMD ["node", "server.js"]
