# YPM Youth Awards: back up the DEVELOPMENT database before a migration.
#
# Run in your own PowerShell window. The password is typed at the prompt,
# kept only in this window's process for the duration of the script, and
# never written to disk. Refuses any connection that isn't the Development
# project (vliytvqhjvuhulpvmuat).
#
#   cd C:\Users\Bright\Downloads\ypm-awards
#   powershell -ExecutionPolicy Bypass -File scripts\dev-backup.ps1 -Label pre-005
#
# If the direct host doesn't resolve (it is IPv6 only on some plans), copy
# the "Session pooler" host and user from the Development dashboard
# (Connect button) and pass them:
#   ... -DbHost aws-0-<region>.pooler.supabase.com -DbUser postgres.vliytvqhjvuhulpvmuat
#
# Writes to %USERPROFILE%\ypm-backups\dev-<label>-<time>\ (outside the repo):
#   backup.dump    pg_dump custom format, schemas public and ypm_private
#   counts.tsv     row count of every table, taken just after the dump
#   backup.sha256  SHA-256 of backup.dump
# Then check it offline:  node scripts\verify-dev-backup.mjs <that folder>
param(
  [string]$Label = 'pre-005',
  [string]$DbHost = 'db.vliytvqhjvuhulpvmuat.supabase.co',
  [string]$DbUser = 'postgres',
  [int]$Port = 5432
)
$ErrorActionPreference = 'Stop'
$Ref = 'vliytvqhjvuhulpvmuat'

if (($DbHost + ' ' + $DbUser) -notmatch $Ref) {
  throw "Refusing: neither the host nor the user names the Development project ($Ref)."
}
if ($Label -notmatch '^[a-z0-9-]+$') { throw 'Label: lower-case letters, digits and dashes only.' }

$bin = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory | Sort-Object { [int]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName 'bin' } | Where-Object { Test-Path (Join-Path $_ 'pg_dump.exe') } |
  Select-Object -First 1
if (-not $bin) { throw 'pg_dump.exe not found under C:\Program Files\PostgreSQL.' }

$out = Join-Path $env:USERPROFILE ("ypm-backups\dev-$Label-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $out | Out-Null

$secure = Read-Host "Development database password for $DbUser@$DbHost" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $env:PGSSLMODE = 'require'
  $env:PGCLIENTENCODING = 'UTF8'
  # Every session this script opens is read-only.
  $env:PGOPTIONS = '-c default_transaction_read_only=on'
  $conn = @('-h', $DbHost, '-p', "$Port", '-U', $DbUser, '-d', 'postgres')

  # Which project is this really? Shown so you can stop if it's wrong.
  & (Join-Path $bin 'psql.exe') @conn -X -At -c "select current_database(), current_user, version()"
  if ($LASTEXITCODE -ne 0) { throw 'Could not connect.' }

  Write-Host 'Dumping public and ypm_private...'
  & (Join-Path $bin 'pg_dump.exe') @conn -Fc -n public -n ypm_private -f (Join-Path $out 'backup.dump')
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }

  $countSql = @"
select table_schema || '.' || table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_schema in ('public', 'ypm_private') and table_type = 'BASE TABLE'
order by 1
"@
  & (Join-Path $bin 'psql.exe') @conn -X -At -F "`t" -c $countSql -o (Join-Path $out 'counts.tsv')
  if ($LASTEXITCODE -ne 0) { throw 'Counting rows failed.' }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:PGPASSWORD, Env:PGOPTIONS -ErrorAction SilentlyContinue
}

$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $out 'backup.dump')).Hash
Set-Content -Encoding ascii (Join-Path $out 'backup.sha256') $hash
Write-Host ''
Write-Host "Backup folder: $out"
Write-Host "SHA-256:       $hash"
Write-Host "Next: node scripts\verify-dev-backup.mjs `"$out`""
