# netflix-home tray icon.
#
# The app itself is a Node SEA executable with no GUI toolkit, so the icon and
# its menu are hosted by Windows PowerShell: it owns the notification-area icon
# and the message loop, and talks to the running server over loopback, which
# means no IPC channel to keep in sync. bundle/entry.js starts this script once
# /api/library answers and passes the live port, so a server that moved to a
# random port still opens the right URL.
#
# The icon removes itself when the server process exits (the app was quit from
# the profile menu or the tray, crashed, or was killed), so no ghost icon is
# left in the notification area. The process id is used instead of an HTTP
# probe: a slow library drive can make the server miss a request for a minute
# while it is perfectly alive, and the icon must not vanish for that.

param(
    [int]$Port = 3000,
    [int]$ServerPid = 0,
    [string]$Icon = '',
    [string]$Title = 'netflix-home'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$base = "http://127.0.0.1:$Port"

function Invoke-Api {
    param(
        [string]$Path,
        [string]$Method = 'GET',
        $Body = $null
    )
    $params = @{ Uri = "$base$Path"; Method = $Method; TimeoutSec = 4 }
    if ($null -ne $Body) {
        $params.ContentType = 'application/json'
        $params.Body = ($Body | ConvertTo-Json -Compress)
    }
    Invoke-RestMethod @params
}

# $true / $false when the server answered, $null when it did not.
function Get-Offline {
    try {
        return [bool](Invoke-Api -Path '/api/settings').offline
    } catch {
        return $null
    }
}

function Open-App {
    Start-Process "http://localhost:$Port"
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$iconObject = $null
if ($Icon -and (Test-Path -LiteralPath $Icon)) {
    $iconObject = New-Object System.Drawing.Icon($Icon)
    $notify.Icon = $iconObject
} else {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = $Title
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open netflix-home')
$onlineItem = New-Object System.Windows.Forms.ToolStripMenuItem('Online')
$offlineItem = New-Object System.Windows.Forms.ToolStripMenuItem('Offline')
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Exit')
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$onlineItem.CheckOnClick = $false
$offlineItem.CheckOnClick = $false
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($onlineItem)
[void]$menu.Items.Add($offlineItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($exitItem)
$notify.ContextMenuStrip = $menu

# The tick marks are read from the server every time the menu opens, so a mode
# switched in the web UI cannot leave the tray showing the other state.
function Update-Menu {
    $offline = Get-Offline
    if ($null -eq $offline) {
        $onlineItem.Enabled = $false
        $offlineItem.Enabled = $false
        return
    }
    $onlineItem.Enabled = $true
    $offlineItem.Enabled = $true
    $onlineItem.Checked = -not $offline
    $offlineItem.Checked = $offline
}

function Set-Mode {
    param([bool]$Offline)
    try {
        Invoke-Api -Path '/api/settings/offline' -Method 'POST' -Body @{ offline = $Offline } | Out-Null
    } catch {
        # The watchdog below takes the icon away when the server is gone.
    }
    Update-Menu
}

$openItem.add_Click({ Open-App })
$onlineItem.add_Click({ Set-Mode -Offline $false })
$offlineItem.add_Click({ Set-Mode -Offline $true })
$menu.add_Opening({ Update-Menu })
$notify.add_MouseDoubleClick({ Open-App })

$exitItem.add_Click({
    try {
        Invoke-Api -Path '/api/quit' -Method 'POST' | Out-Null
    } catch {
        # Already gone: closing the icon is still the right answer.
    }
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

# Quit from the web UI or a crash ends the server without telling this process,
# so the icon watches the server process. HTTP is deliberately not used here:
# a stalled library drive can silence the server for a minute without it being
# gone, and an icon that disappears then is worse than one that lingers 3 s.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
    $gone = $false
    if ($ServerPid -gt 0) {
        try {
            $null = Get-Process -Id $ServerPid -ErrorAction Stop
        } catch {
            $gone = $true
        }
    } else {
        $gone = ($null -eq (Get-Offline))
    }
    if ($gone) {
        $notify.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

Update-Menu
[System.Windows.Forms.Application]::Run()

$timer.Stop()
$timer.Dispose()
$notify.Visible = $false
$notify.Dispose()
if ($iconObject) { $iconObject.Dispose() }
