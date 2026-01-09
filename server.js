const express = require('express');
const bodyParser = require('body-parser');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const multer = require('multer');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(bodyParser.json());

// ============ CONFIGURATION ============
const TARGET_URL = "rtmp://a.rtmp.youtube.com/live2";
const STREAM_KEY = "wg0v-kakk-1quj-yadm-2ac0";
const PROXY = ""; // Add Proxy URL here if needed (e.g., "http://user:pass@ip:port")
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
let currentStreamConfig = { url: null, layout: null };
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
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Endpoint to upload a new overlay
app.post('/api/upload', upload.single('overlayImage'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    // Update the global overlay path to the new file
    overlayPath = req.file.path;
    console.log(`✅ New overlay set: ${overlayPath} `);

    // Return relative path for frontend preview
    res.json({
        message: 'Overlay updated!',
        path: `/uploads/${req.file.filename}`
    });
});

// Endpoint to serve the CURRENT overlay image (dynamic)
app.get('/overlay_preview', (req, res) => {
    if (fs.existsSync(overlayPath)) {
        res.sendFile(overlayPath);
    } else {
        res.status(404).send("Overlay image not found.");
    }
});

// Endpoint to check if stream is active
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
        // Clear config only on manual stop
        currentStreamConfig = { url: null, layout: null };
        streamStartTime = 0;
        return res.json({ message: "⛔ Stream Stopped" });
    }

    if (action === 'start') {
        killStream();
        // Default safe layout if none provided
        const safeLayout = layout || { x: 0, y: 500, w: 1080, h: 607 };

        // Reset timer on fresh start
        streamStartTime = Date.now();

        // Small delay to ensure previous FFmpeg closes
        setTimeout(() => startStream(url, safeLayout, 0), 1000);
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

        setTimeout(() => startStream(url, layoutToUse, 0), 1000);
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

        // CALCULATE RESUME TIME
        const elapsedSeconds = (Date.now() - streamStartTime) / 1000;
        console.log(`🔄 Hot-swapping overlay (Resuming at ${Math.round(elapsedSeconds)}s)...`);

        killStream(); // Temporarily stop

        // Force a small delay to ensure cleanup
        setTimeout(() => {
            if (currentStreamConfig.url && currentStreamConfig.layout) {
                startStream(currentStreamConfig.url, currentStreamConfig.layout, elapsedSeconds);
                return res.json({ message: "✅ Overlay & Layout Updated (Resuming...)" });
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

function startStream(sourceLink, layout, seekTime = 0) {
    // Store current config for restarts
    currentStreamConfig = { url: sourceLink, layout: layout };
    const startTimeAttempt = Date.now();

    console.log(`🚀 Starting Stream. Seek: ${seekTime}s. Layout: X=${layout.x}, Y=${layout.y}, W=${layout.w}, H=${layout.h}`);

    // 1. Configure Downloader (yt-dlp)
    let dlArgs = ['-o', '-', '-f', 'best[height<=1080]', '--no-part'];

    // Add Seek if restarting (Using download-sections for VOD/Live seek)
    // Note: LIVE streams might behave differently, but this is the standard 'resume' method for yt-dlp
    if (seekTime > 5) {
        dlArgs.push('--download-sections', `*${seekTime}-inf`);
    }

    if (PROXY) dlArgs.push('--proxy', PROXY);
    dlArgs.push(sourceLink);

    activeProcess.dl = spawn(ytPath, dlArgs);

    // 2. Configure FFmpeg (The Mixer)
    const filterComplex = `
color=s=1080x1920:c=black[bg];
[0:v]scale=${layout.w}:${layout.h}[vid];
[bg][vid]overlay=${layout.x}:${layout.y}[layer1];
[layer1][1:v]overlay=0:0
    `.replace(/\s/g, '');

    activeProcess.ff = spawn(ffmpegPath, [
        '-re',
        '-i', 'pipe:0',                  // Input 0: Video Pipe
        '-loop', '1', '-i', overlayPath, // Input 1: Overlay Image

        '-filter_complex', filterComplex,

        '-c:v', 'libx264', '-preset', 'ultrafast', // fast preset for local test
        '-b:v', '4500k', '-maxrate', '5000k', '-bufsize', '10000k',
        '-pix_fmt', 'yuv420p', '-g', '60',

        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-shortest', // Stop encoding when shortest input (the video) ends
        '-f', 'flv',
        `${TARGET_URL}/${STREAM_KEY}`
    ]);

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
                startStream(sourceLink, layout, 0); // Recursive retry with 0 seek
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
