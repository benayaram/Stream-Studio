const express = require('express');
const bodyParser = require('body-parser');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); // Load environment variables

const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(bodyParser.json());

// ============ CONFIGURATION ============
const TARGET_URL = process.env.TARGET_URL;
const STREAM_KEY = process.env.STREAM_KEY;
const PROXY = process.env.PROXY || "";

// VALIDATION
if (!TARGET_URL || !STREAM_KEY) {
    console.error("❌ MISSING CONFIGURATION: TARGET_URL or STREAM_KEY is undefined.");
    console.error("👉 Please check your .env file.");
    // Don't exit process, but warn heavily. Stream start will fail anyway.
} else {
    console.log(`✅ Configuration Loaded: Target=${TARGET_URL} | Key=****${STREAM_KEY.slice(-4)}`);
}
// =======================================

// Path pointers
const isWin = process.platform === "win32";

// On Windows: Use local .exe files in project root
// On Linux/Render: Use system-installed 'ffmpeg' and 'yt-dlp' commands
const ytPath = isWin ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
const ffmpegPath = isWin ? path.join(__dirname, 'ffmpeg.exe') : 'ffmpeg';

// Initialize with default or generic name
let overlayPath = path.join(__dirname, 'overlay.png');

// --- STATE MANAGEMENT ---
let activeProcess = { dl: null, ff: null };
let currentStreamConfig = { url: null, layout: null, mode: 'portrait', background: null, logo: null, logoLayout: null };
let streamStartTime = 0; // Timestamp when ORIGINAL stream started

// --- MULTER SETUP (File Uploads) ---
// Save uploaded images to 'uploads/' folder
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
        // Keep original name or timestamp to avoid cache
        const typePrefix = req.body.type === 'logo' ? 'logo-' : 'bg-';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, typePrefix + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- COOKIE HELPER (Fixes JSON format from extensions) ---
function ensureNetscapeCookies() {
    const p = path.join(__dirname, 'cookies.txt');
    let content = "";

    // 1. Try ENV first (Best for Render/Security)
    if (process.env.YOUTUBE_COOKIES) {
        content = process.env.YOUTUBE_COOKIES;
    }
    // 2. Try Local File
    else if (fs.existsSync(p)) {
        content = fs.readFileSync(p, 'utf8');
    } else {
        return; // No cookies found
    }

    // 3. Check if JSON and Convert
    if (content.trim().startsWith('[')) {
        console.log("🍪 Detected JSON cookies. Converting to Netscape format for yt-dlp...");
        try {
            const cookies = JSON.parse(content);
            let netscape = "# Netscape HTTP Cookie File\n";
            cookies.forEach(c => {
                const domain = c.domain;
                const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
                const path = c.path;
                const secure = c.secure ? 'TRUE' : 'FALSE';
                const expiration = Math.round(c.expirationDate || (Date.now() / 1000 + 31536000));
                const name = c.name;
                const value = c.value;
                netscape += `${domain}\t${flag}\t${path}\t${secure}\t${expiration}\t${name}\t${value}\n`;
            });
            fs.writeFileSync(p, netscape);
            console.log("✅ Cookies converted and saved to cookies.txt");
        } catch (e) {
            console.error("❌ Failed to convert cookies:", e.message);
        }
    } else if (process.env.YOUTUBE_COOKIES) {
        // If ENV was plain text, write it to file so yt-dlp can read it
        fs.writeFileSync(p, content);
    }
}
// Run immediately on start
ensureNetscapeCookies();


// Endpoint to upload a new asset (Background or Logo)
app.post('/api/upload', upload.single('overlayImage'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const type = req.body.type || 'background'; // 'background' or 'logo'
    const newPath = req.file.path;
    const isLogo = type === 'logo';

    console.log(`✅ New ${type} uploaded: ${newPath}`);

    // Cleanup previous file of the SAME TYPE
    const oldPath = isLogo ? currentStreamConfig.logo : currentStreamConfig.background;

    // Only delete if it was an uploaded file (in uploads/ folder) and exists
    if (oldPath && oldPath.includes('uploads') && fs.existsSync(oldPath)) {
        try {
            fs.unlinkSync(oldPath);
            console.log(`🗑 Deleted old ${type}: ${oldPath}`);
        } catch (e) {
            console.error(`⚠️ Failed to delete old ${type}:`, e.message);
        }
    }

    // Update Global State
    if (isLogo) {
        currentStreamConfig.logo = newPath;
    } else {
        currentStreamConfig.background = newPath;
        // Also update legacy variable for backward compat if needed, or just rely on state
        overlayPath = newPath;
    }

    // Return relative path for frontend preview
    res.json({
        message: `${isLogo ? 'Logo' : 'Background'} updated!`,
        path: `/uploads/${req.file.filename}`,
        type: type
    });
});

// Endpoint to serve the CURRENT stats
app.get('/api/status', (req, res) => {
    // Check purely based on if the process object exists
    res.json({
        active: !!activeProcess.ff,
        currentConfig: currentStreamConfig
    });
});

app.post('/api/stream', (req, res) => {
    const { action, url, layout } = req.body;

    if (action === 'stop') {
        killStream();
        killStream();
        // Clear config only on manual stop
        // Don't fully clear state, maybe keep images for next run? 
        // For now, reset core stream params but keep images if desired by user logic.
        // But user asked to "reset". Let's reset stream specific stuff.
        currentStreamConfig.url = null;
        streamStartTime = 0;
        return res.json({ message: "⛔ Stream Stopped" });
    }

    if (action === 'start') {
        killStream();
        // Default safe layout if none provided
        const safeLayout = layout || { x: 0, y: 500, w: 1080, h: 607 };
        const safeMode = req.body.mode || 'portrait';
        // Logo layout (optional)
        if (req.body.logoLayout) currentStreamConfig.logoLayout = req.body.logoLayout;

        // Ensure background is set (default if null)
        if (!currentStreamConfig.background) currentStreamConfig.background = path.join(__dirname, 'overlay.png');

        // Reset timer on fresh start
        streamStartTime = Date.now();

        // Small delay to ensure previous FFmpeg closes
        setTimeout(() => startStream(url, safeLayout, 0, safeMode), 1000);
        return res.json({ message: "✅ Starting Stream..." });
    }

    if (action === 'change_source') {
        if (!url) return res.status(400).json({ message: "URL required for source change" });

        console.log("🔄 Changing Stream Source...");
        killStream();

        // Reset timer because it's a new video source!
        streamStartTime = Date.now();

        // Use existing layout if not provided (safety)
        const layoutToUse = currentStreamConfig.layout || { x: 0, y: 500, w: 1080, h: 607 };
        const modeToUse = currentStreamConfig.mode || 'portrait';

        setTimeout(() => startStream(url, layoutToUse, 0, modeToUse), 1000);
        return res.json({ message: "✅ Stream Source Changed!" });
    }

    if (action === 'update_overlay') {
        if (!activeProcess.ff) {
            return res.status(400).json({ message: "❌ No active stream to update." });
        }

        // UPDATE LAYOUT IF PROVIDED
        if (layout) {
            console.log(`📝 Received new layout:`, layout);
            currentStreamConfig.layout = layout;
        }
        if (req.body.logoLayout) {
            currentStreamConfig.logoLayout = req.body.logoLayout;
        }
        if (req.body.mode) {
            currentStreamConfig.mode = req.body.mode;
        }

        // CALCULATE RESUME TIME
        const elapsedSeconds = (Date.now() - streamStartTime) / 1000;
        console.log(`🔄 Hot-swapping overlay (Resuming at ${Math.round(elapsedSeconds)}s)...`);

        killStream(); // Temporarily stop

        // Force a small delay to ensure cleanup
        setTimeout(() => {
            if (currentStreamConfig.url && currentStreamConfig.layout) {
                startStream(currentStreamConfig.url, currentStreamConfig.layout, elapsedSeconds, currentStreamConfig.mode);
                return res.json({ message: "✅ Layers Updated (Resuming...)" });
            } else {
                return res.status(500).json({ message: "❌ Missing stream config for restart." });
            }
        }, 1500);
        return;
    }
});

function killStream() {
    // Windows specifically needs taskkill /F /PID to ensure it's gone along with children
    // Use try-catch because if PID doesn't exist, exec sync might throw or stderr
    if (activeProcess.dl) {
        try {
            if (activeProcess.dl.pid) exec(`taskkill /pid ${activeProcess.dl.pid} /f /t`);
        } catch (e) {
            console.log("Error killing DL:", e.message);
        }
        activeProcess.dl = null;
    }
    if (activeProcess.ff) {
        try {
            if (activeProcess.ff.pid) exec(`taskkill /pid ${activeProcess.ff.pid} /f /t`);
        } catch (e) {
            console.log("Error killing FF:", e.message);
        }
        activeProcess.ff = null;
    }
    console.log("Stopped previous stream processes (Force Kill).");
}

function startStream(sourceLink, layout, seekTime = 0, mode = 'portrait') {
    // Store current config for restarts
    currentStreamConfig.url = sourceLink;
    currentStreamConfig.layout = layout;
    currentStreamConfig.mode = mode;

    const startTimeAttempt = Date.now();

    console.log(`🚀 Starting Stream. Seek: ${seekTime}s. Mode: ${mode}. Layout: X=${layout.x}, Y=${layout.y}, W=${layout.w}, H=${layout.h}`);

    // 1. Configure Downloader (yt-dlp)
    // Try to look like a real browser to avoid "Sign in" errors
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    let dlArgs = [
        '-o', '-',
        '-f', 'best[height<=1080]',
        '--retries', 'infinite',
        '--fragment-retries', 'infinite',
        '--no-part',
        '--user-agent', userAgent,
        '--referer', 'https://www.youtube.com/'
    ];

    // Add Seek if restarting (Using download-sections for VOD/Live seek)
    // Note: LIVE streams might behave differently, but this is the standard 'resume' method for yt-dlp
    if (seekTime > 5) {
        dlArgs.push('--download-sections', `*${seekTime}-inf`);
    }

    if (PROXY) dlArgs.push('--proxy', PROXY);

    // CHECK FOR COOKIES (Fixes "Sign in to confirm you’re not a bot")
    // Use cookies.txt if it exists. otherwise proceed without cookies (User Request)
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        console.log("🍪 Found cookies.txt! Using for authentication.");
        dlArgs.push('--cookies', cookiesPath);
    } else {
        console.log("🍪 No cookies.txt found. Proceeding without authentication (Local Mode).");
    }

    dlArgs.push(sourceLink);

    activeProcess.dl = spawn(ytPath, dlArgs);

    // 2. Configure FFmpeg (The Mixer)
    const canvasSize = mode === 'landscape' ? '1920x1080' : '1080x1920';
    const bgPath = currentStreamConfig.background || path.join(__dirname, 'overlay.png');
    const hasLogo = !!currentStreamConfig.logo;
    const logoLayout = currentStreamConfig.logoLayout || { x: 0, y: 0, w: 200, h: 200 };

    let ffmpegArgs = [
        '-re',
        '-i', 'pipe:0',                  // Input 0: Video Pipe
        '-loop', '1', '-i', bgPath,      // Input 1: Background Layer
    ];

    if (hasLogo) {
        ffmpegArgs.push('-loop', '1', '-i', currentStreamConfig.logo); // Input 2: Logo Layer
    }

    // FILTER LOGIC:
    // [1:v] (Background) -> [bg_final]
    // [0][v] (Video) -> [vid]
    // [bg_final][vid]overlay -> [layer1]
    // [layer1][2:v]overlay -> [out] (if logo)

    let finalFilter = `[1:v]scale=${canvasSize}[bg_final];[0:v]scale=${layout.w}:${layout.h}[vid];[bg_final][vid]overlay=${layout.x}:${layout.y}`;

    if (hasLogo) {
        // Correctly label the first overlay output as [layer1] so the second one can pick it up
        finalFilter = `[1:v]scale=${canvasSize}[bg_final];[0:v]scale=${layout.w}:${layout.h}[vid];[bg_final][vid]overlay=${layout.x}:${layout.y}[layer1]`;
        finalFilter += `;[2:v]scale=${logoLayout.w}:${logoLayout.h}[logo_final];[layer1][logo_final]overlay=${logoLayout.x}:${logoLayout.y}`;
    }

    // Replace our args
    ffmpegArgs.push(
        '-filter_complex', finalFilter,
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '3000k',
        '-pix_fmt', 'yuv420p', '-g', '60',
        '-max_muxing_queue_size', '400',

        '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
        '-shortest',
        '-f', 'flv',
        `${TARGET_URL}/${STREAM_KEY}`
    );

    activeProcess.ff = spawn(ffmpegPath, ffmpegArgs);

    // Pipe Downloader -> FFmpeg
    activeProcess.dl.stdout.pipe(activeProcess.ff.stdin);

    // Prevent Node crash on pipe error
    const handlePipeError = (err) => {
        if (err.code !== 'EPIPE' && err.code !== 'EOF') {
            console.error(`[Pipe Error]: ${err.message}`);
        }
    };
    activeProcess.dl.stdout.on('error', handlePipeError);
    activeProcess.dl.stdout.on('error', handlePipeError);
    activeProcess.ff.stdin.on('error', handlePipeError);

    // ENSURE FFmpeg DIES WHEN DOWNLOADER DIES (Fixes "Stream not ending")
    // ENSURE FFmpeg DIES WHEN DOWNLOADER DIES
    activeProcess.dl.on('close', (code) => {
        console.log(`[Downloader] Exited with code ${code}.`);

        // Capture specific FFmpeg PID to avoid killing a *new* session by mistake later
        const currentFFPid = activeProcess.ff ? activeProcess.ff.pid : null;

        if (code === 0) {
            console.log("✅ Download complete. Waiting for FFmpeg to finish remaining buffer...");

            // Do NOT force kill immediately. Let '-shortest' handling the exit.
            // Safety: Force kill after 30 seconds if it hangs
            setTimeout(() => {
                if (activeProcess.ff && activeProcess.ff.pid === currentFFPid) {
                    console.log("⚠️ FFmpeg timed out closing. Force killing.");
                    try { exec(`taskkill /pid ${currentFFPid} /f /t`); } catch (e) { }
                    activeProcess.ff = null;
                }
            }, 30000);

        } else {
            // Error case: Kill immediately
            console.log("❌ Downloader failed. Stopping Stream immediately.");
            if (activeProcess.ff) {
                try { exec(`taskkill /pid ${activeProcess.ff.pid} /f /t`); } catch (e) { }
                activeProcess.ff = null;
            }
        }
    });

    // --- CLEANER LOGGING ---

    // --- CLEANER LOGGING ---
    activeProcess.dl.stderr.on('data', d => {
        const msg = d.toString();
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('warning')) {
            console.log(`[DL Log]: ${msg.trim()}`);
        }
    });
    activeProcess.ff.stderr.on('data', d => {
        const msg = d.toString();
        if (!msg.match(/frame=\s*\d+/) && (msg.toLowerCase().includes('error') || msg.includes('!'))) {
            console.log(`[FFmpeg Log]: ${msg.trim()}`);
        }
    });

    // --- SELF-HEALING: Check for immediate crash on seek ---
    activeProcess.dl.on('close', (code) => {
        const durationAlive = Date.now() - startTimeAttempt;

        // If it died quickly (under 5s) AND we were seeking
        if (code !== 0 && durationAlive < 5000 && seekTime > 0) {
            console.error(`❌ Seek seems to have caused a crash (Code ${code}). Restarting stream WITHOUT seek...`);

            // Clean up FFmpeg if it's still hanging around (waiting for input)
            if (activeProcess.ff) activeProcess.ff.kill();

            // Allow a moment, then restart fresh (lose progress, but keep stream alive)
            setTimeout(() => {
                startStream(sourceLink, layout, 0, mode); // Recursive retry with 0 seek
            }, 1000);
            return;
        }

        // Normal cleanup
        if (activeProcess.ff) {
            // console.log(`[DL Exit] Code: ${code}`); 
        }
    });

    activeProcess.ff.on('close', (code) => {
        // If we didn't manually set it to null (via killStream), it logicially finished.
        if (activeProcess.ff) {
            console.log(`[Stream Exit] Code: ${code}. Cleaning up state.`);
            if (activeProcess.dl) {
                try { activeProcess.dl.kill(); } catch (e) { }
            }
            activeProcess.ff = null;
            activeProcess.dl = null;
        }
    });
}


app.listen(PORT, () => {
    console.log(`\n✅ STUDIO SERVER RUNNING!`);
    console.log(`👉 Open Dashboard: http://localhost:${PORT}`);
});
