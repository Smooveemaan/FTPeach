# The top-level windows of a process, for the desktop tests: what Windows
# itself says about them, which a page cannot. `list` prints one JSON line per
# window; `close` sends one the message Alt+F4 or the taskbar's Close sends;
# `resize` sets a window's outer size in physical pixels, as a program would.
param(
  [Parameter(Mandatory)] [ValidateSet('list', 'close', 'resize')] [string] $Action,
  [Parameter(Mandatory)] [int] $ProcessId,
  [long] $Handle = 0,
  [int] $Width,
  [int] $Height
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class E2eWindows {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static List<IntPtr> Of(uint processId) {
    var found = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == processId) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string ClassOf(IntPtr hwnd) {
    var name = new StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    return name.ToString();
  }
}
'@
if ($Action -eq 'close') {
  # WM_CLOSE
  [void][E2eWindows]::PostMessage([IntPtr]$Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  exit 0
}
if ($Action -eq 'resize') {
  # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
  if (-not [E2eWindows]::SetWindowPos([IntPtr]$Handle, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x16)) { throw "SetWindowPos failed" }
  exit 0
}
$rect = New-Object E2eWindows+Rect
foreach ($hwnd in [E2eWindows]::Of($ProcessId)) {
  # Tauri's own windows; the process has message-only and IME windows too.
  if ([E2eWindows]::ClassOf($hwnd) -ne 'Tauri Window') { continue }
  [void][E2eWindows]::GetClientRect($hwnd, [ref]$rect)
  [pscustomobject]@{
    handle = [long]$hwnd
    visible = [E2eWindows]::IsWindowVisible($hwnd)
    minimized = [E2eWindows]::IsIconic($hwnd)
    # GW_OWNER: the confirmation window is owned by the main one.
    owned = [E2eWindows]::GetWindow($hwnd, 4) -ne [IntPtr]::Zero
    # Physical pixels of the page area.
    client = @($rect.Right, $rect.Bottom)
  } | ConvertTo-Json -Compress
}
