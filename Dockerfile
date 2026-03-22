# ─────────────────────────────────────────────────────
#  Media Downloader — Docker image  (FIXED)
#  Node.js 20 + yt-dlp (latest) + ffmpeg + Python
# ─────────────────────────────────────────────────────

FROM node:20-slim

# Install Python + pip + ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# ✅ FIX: Always install the LATEST yt-dlp at build time
# This fixes "Server error 500" caused by stale YouTube extractor
RUN pip3 install --upgrade pip --break-system-packages && \
    pip3 install -U yt-dlp --break-system-packages

# Verify tools installed correctly
RUN yt-dlp --version && ffmpeg -version | head -1

# Set working directory
WORKDIR /app

# Copy package files and install Node.js dependencies
COPY package.json ./
RUN npm install --production

# Copy all app files
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
