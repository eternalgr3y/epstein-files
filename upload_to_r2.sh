#!/bin/bash
RCLONE=~/.local/bin/rclone
BUCKET="r2:epstein-files"

echo "Starting upload to Cloudflare R2..."
echo "This will take 3-4 hours at 21 Mbps"
echo ""

# Upload raw files (PDFs, videos, audio)
echo "=== Uploading raw files (23GB) ==="
$RCLONE sync /mnt/e/epstein-files/raw/ $BUCKET/raw/ --progress --transfers 4

# Upload extracted images
echo "=== Uploading images (6.4GB) ==="
$RCLONE sync /mnt/e/epstein-files/images/ $BUCKET/images/ --progress --transfers 4

# Upload thumbnails  
echo "=== Uploading thumbnails ==="
$RCLONE sync /mnt/e/epstein-files/thumbnails/ $BUCKET/thumbnails/ --progress --transfers 4

echo ""
echo "=== Upload complete! ==="
$RCLONE size $BUCKET
