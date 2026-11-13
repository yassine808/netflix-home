' netflix-home - silent launcher
'
' Starts the local server (hidden), opens the app in the default browser and
' leaves a minimized "netflix-home" button in the taskbar. Click that button to
' reopen the page; closing it stops the server started by this launcher.

Option Explicit

Dim shell, fso, root, script, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(root, "launcher.ps1")

If Not fso.FileExists(script) Then
  MsgBox "launcher.ps1 is missing next to start.vbs.", 16, "netflix-home"
  WScript.Quit 1
End If

command = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"

' 0 = hidden window, False = do not wait
shell.Run command, 0, False
