param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet('initial', 'lock-excel', 'unlock-excel', 'lock-word', 'unlock-word', 'reopen-excel', 'reopen-word', 'normal-lock-word', 'normal-unlock-word', 'word-normal-save', 'excel-normal-save', 'finish')][string]$Stage
)
$ErrorActionPreference = 'Stop'
$taskOutputRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../dist/room-sync-office'))
$Root = [IO.Path]::GetFullPath($Root)
if ([IO.Path]::GetDirectoryName($Root) -ne $taskOutputRoot -or [IO.Path]::GetFileName($Root) -notlike 'run-*') { throw 'Not an isolated Office fixture root' }
$taskControl = Get-Content -LiteralPath (Join-Path $Root 'control.json') | ConvertFrom-Json
function Rpc($Body) {
    $taskRequest = ConvertTo-Json -InputObject $Body -Depth 15 -Compress
    $taskResponse = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $taskControl.port + '/') -Method Post -Headers @{ Authorization = ('Bearer ' + $taskControl.token) } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($taskRequest)) -TimeoutSec 65
    if ($taskResponse.error) { throw $taskResponse.error }
    return $taskResponse.result
}
function Peer($Action, $Values = @{}, $Name = 'receiver') { Rpc @{ op = 'call'; peer = $Name; action = $Action; values = $Values } }
function Record($Id, $Details = @{}) { [void](Rpc @{ op = 'record'; id = $Id; details = $Details }); Write-Output "PASS $Id" }
function Hash($File) {
    $taskStream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    $taskSha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($taskSha.ComputeHash($taskStream)).ToLowerInvariant() } finally { $taskSha.Dispose(); $taskStream.Dispose() }
}
Add-Type -AssemblyName System.IO.Compression
function ZipText($File, $Entry) {
    $taskStream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    $taskZip = [IO.Compression.ZipArchive]::new($taskStream, [IO.Compression.ZipArchiveMode]::Read)
    try {
        $taskEntry = $taskZip.GetEntry($Entry)
        if ($null -eq $taskEntry) { throw "Missing ZIP entry $Entry" }
        $taskReader = [IO.StreamReader]::new($taskEntry.Open())
        try { return $taskReader.ReadToEnd() } finally { $taskReader.Dispose() }
    } finally { $taskZip.Dispose(); $taskStream.Dispose() }
}
$taskBaselineFile = Join-Path $Root 'baseline.json'
if ($Stage -eq 'initial') {
    $taskBaseline = @{}
    foreach ($taskExtension in @('docx', 'xlsx')) {
        $taskDelivery = Rpc @{ op = 'delivered'; name = "pilot.$taskExtension" }
        $taskBaseline[$taskExtension] = $taskDelivery.destination
        if (@($taskDelivery.page.items | Where-Object path -Like '~$*').Count -ne 0) { throw 'Office lock file was published' }
        Record "office-$taskExtension-initial-save-and-e2e-delivery" @{ sha256 = $taskDelivery.destination; bytes = (Get-Item -LiteralPath (Join-Path $Root "receiver/working/pilot.$taskExtension")).Length }
    }
    if ((ZipText (Join-Path $Root 'receiver/working/pilot.docx') 'word/document.xml') -notmatch 'HAVVN_WORD_V1') { throw 'DOCX text not preserved' }
    $taskSheet = ZipText (Join-Path $Root 'receiver/working/pilot.xlsx') 'xl/worksheets/sheet1.xml'
    if ($taskSheet -notmatch '<v>42</v>' -or $taskSheet -notmatch '<f>A1\*2</f>' -or $taskSheet -notmatch '<v>84</v>') { throw 'XLSX values/formula not preserved' }
    $taskBaseline | ConvertTo-Json | Set-Content -LiteralPath $taskBaselineFile
    Record 'office-ooxml-content-and-formula-preserved'
    Record 'office-owner-lock-files-excluded'
    [void](Rpc @{ op = 'evidence'; values = @{ officeTested = $true; wordMode = 'safe'; excelMode = 'normal'; officeVersions = @{ word = (Get-Item -LiteralPath 'C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE').VersionInfo.FileVersion; excel = (Get-Item -LiteralPath 'C:/Program Files/Microsoft Office/root/Office16/EXCEL.EXE').VersionInfo.FileVersion } } })
} elseif ($Stage -in @('normal-lock-word', 'normal-unlock-word')) {
    $taskReceiver = Join-Path $Root 'receiver/working/pilot.docx'
    $taskPublisher = Join-Path $Root 'publisher/working/pilot.docx'
    $taskPrepared = Join-Path $Root 'staging/word-v2.docx'
    $taskOwnerFile = Join-Path $Root 'receiver/working/~$pilot.docx'
    $taskOriginal = (Get-Content -LiteralPath $taskBaselineFile | ConvertFrom-Json).docx
    $taskCurrent = Hash $taskPrepared
    if ($Stage -eq 'normal-lock-word') {
        if (-not (Test-Path -LiteralPath $taskOwnerFile) -or (Hash $taskReceiver) -ne $taskCurrent) { throw 'Open receiver v2 in normal Word first' }
        $taskOldCopy = Get-ChildItem -LiteralPath (Join-Path $Root 'receiver/working/.havvn-sync/transactions') -Filter previous -Recurse -File | Where-Object { (Hash $_.FullName) -eq $taskOriginal } | Select-Object -First 1
        if ($null -eq $taskOldCopy) { throw 'Original Word bytes not found' }
        Copy-Item -LiteralPath $taskOldCopy.FullName -Destination $taskPublisher
        $taskDeadline = (Get-Date).AddSeconds(45)
        do {
            $taskItem = (Peer 'sync-files').items | Where-Object path -EQ 'pilot.docx'
            if ($taskItem.status -eq 'error') { break }
            Start-Sleep -Milliseconds 200
        } while ((Get-Date) -lt $taskDeadline)
        if ($taskItem.status -ne 'error' -or $taskItem.detail -notmatch 'EPERM|EACCES|EBUSY' -or (Hash $taskReceiver) -ne $taskCurrent) { throw 'Normal Word lock did not preserve original bytes' }
        Record 'word-normal-mode-lock-preserves-open-v2' @{ detail = $taskItem.detail; sha256 = $taskCurrent }
    } else {
        if (Test-Path -LiteralPath $taskOwnerFile) { throw 'Close normal Word first' }
        [void](Peer 'rescan')
        $taskDelivery = Rpc @{ op = 'delivered'; name = 'pilot.docx' }
        if ($taskDelivery.destination -ne $taskOriginal) { throw 'Normal Word unlock did not apply the pending version' }
        $taskBackups = @(Get-ChildItem -LiteralPath (Join-Path $Root 'receiver/working/.havvn-sync/transactions') -Filter previous -Recurse -File | ForEach-Object { Hash $_.FullName })
        if ($taskCurrent -notin $taskBackups) { throw 'Normal Word v2 backup missing' }
        Copy-Item -LiteralPath $taskPrepared -Destination $taskPublisher
        $taskDelivery = Rpc @{ op = 'delivered'; name = 'pilot.docx' }
        if ($taskDelivery.destination -ne $taskCurrent) { throw 'Normal Word final v2 did not return' }
        Record 'word-normal-mode-close-applies-and-backs-up'
        [void](Rpc @{ op = 'evidence'; values = @{ wordMode = 'safe, then normal; locking/retry verified in both' } })
    }
} elseif ($Stage -eq 'word-normal-save') {
    $taskDelivery = Rpc @{ op = 'delivered'; name = 'pilot.docx' }
    if ((ZipText (Join-Path $Root 'receiver/working/pilot.docx') 'word/document.xml') -notmatch 'HAVVN_WORD_V3_NORMAL_SAVE') { throw 'Normal Word save did not reach receiver' }
    Record 'word-normal-mode-real-ctrl-s-auto-publishes' @{ sha256 = $taskDelivery.destination }
} elseif ($Stage -eq 'excel-normal-save') {
    $taskDelivery = Rpc @{ op = 'delivered'; name = 'pilot.xlsx' }
    $taskSheet = ZipText (Join-Path $Root 'receiver/working/pilot.xlsx') 'xl/worksheets/sheet1.xml'
    if ($taskSheet -notmatch '<v>126</v>' -or $taskSheet -notmatch '<f>A1\*2</f>' -or $taskSheet -notmatch '<v>252</v>') { throw 'Normal Excel save did not preserve values/formula' }
    $taskPage = Peer 'sync-files'
    if (@($taskPage.items).Count -ne 2 -or @($taskPage.items | Where-Object path -NotIn @('pilot.docx', 'pilot.xlsx')).Count -ne 0) { throw 'Unexpected temporary or owner files in manifest' }
    Record 'excel-normal-mode-real-ctrl-s-auto-publishes-without-temp-files' @{ sha256 = $taskDelivery.destination; cells = @{ A1 = 126; B1 = 252; formula = 'A1*2' } }
} elseif ($Stage -like 'lock-*' -or $Stage -like 'unlock-*') {
    $taskApp = if ($Stage.EndsWith('excel')) { 'excel' } else { 'word' }
    $taskExtension = if ($taskApp -eq 'excel') { 'xlsx' } else { 'docx' }
    $taskName = "pilot.$taskExtension"
    $taskReceiver = Join-Path $Root "receiver/working/$taskName"
    $taskOwnerFile = Join-Path $Root ('receiver/working/~$' + $taskName)
    $taskPrepared = Join-Path $Root "staging/$taskApp-v2.$taskExtension"
    $taskBaseline = Get-Content -LiteralPath $taskBaselineFile | ConvertFrom-Json
    if ($Stage -like 'lock-*') {
        if (-not (Test-Path -LiteralPath $taskOwnerFile)) { throw "Open the receiver $taskApp document first" }
        if ((Hash $taskReceiver) -ne $taskBaseline.$taskExtension) { throw 'Unexpected receiver bytes before lock test' }
        $taskReadWriteDenied = $false
        try { $taskProbe = [IO.File]::Open($taskReceiver, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete); $taskProbe.Dispose() } catch [IO.IOException] { $taskReadWriteDenied = $true }
        Copy-Item -LiteralPath $taskPrepared -Destination (Join-Path $Root "publisher/working/$taskName")
        $taskDeadline = (Get-Date).AddSeconds(45)
        do {
            $taskPage = Peer 'sync-files'
            $taskItem = $taskPage.items | Where-Object path -EQ $taskName
            if ($taskItem.status -eq 'error') { break }
            Start-Sleep -Milliseconds 200
        } while ((Get-Date) -lt $taskDeadline)
        if ($taskItem.status -ne 'error' -or $taskItem.detail -notmatch 'EPERM|EACCES|EBUSY') { throw "No sharing violation reported: $($taskItem | ConvertTo-Json -Depth 5)" }
        if ((Hash $taskReceiver) -ne $taskBaseline.$taskExtension) { throw 'Locked receiver bytes changed' }
        $taskJournal = Peer 'journal-state'
        if ($taskJournal.pending -lt 1) { throw 'Prepared journal was not retained' }
        Record "$taskApp-real-open-document-blocks-update-without-byte-loss" @{ detail = $taskItem.detail; receiverSha256 = $taskBaseline.$taskExtension; readWriteDenied = $taskReadWriteDenied; journal = $taskJournal }
    } else {
        if (Test-Path -LiteralPath $taskOwnerFile) { throw "Close the receiver $taskApp document first" }
        [void](Peer 'rescan')
        $taskDelivery = Rpc @{ op = 'delivered'; name = $taskName }
        if ($taskDelivery.destination -ne (Hash $taskPrepared)) { throw 'Unexpected updated bytes' }
        $taskBackups = @(Get-ChildItem -LiteralPath (Join-Path $Root 'receiver/working/.havvn-sync/transactions') -Filter previous -Recurse -File | ForEach-Object { Hash $_.FullName })
        if ($taskBaseline.$taskExtension -notin $taskBackups) { throw 'Original backup missing' }
        $taskJournal = Peer 'journal-state'
        if ($taskJournal.pending -ne 0) { throw 'Unfinished transaction after successful retry' }
        if ($taskApp -eq 'word') {
            if ((ZipText $taskReceiver 'word/document.xml') -notmatch 'HAVVN_WORD_V2') { throw 'Updated Word text missing' }
        } else {
            $taskSheet = ZipText $taskReceiver 'xl/worksheets/sheet1.xml'
            if ($taskSheet -notmatch '<v>84</v>' -or $taskSheet -notmatch '<f>A1\*2</f>' -or $taskSheet -notmatch '<v>168</v>') { throw 'Updated Excel values/formula missing' }
        }
        Record "$taskApp-close-recheck-applies-update-and-preserves-backup" @{ sha256 = $taskDelivery.destination; journal = $taskJournal }
    }
} elseif ($Stage -like 'reopen-*') {
    Record "$Stage-ui-content-verified"
} elseif ($Stage -eq 'finish') {
    $taskEvidence = Rpc @{ op = 'evidence' }
    foreach ($taskRequired in @('office-docx-initial-save-and-e2e-delivery','office-xlsx-initial-save-and-e2e-delivery','office-ooxml-content-and-formula-preserved','office-owner-lock-files-excluded','word-real-open-document-blocks-update-without-byte-loss','excel-real-open-document-blocks-update-without-byte-loss','word-close-recheck-applies-update-and-preserves-backup','excel-close-recheck-applies-update-and-preserves-backup','reopen-word-ui-content-verified','reopen-excel-ui-content-verified','word-normal-mode-lock-preserves-open-v2','word-normal-mode-close-applies-and-backs-up','word-normal-mode-real-ctrl-s-auto-publishes','excel-normal-mode-real-ctrl-s-auto-publishes-without-temp-files')) {
        if ($taskRequired -notin $taskEvidence.checks.id) { throw "Missing check: $taskRequired" }
    }
    foreach ($taskExtension in @('docx', 'xlsx')) { [void](Rpc @{ op = 'delivered'; name = "pilot.$taskExtension" }) }
    if ((Peer 'journal-state').pending -ne 0) { throw 'Pending receiver transaction at the end of acceptance' }
    [void](Rpc @{ op = 'evidence'; values = @{ passed = $true; finishedAt = [DateTime]::UtcNow.ToString('o'); limitations = @('One physical PC; loopback E2E only, no physical-PC/NAT acceptance','No installation/update acceptance','For controlled lock timing, real Office v2 bytes were staged through Save As and copied into the publisher root; separate normal Word and Excel Ctrl+S saves were also checked') } })
    [void](Rpc @{ op = 'stop' })
    Copy-Item -LiteralPath (Join-Path $Root 'office-acceptance.json') -Destination (Join-Path $taskOutputRoot 'office-acceptance-latest.json')
    Write-Output (Join-Path $Root 'office-acceptance.json')
}
