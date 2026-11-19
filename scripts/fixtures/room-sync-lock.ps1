# Actual Windows sharing violation: readers are allowed, rename/delete/write are denied.
# This helper only receives a path inside the isolated native test fixture.
param([Parameter(Mandatory = $true)][string]$LiteralPath)
$ErrorActionPreference = 'Stop'
$handle = $null
try {
    $handle = [System.IO.File]::Open($LiteralPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    [Console]::Out.WriteLine('LOCKED')
    [Console]::Out.Flush()
    [void][Console]::In.ReadLine()
} finally {
    if ($null -ne $handle) { $handle.Dispose() }
}
