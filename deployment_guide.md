# Stream Studio Deployment Guide

Currently, your application is configured to run on **Windows** because it points to local `.exe` files (`ffmpeg.exe`, `yt-dlp.exe`) in `server.js`.

To deploy this to a live server, you have two main options:

---

## Option 1: Deploy to a Windows VPS (Easiest)
Since your project is already set up for Windows, this is the path of least resistance.

1.  **Rent a Windows VPS** (e.g., AWS EC2 Windows, Azure, or a cheap provider like Contabo Windows VPS).
2.  **Install Node.js** on the VPS.
3.  **Copy your entire project folder** (`MyStreamServer`) to the VPS.
4.  Open PowerShell on the VPS, navigate to the folder, and run:
    ```powershell
    npm install
    npm start
    ```
5.  **Access it**: You will need to open port `3000` in the Windows Firewall on the VPS.

---

## Option 2: Deploy to a Linux Server (Ubuntu/Debian)
Linux servers are cheaper and more common for Node.js, but active code changes are required because `.exe` files do not run on Linux.

### 1. Update `server.js`
You must change how the paths are defined.
**Current (Windows):**
```javascript
const ytPath = path.join(__dirname, 'yt-dlp.exe');
const ffmpegPath = path.join(__dirname, 'ffmpeg.exe');
```

**Change to (Linux Friendly):**
```javascript
// Check platform to decide (Cross-platform compatible)
const isWin = process.platform === "win32";
const ytPath = isWin ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
const ffmpegPath = isWin ? path.join(__dirname, 'ffmpeg.exe') : 'ffmpeg';
```

### 2. Install Dependencies on Linux
SSH into your Linux server and run:
```bash
# Update and install Node.js
sudo apt update
sudo apt install nodejs npm

# Install FFmpeg
sudo apt install ffmpeg

# Install yt-dlp (System wide)
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 3. Run the App
```bash
npm install
node server.js
```

---

## Important Note on "Persistent" Deployment
To keep the app running even when you close the terminal, install `pm2`:
```bash
npm install -g pm2
pm2 start server.js --name "stream-studio"
pm2 save
```

---

## ❌ Why you CANNOT use Vercel or Netlify
You might be tempted to use free hosts like Vercel, Netlify, or AWS Lambda. **This application will NOT work there.**

**Reason:**
1.  **Serverless Limits:** Vercel functions kill processes after ~10-60 seconds. Your stream needs to run for hours.
2.  **No Background Processes:** You cannot spawn `ffmpeg` and keep it running in the background on Vercel.
3.  **Binary Dependencies:** This app depends on specific binary executables (`.exe` on Windows, binaries on Linux). Vercel behaves differently.

---

## Option 3: Deploy to Render (Via Docker)

We have added a `Dockerfile` so you can deploy easily on Render.

1.  **Push this code to GitHub/GitLab**.
2.  Go to [dashboard.render.com](https://dashboard.render.com/) -> New -> **Web Service**.
3.  Connect your repository.
4.  **Important**: Render should automatically detect the `Dockerfile`.
    *   **Runtime**: Docker
    *   **Plan**: You probably need standard+. Converting video is CPU intensive. **Free tier might fail or be very slow.**
5.  **Deploy**.

Render will build the container (installing FFmpeg/yt-dlp automatically) and start the server.
