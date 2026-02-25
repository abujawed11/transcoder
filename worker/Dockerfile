FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

# Install Node.js 20 + ffmpeg (with nvenc support)
RUN apt-get update && \
    apt-get install -y curl ffmpeg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
CMD ["node", "index.js"]
