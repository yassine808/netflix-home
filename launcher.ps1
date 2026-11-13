# netflix-home launcher
#
# Starts the Express server (hidden), opens the app in the default browser, and
# parks a small minimized window in the taskbar. Clicking that taskbar button
# opens the page again and drops back to minimized. Closing it stops the server
# it started. Launch it with start.vbs so no console window flashes.

param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://localhost:$Port"
$log = Join-Path $root 'launcher.log'

function Write-Log([string]$message) {
  try {
    Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
  } catch {
    # logging must never break the launcher
  }
}

function Test-Port([int]$value) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $value, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Open-App {
  Start-Process $url
}

# One taskbar button per machine: a second double-click just reopens the page.
$existing = Get-Process powershell -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -eq 'netflix-home' -and $_.Id -ne $PID }
if ($existing) {
  Write-Log 'launcher already running; opening browser only'
  Open-App
  exit 0
}

# --- server ----------------------------------------------------------------

$server = $null
$ownsServer = $false

if (-not (Test-Port $Port)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show(
      'Node.js was not found on PATH. Install Node, then run start.vbs again.',
      'netflix-home'
    ) | Out-Null
    exit 1
  }

  $env:PORT = [string]$Port
  $server = Start-Process -FilePath $node `
    -ArgumentList 'server/index.js' `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru
  $ownsServer = $true
  Write-Log "server started (pid $($server.Id)) on port $Port"

  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-Port $Port)) {
    if ($server.HasExited) {
      [System.Windows.Forms.MessageBox]::Show(
        "The server exited before it started listening. See launcher.log.",
        'netflix-home'
      ) | Out-Null
      exit 1
    }
    if ((Get-Date) -gt $deadline) {
      Write-Log 'timed out waiting for the server'
      break
    }
    Start-Sleep -Milliseconds 300
  }
} else {
  Write-Log "port $Port already served; attaching without starting a new server"
}

Open-App
Write-Log 'browser opened'

# --- taskbar window --------------------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text = 'netflix-home'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$form.ShowInTaskbar = $true
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-4000, -4000)
$form.Size = New-Object System.Drawing.Size(360, 120)
$form.WindowState = 'Minimized'

$label = New-Object System.Windows.Forms.Label
$label.AutoSize = $false
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$label.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Controls.Add($label)

$form.Add_Resize({
  if ($form.WindowState -eq 'Normal') {
    $label.Text = "netflix-home is running at $url`nOpening in your browser..."
    Write-Log 'window restored; opening browser'
    Open-App
    $form.WindowState = 'Minimized'
  }
})

$form.Add_FormClosed({
  if ($ownsServer -and $server -and -not $server.HasExited) {
    & taskkill /PID $server.Id /T /F | Out-Null
    Write-Log "server stopped (pid $($server.Id))"
  }
})

[void]$form.ShowDialog()
Write-Log 'launcher closed'
