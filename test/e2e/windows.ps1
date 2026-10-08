# The top-level windows of a process, for the desktop tests: what Windows
# itself says about them, which a page cannot. `list` prints one JSON line per
# window; `close` sends one the message Alt+F4 or the taskbar's Close sends.
param(
  [Parameter(Mandatory)] [ValidateSet('list', 'close')] [string] $Action,
  [Parameter(Mandatory)] [int] $ProcessId,
  [long] $Handle = 0
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
foreach ($hwnd in [E2eWindows]::Of($ProcessId)) {
  # Tauri's own windows; the process has message-only and IME windows too.
  if ([E2eWindows]::ClassOf($hwnd) -ne 'Tauri Window') { continue }
  [pscustomobject]@{
    handle = [long]$hwnd
    visible = [E2eWindows]::IsWindowVisible($hwnd)
    minimized = [E2eWindows]::IsIconic($hwnd)
    # GW_OWNER: the confirmation window is owned by the main one.
    owned = [E2eWindows]::GetWindow($hwnd, 4) -ne [IntPtr]::Zero
  } | ConvertTo-Json -Compress
}
