# TorrentHunt — VirusHunt Cleanup Script
# Run this script to delete all VirusHunt-related files from the project

Write-Host "=== TorrentHunt: VirusHunt Cleanup ===" -ForegroundColor Cyan

# VirusHunt pages (already stubbed, safe to delete)
$filesToDelete = @(
    "renderer\pages\VirusHuntPage.tsx",
    "renderer\pages\VirusHuntPage.css",
    "renderer\pages\VirusHuntPageSimple.tsx",
    "renderer\pages\DeepAnalysisPage.tsx",
    "renderer\pages\DeepAnalysisPage.css",
    
    # Backup files
    "renderer\pages\DownloadsPage.tsx.backup",
    "renderer\pages\SettingsPage.old.tsx",
    "renderer\pages\SettingsPage.tsx.backup",
    
    # VirusHunt context and hooks
    "renderer\contexts\VirusHuntContext.tsx",
    "renderer\hooks\virushunt-hooks.ts",
    
    # VirusHunt stores
    "renderer\stores\virusHuntStore.ts",
    "renderer\stores\scanHistoryStore.ts",
    
    # VirusHunt IPC handlers
    "electron\ipc\virushunt-handlers.ts",
    
    # Shared VirusHunt types
    "shared\virushunt-types.ts",
    "shared\virushunt-reputation-types.ts",
    "shared\virushunt-settings-schema.ts",
    "shared\virushunt-settings-types.ts",
    "shared\scan-report-types.ts"
)

# Documentation files
$docsToDelete = @(
    "VIRUSHUNT_*.md",
    "INSTALL_VIRUSHUNT_SETTINGS.md",
    "README_VIRUSHUNT_SETTINGS.md",
    "ADVANCED_HEURISTIC_ANALYZER.md",
    "DEEP_ANALYSIS_MODULES.md",
    "SCAN_RESULTS_GUIDE.md",
    "SCAN_RESULTS_IMPLEMENTATION.md",
    "REPORT_SYSTEM_*.md",
    "REPUTATION_SYSTEM_COMPLETE.md",
    "PRIVACY_AUDIT.md"
)

# Directories to remove
$dirsToDelete = @(
    "electron\virusHunt",
    "electron\reports",
    "electron\services\security"
)

# Delete files
foreach ($file in $filesToDelete) {
    $path = Join-Path $PSScriptRoot $file
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "  Deleted: $file" -ForegroundColor Green
    } else {
        Write-Host "  Not found: $file" -ForegroundColor Yellow
    }
}

# Delete docs with wildcards
foreach ($pattern in $docsToDelete) {
    $matches = Get-ChildItem -Path $PSScriptRoot -Filter $pattern -ErrorAction SilentlyContinue
    foreach ($match in $matches) {
        Remove-Item $match.FullName -Force
        Write-Host "  Deleted: $($match.Name)" -ForegroundColor Green
    }
}

# Delete directories
foreach ($dir in $dirsToDelete) {
    $path = Join-Path $PSScriptRoot $dir
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force
        Write-Host "  Deleted directory: $dir" -ForegroundColor Green
    } else {
        Write-Host "  Not found: $dir" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== Cleanup complete! ===" -ForegroundColor Cyan
Write-Host "You can now delete this script: cleanup-virushunt.ps1" -ForegroundColor Gray
