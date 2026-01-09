FROM node:18-slim

# 1. Install System Dependencies (FFmpeg + Python for yt-dlp)
RUN apt-get update && \
    apt-get install -y ffmpeg python3 curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# 2. Install yt-dlp (Linux Binary)
# We download it directly to /usr/local/bin so it's in the PATH
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# 3. App Setup
WORKDIR /app
COPY package*.json ./
RUN npm install

# 4. Copy Code
COPY . .

# 5. Env & Run
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
