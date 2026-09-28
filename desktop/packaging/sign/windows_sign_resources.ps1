# Authenticode-signs the executables and native modules in the staged
# resources (market-edge-exec.exe, *.pyd, *.dll; node.exe is already signed by
# the OpenJS Foundation and is left as shipped) before `tauri build`. Tauri
# then signs the app exe and the NSIS/MSI installers with the same
# certificate (bundle.windows.certificateThumbprint).
# usage: windows_sign_resources.ps1 -Dir <staged bundle dir> -Thumbprint <cert thumbprint>
param([Parameter(Mandatory)] [string] $Dir, [Parameter(Mandatory)] [string] $Thumbprint,
      [string] $TimestampUrl = "http://timestamp.digicert.com")
$ErrorActionPreference = "Stop"
$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
$files = Get-ChildItem -Path $Dir -Recurse -Include *.exe,*.dll,*.pyd | Where-Object { $_.Name -ne "node.exe" }
$files | ForEach-Object -Begin { $batch = @() } -Process { $batch += $_.FullName } -End {
  for ($i = 0; $i -lt $batch.Count; $i += 50) {
    & $signtool.FullName sign /sha1 $Thumbprint /fd sha256 /tr $TimestampUrl /td sha256 $batch[$i..([Math]::Min($i + 49, $batch.Count - 1))]
    if ($LASTEXITCODE -ne 0) { throw "signtool failed" }
  }
}
Write-Output "signed $($files.Count) files in $Dir"
