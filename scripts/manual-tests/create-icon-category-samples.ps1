param([Parameter(Mandatory = $true)][string]$TargetDirectory)

$files = [ordered]@{
  'image.png' = 245KB
  'archive.zip' = 18MB
  'code.js' = 6KB
  'text.txt' = 2KB
  'spreadsheet.xlsx' = 42KB
  'audio.mp3' = 4.8MB
  'video.mp4' = 128MB
}

New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
foreach ($file in $files.GetEnumerator()) {
  $filePath = Join-Path $TargetDirectory $file.Key
  if (Test-Path -LiteralPath $filePath) { continue }
  $stream = [System.IO.File]::Create($filePath)
  try { $stream.SetLength([long]$file.Value) } finally { $stream.Dispose() }
}

$files.Keys | ForEach-Object {
  Get-Item -LiteralPath (Join-Path $TargetDirectory $_) | Select-Object Name, Length
}
