# YPM Youth Awards: verify an ENCRYPTED Development backup through a
# temporary decrypted copy, then delete the copy.
#
# Run in your own PowerShell window. Any password is typed only into
# 7-Zip's or GnuPG's own prompt; this script never sees or stores it.
#
#   cd C:\Users\Bright\Downloads\ypm-awards
#   powershell -ExecutionPolicy Bypass -File scripts\verify-encrypted-backup.ps1 -Backup "<path>"
#
# <path> is one of:
#   *.7z or *.zip        encrypted with 7-Zip (password prompt from 7-Zip)
#   *.gpg, *.pgp, *.asc  encrypted with GnuPG (prompt from GnuPG); may contain
#                        a .zip/.7z/.tar of the folder
#   a folder             already readable (e.g. on a BitLocker or EFS drive):
#                        checked in place, nothing copied
# The backup must contain the three files dev-backup.ps1 writes:
# backup.dump, backup.sha256 and counts.tsv (in any subfolder).
#
# The temporary copy goes to %TEMP%\ypm-verify-<random> and is deleted at
# the end, even if verification fails. The encrypted original is only read.
param(
  [Parameter(Mandatory = $true)][string]$Backup,
  [string]$Expect = '004'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $Backup)) { throw "Not found: $Backup" }

function Find-Tool([string[]]$candidates) {
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}
$sevenZip = Find-Tool @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")
$gpg = Find-Tool @("$env:ProgramFiles\GnuPG\bin\gpg.exe", "${env:ProgramFiles(x86)}\GnuPG\bin\gpg.exe",
                   "$env:ProgramFiles\Git\usr\bin\gpg.exe")

function Expand-Archive7([string]$archive, [string]$dest) {
  if (-not $sevenZip) { throw '7-Zip not found.' }
  & $sevenZip x $archive "-o$dest" -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7-Zip could not extract $archive (wrong password?)." }
}

$tmp = $null
$exit = 1
try {
  $item = Get-Item -LiteralPath $Backup
  if ($item.PSIsContainer) {
    $root = $item.FullName
    Write-Host "Checking the folder in place: $root"
  } else {
    $tmp = Join-Path $env:TEMP ('ypm-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $ext = $item.Extension.ToLowerInvariant()
    if ($ext -in '.7z', '.zip') {
      Expand-Archive7 $item.FullName $tmp
    } elseif ($ext -in '.gpg', '.pgp', '.asc') {
      if (-not $gpg) { throw 'GnuPG (gpg.exe) not found.' }
      $plain = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($item.Name))
      & $gpg --quiet --output $plain --decrypt $item.FullName
      if ($LASTEXITCODE -ne 0) { throw 'GnuPG could not decrypt the file (wrong passphrase or key?).' }
      if ($plain -match '\.(zip|7z|tar)$') { Expand-Archive7 $plain $tmp; Remove-Item -LiteralPath $plain -Force }
    } else {
      throw "Don't know how to open '$ext'. Use a .7z/.zip, a .gpg file, or a decrypted folder."
    }
    $root = $tmp
    Write-Host "Decrypted to a temporary folder: $tmp"
  }

  $dump = Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'backup.dump' | Select-Object -First 1
  if (-not $dump) { throw 'No backup.dump inside. Was this made with scripts\dev-backup.ps1?' }
  $dir = $dump.DirectoryName
  $missing = @('backup.sha256', 'counts.tsv') | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dir $_)) }
  if ($missing) { throw ("Missing next to backup.dump: " + ($missing -join ', ') + '. The verifier needs all three files.') }

  & node (Join-Path $repo 'scripts\verify-dev-backup.mjs') $dir --expect $Expect --rehearse
  $exit = $LASTEXITCODE
} finally {
  if ($tmp -and (Test-Path -LiteralPath $tmp)) {
    Remove-Item -LiteralPath $tmp -Recurse -Force
    if (Test-Path -LiteralPath $tmp) { Write-Warning "Could not delete $tmp. Delete it by hand." }
    else { Write-Host 'Temporary decrypted copy deleted.' }
  }
}
exit $exit
