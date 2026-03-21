# ─────────────────────────────────────────────────────
#  Media Downloader — Docker image
#  Node.js + yt-dlp + Python all in one
#  Railway uses this automatically — no setup needed
# ─────────────────────────────────────────────────────

FROM node:20-slim

# Install Python + pip + ffmpeg (needed by yt-dlp)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp (the download engine — supports 1000+ sites)
RUN pip3 install -U yt-dlp --break-system-packages

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
