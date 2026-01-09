$ErrorActionPreference = "Stop"

Write-Host "Starting download of dependencies..."

# Define URLs
$ffmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"

# 1. Download yt-dlp
Write-Host "Downloading yt-dlp.exe..."
Invoke-WebRequest -Uri $ytdlpUrl -OutFile "yt-dlp.exe"
Write-Host "yt-dlp.exe downloaded."

# 2. Download ffmpeg
Write-Host "Downloading ffmpeg release zip..."
$ffmpegZip = "ffmpeg.zip"
Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip
Write-Host "ffmpeg zip downloaded."

# 3. Extract ffmpeg
Write-Host "Extracting ffmpeg..."
Expand-Archive -Path $ffmpegZip -DestinationPath "ffmpeg_temp" -Force

# 4. Move ffmpeg.exe to root
$ffmpegExe = Get-ChildItem -Path "ffmpeg_temp" -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if ($ffmpegExe) {
    Move-Item -Path $ffmpegExe.FullName -Destination ".\ffmpeg.exe" -Force
    Write-Host "ffmpeg.exe moved to root."
} else {
    Write-Error "ffmpeg.exe not found in the downloaded zip."
}

# 5. Cleanup
Write-Host "Cleaning up temporary files..."
Remove-Item -Path $ffmpegZip -Force
Remove-Item -Path "ffmpeg_temp" -Recurse -Force

Write-Host "Success! ffmpeg.exe and yt-dlp.exe are ready."
