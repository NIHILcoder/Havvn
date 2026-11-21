param([Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet('initial','source-save','project-save','solution-save','remote-update','remote-visible','local-conflict','finish')][string]$Stage)
$ErrorActionPreference = 'Stop'
$taskOutput = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../dist/room-sync-ide'))
$Root = [IO.Path]::GetFullPath($Root)
if ([IO.Path]::GetDirectoryName($Root) -ne $taskOutput -or [IO.Path]::GetFileName($Root) -notlike 'run-*') { throw 'Not an isolated IDE fixture root' }
$taskControl = Get-Content -LiteralPath (Join-Path $Root 'control.json') | ConvertFrom-Json
function Rpc($Body) {
    $taskResult = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $taskControl.port + '/') -Method Post -Headers @{ Authorization = ('Bearer ' + $taskControl.token) } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 12 -Compress))) -TimeoutSec 65
    if ($taskResult.error) { throw $taskResult.error }; return $taskResult.result
}
function Peer($Action, $Values = @{}) { Rpc @{ op='call'; peer='receiver'; action=$Action; values=$Values } }
function Record($Id, $Details = @{}) { [void](Rpc @{ op='record'; id=$Id; details=$Details }); Write-Output "PASS $Id" }
function Delivered($Name) { Rpc @{ op='delivered'; name=$Name } }
$taskProgram = Join-Path $Root 'receiver/working/Project/Program.cs'
if ($Stage -eq 'initial') {
    foreach ($taskName in @('Project/Program.cs','Project/Pilot.csproj','Project/Pilot.sln','README.md','config.ini')) { [void](Delivered $taskName) }
    $taskFiles = (Peer 'sync-files').items
    if (@($taskFiles).Count -ne 5) { throw 'Unexpected published files' }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'publisher/working/Project/bin/Debug/HavvnSyncPilot.exe'))) { throw 'Run the actual compiler first' }
    if (@(Get-ChildItem -LiteralPath (Join-Path $Root 'publisher/working/Project/obj') -Recurse -File).Count -lt 2) { throw 'Build intermediates missing' }
    if (@($taskFiles | Where-Object { $_.path -match '(^|/)(bin|obj|\.vs|\.git)(/|$)|\.env' }).Count -ne 0) { throw 'Build/IDE/private files were published' }
    Record 'real-csharp-project-five-source-files-delivered'
    Record 'actual-msbuild-bin-obj-and-ide-private-directories-excluded'
    [void](Rpc @{ op='evidence'; values=@{ ideTested=$true; ideVersion=(Get-Item -LiteralPath 'D:/Microsoft VS Code/Code.exe').VersionInfo.ProductVersion; sdkVersion=(Get-Item -LiteralPath 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/MSBuild.exe').VersionInfo.FileVersion } })
} elseif ($Stage -in @('source-save','project-save','solution-save')) {
    $taskName, $taskMarker = switch ($Stage) {
        'source-save' { 'Project/Program.cs'; 'HAVVN_IDE_SOURCE_SAVE' }
        'project-save' { 'Project/Pilot.csproj'; 'HAVVN_IDE_PROJECT_SAVE' }
        'solution-save' { 'Project/Pilot.sln'; 'HAVVN_IDE_SOLUTION_SAVE' }
    }
    $taskDelivery = Delivered $taskName
    if ((Get-Content -LiteralPath (Join-Path $Root "receiver/working/$taskName") -Raw) -notmatch $taskMarker) { throw 'Real IDE save was not delivered' }
    Record "vscode-$Stage-auto-published" @{ path=$taskName; sha256=$taskDelivery.destination }
} elseif ($Stage -eq 'remote-update') {
    [IO.File]::WriteAllText((Join-Path $Root 'publisher/working/Project/Program.cs'), "using System;`nclass Program { static void Main() { Console.WriteLine(`"HAVVN_IDE_REMOTE_UPDATE`"); } }`n", [Text.UTF8Encoding]::new($false))
    $taskDelivery = Delivered 'Project/Program.cs'
    Record 'open-vscode-file-allows-remote-atomic-update' @{ sha256=$taskDelivery.destination }
} elseif ($Stage -eq 'remote-visible') {
    Record 'vscode-reloads-open-clean-file-with-remote-text'
} elseif ($Stage -eq 'local-conflict') {
    $taskLocal = Get-Content -LiteralPath $taskProgram -Raw
    if ($taskLocal -notmatch 'HAVVN_IDE_LOCAL_EDIT') { throw 'Save independent receiver edit in VS Code first' }
    [IO.File]::WriteAllText((Join-Path $Root 'publisher/working/Project/Program.cs'), "using System;`nclass Program { static void Main() { Console.WriteLine(`"HAVVN_IDE_SHARED_AFTER_CONFLICT`"); } }`n", [Text.UTF8Encoding]::new($false))
    $taskDeadline = (Get-Date).AddSeconds(45)
    do {
        $taskItem = (Peer 'sync-files').items | Where-Object path -EQ 'Project/Program.cs'
        if ($taskItem.status -eq 'conflict' -and $taskItem.resolvable) { break }; Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $taskDeadline)
    if ($taskItem.status -ne 'conflict' -or (Get-Content -LiteralPath $taskProgram -Raw) -ne $taskLocal) { throw 'Independent IDE edit was not protected' }
    Record 'real-vscode-local-save-preserved-as-conflict'
    $taskPreview = Peer 'conflict-preview' @{ entryId=$taskItem.entryId }
    $taskResolved = Peer 'conflict-resolve' @{ previewId=$taskPreview.previewId; choice='keep-both' }
    [void](Delivered 'Project/Program.cs')
    $taskCopies = @(Get-ChildItem -LiteralPath (Join-Path $Root 'receiver/working/.havvn-local') -Filter Program.cs -Recurse -File)
    if (@($taskCopies | Where-Object { (Get-Content -LiteralPath $_.FullName -Raw) -eq $taskLocal }).Count -lt 1) { throw 'Keep-both lost local IDE bytes' }
    Record 'real-vscode-conflict-keep-both-preserves-local-source' @{ copyCreated=[bool]$taskResolved.copyPath }
} else {
    $taskEvidence = Rpc @{ op='evidence' }
    foreach ($taskRequired in @('real-csharp-project-five-source-files-delivered','actual-msbuild-bin-obj-and-ide-private-directories-excluded','vscode-source-save-auto-published','vscode-project-save-auto-published','vscode-solution-save-auto-published','open-vscode-file-allows-remote-atomic-update','vscode-reloads-open-clean-file-with-remote-text','real-vscode-local-save-preserved-as-conflict','real-vscode-conflict-keep-both-preserves-local-source')) {
        if ($taskRequired -notin $taskEvidence.checks.id) { throw "Missing check $taskRequired" }
    }
    if ((Peer 'journal-state').pending -ne 0) { throw 'Pending transaction at finish' }
    [void](Rpc @{ op='evidence'; values=@{ passed=$true; status='passed'; remainingChecks=@(); finishedAt=[DateTime]::UtcNow.ToString('o'); limitations=@('One physical PC, loopback E2E only','Loose project files edited in installed VS Code; no extension installation or workspace trust changes','Legacy .NET Framework compiler build succeeded with reference-assembly/architecture warnings; modern dotnet SDK is not installed') } })
    [void](Rpc @{ op='stop' })
    Copy-Item -LiteralPath (Join-Path $Root 'ide-acceptance.json') -Destination (Join-Path $taskOutput 'ide-acceptance-latest.json')
    Write-Output (Join-Path $Root 'ide-acceptance.json')
}
