// What the native tests (test/e2e/*.native.ts) do that a page cannot: answer
// a real Windows file dialog, open the tray icon's menu and pick from it, and
// drag between Explorer and FTPeach with the real mouse. test/e2e/native.ts
// builds it with the C# compiler every Windows has and runs one command per
// call; each prints its answer as one JSON line. Dialogs and menus are driven
// through UI Automation and shell messages; clicks, keys and drags use real input.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Native
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int size, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr menu, int position);
    [DllImport("shell32.dll")] static extern int Shell_NotifyIconGetRect(ref NotifyIconId id, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, ref Rect rect, uint winIni);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct NotifyIconId { public uint Size; public IntPtr Window; public uint Id; public Guid Item; }
    [StructLayout(LayoutKind.Sequential)]
    struct MouseInput { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct KeyInput { public ushort Key, Scan; public uint Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyInput Key; }
    [StructLayout(LayoutKind.Sequential)]
    struct Input { public uint Type; public InputUnion Union; }

    // The tray icon's callback message (tray-icon's WM_USER_TRAYICON) and the
    // mouse messages the shell sends with it.
    const uint TrayCallback = 6002;
    const int LeftButtonUp = 0x0202, RightButtonUp = 0x0205;
    const uint GetMenuHandle = 0x01E1; // MN_GETHMENU

    [STAThread]
    static int Main(string[] args)
    {
        // Physical pixels throughout: window places, UI Automation and the mouse.
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        try
        {
            switch (args[0])
            {
                case "dialog": return Dialog(uint.Parse(args[1]), args[2], args.Length > 3 ? args[3] : "");
                case "dialog-text": return DialogText(uint.Parse(args[1]), true);
                case "dialog-read": return DialogText(uint.Parse(args[1]), false);
                case "click": return ClickElement(uint.Parse(args[1]), args[2], args[3], args.Length > 4 ? args[4] : "");
                case "element-state": return ElementState(uint.Parse(args[1]), args[2], args[3]);
                case "element-present": Element(uint.Parse(args[1]), args[2], args[3]); Console.WriteLine("{}"); return 0;
                case "toast": return Toast(args[1]);
                case "foreground": return Foreground(uint.Parse(args[1]));
                case "window-state": return WindowState(Handle(args[1]));
                case "window": return AppWindow(uint.Parse(args[1]), args[2]);
                case "double-click-speed": return DoubleClickSpeed(args.Length > 1 ? int.Parse(args[1]) : 0);
                case "tray-icon": return TrayIcon(uint.Parse(args[1]));
                case "tray-click": return TrayClick(uint.Parse(args[1]), args[2]);
                case "tray-menu": return TrayMenu(uint.Parse(args[1]));
                case "tray-choose": return TrayChoose(uint.Parse(args[1]), args[2], args.Length > 3 ? args[3] : null);
                case "work-area": return WorkArea();
                case "screen-free": return ScreenFree();
                case "desktop-focus": return DesktopFocus(uint.Parse(args[1]));
                case "window-at": return WindowAt(int.Parse(args[1]), int.Parse(args[2]));
                case "place": return Place(Handle(args[1]), int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]));
                case "activate": ShowWindow(Handle(args[1]), 9); SetForegroundWindow(Handle(args[1])); Console.WriteLine("{}"); return 0;
                case "close": PostMessage(Handle(args[1]), 0x0010, IntPtr.Zero, IntPtr.Zero); Console.WriteLine("{}"); return 0;
                case "client-origin": return ClientOrigin(Handle(args[1]));
                case "explorer-open": return ExplorerOpen(args[1]);
                case "explorer-close": return ExplorerClose(args[1]);
                case "explorer-item": return ExplorerItem(Handle(args[1]), args[2]);
                case "explorer-find": return ExplorerFind(args[1]);
                case "explorer-selection": return ExplorerSelection(Handle(args[1]), args.Skip(2).ToArray());
                case "explorer-add": return ExplorerAdd(Handle(args[1]), args[2]);
                case "explorer-view": return ExplorerView(Handle(args[1]));
                case "drag": return Drag(args);
                case "press": return Press(args);
                case "keys": return Press(args);
                case "drop-file": return DropFile(args);
                case "run-as": return RunAs(args);
                case "run-held": return RunHeld(args);
                default: throw new ArgumentException("unknown command " + args[0]);
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
    }

    static IntPtr Handle(string text) { return new IntPtr(long.Parse(text)); }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int Size; public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public short ShowWindow, Reserved2; public IntPtr Reserved3, StdIn, StdOut, StdErr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr Process, Thread; public int Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits
    {
        public long PerProcessTime, PerJobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint Priority, Scheduling;
        public ulong Io1, Io2, Io3, Io4, Io5, Io6;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithLogonW(string user, string domain, string password, int logonFlags,
        string application, StringBuilder commandLine, int creationFlags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, int code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

    /**
     * run-as <user> <password> <exe> [NAME=value...]: runs `exe` as another
     * local account, with that account's own environment and profile plus the
     * variables given, until it exits or this command's input closes, which
     * ends it and every process it started. Prints the started copy's pid,
     * then exits with the program's exit code. The copy of this helper that
     * runs as the account (run-held) must be somewhere it can read.
     */
    static int RunAs(string[] args)
    {
        var line = new StringBuilder("\"" + Process.GetCurrentProcess().MainModule.FileName + "\" run-held");
        for (int i = 3; i < args.Length; i++) line.Append(" \"").Append(args[i]).Append('"');
        // Hidden: the console of the helper running as the account.
        var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = 1, ShowWindow = 0 };
        ProcessInformation info;
        const int LogonWithProfile = 1;
        if (!CreateProcessWithLogonW(args[1], ".", args[2], LogonWithProfile, null, line, 0, IntPtr.Zero,
            System.IO.Path.GetDirectoryName(args[3]), ref startup, out info))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        Console.WriteLine("{\"pid\":" + info.Pid + "}");
        Console.Out.Flush();
        var process = info.Process;
        new Thread(() => { Console.In.ReadToEnd(); TerminateProcess(process, 1); }) { IsBackground = true }.Start();
        WaitForSingleObject(process, 0xFFFFFFFF);
        int code;
        GetExitCodeProcess(process, out code);
        return code;
    }

    /** run-as's other half, as the account: puts itself and the program in a job that dies with it. */
    static int RunHeld(string[] args)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        var limits = new JobLimits { Flags = 0x2000 }; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        const int ExtendedLimitInformation = 9;
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JobLimits)))
            || !AssignProcessToJobObject(job, GetCurrentProcess()))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var start = new ProcessStartInfo(args[1]) { UseShellExecute = false, WorkingDirectory = System.IO.Path.GetDirectoryName(args[1]) };
        start.EnvironmentVariables.Remove("FTPEACH_SMOKE_TEST");
        for (int i = 2; i < args.Length; i++)
        {
            int at = args[i].IndexOf('=');
            start.EnvironmentVariables[args[i].Substring(0, at)] = args[i].Substring(at + 1);
        }
        var program = Process.Start(start);
        program.WaitForExit();
        return program.ExitCode;
    }

    static string Quote(string text)
    {
        var json = new StringBuilder("\"");
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') json.Append('\\').Append(c);
            else if (c < 0x20) json.AppendFormat("\\u{0:x4}", (int)c);
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }

    static string ClassOf(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }

    static string TextOf(IntPtr hwnd)
    {
        var text = new StringBuilder(512);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }

    /** The top-level windows of a process with a window class, visible ones only if asked. */
    static List<IntPtr> Windows(uint processId, string className, bool visibleOnly)
    {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, _) =>
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == processId && (className == null || ClassOf(hwnd) == className) && (!visibleOnly || IsWindowVisible(hwnd)))
                found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static IntPtr WaitWindow(uint processId, string className, int seconds, Func<IntPtr, bool> wanted)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline)
        {
            foreach (var hwnd in Windows(processId, className, true))
                if (wanted(hwnd)) return hwnd;
            Thread.Sleep(100);
        }
        throw new TimeoutException("no " + className + " window of process " + processId + " within " + seconds + " s");
    }

    // ---- File dialogs ----

    /**
     * Waits for the process's file dialog and answers it: `pick` types the
     * path into the file or folder name box and presses the default button
     * (Open, Save, Select Folder), `cancel` presses Cancel. Prints the
     * dialog's title. A dialog still open afterwards (Windows refused the
     * name) fails with what is on it.
     */
    static int Dialog(uint processId, string action, string path)
    {
        var hwnd = WaitWindow(processId, "#32770", 30, _ => true);
        var dialog = AutomationElement.FromHandle(hwnd);
        string title = TextOf(hwnd);
        if (action == "pick")
        {
            var box = NameBox(dialog);
            box.SetFocus();
            var value = (ValuePattern)box.GetCurrentPattern(ValuePattern.Pattern);
            value.SetValue(path);
            // A real edit commits UIA's filename into the Windows dialog's save model.
            System.Windows.Forms.SendKeys.SendWait("{END} {BACKSPACE}");
            if (value.Current.Value != path)
                throw new InvalidOperationException("the file dialog did not keep the requested path");
            Press(hwnd, 1);
        }
        else if (action == "cancel") Press(hwnd, 2);
        else throw new ArgumentException("pick or cancel, not " + action);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (IsWindow(hwnd) && IsWindowVisible(hwnd))
        {
            if (DateTime.UtcNow > deadline)
                throw new InvalidOperationException("the dialog \"" + title + "\" stayed open: " + Describe(hwnd));
            Thread.Sleep(100);
        }
        Console.WriteLine("{\"title\":" + Quote(title) + "}");
        return 0;
    }

    static int DialogText(uint processId, bool accept)
    {
        var hwnd = WaitWindow(processId, "#32770", 30, _ => true);
        var button = accept ? Element(processId, "Button", "OK") : null;
        Console.WriteLine("{\"text\":" + Quote(Describe(hwnd)) + "}");
        if (accept) ((InvokePattern)button.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
        return 0;
    }

    static AutomationElement Element(uint processId, string type, string name)
    {
        var field = typeof(ControlType).GetField(type);
        if (field == null) throw new ArgumentException("unknown control type " + type);
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var seen = new List<string>();
        while (true)
        {
            foreach (var hwnd in Windows(processId, null, true))
            {
                try
                {
                    var root = AutomationElement.FromHandle(hwnd);
                    var controls = root.FindAll(TreeScope.Descendants,
                        new PropertyCondition(AutomationElement.ControlTypeProperty, field.GetValue(null)));
                    foreach (AutomationElement control in controls)
                    {
                        string actual = control.Current.Name.Replace("\u2068", "").Replace("\u2069", "");
                        if (name.EndsWith("*") ? actual.StartsWith(name.Substring(0, name.Length - 1), StringComparison.OrdinalIgnoreCase) : actual.Equals(name, StringComparison.OrdinalIgnoreCase))
                            return control;
                    }
                    if (DateTime.UtcNow > deadline)
                    {
                        foreach (AutomationElement control in controls) seen.Add(Quote(control.Current.Name));
                        seen.Add(Describe(hwnd));
                    }
                }
                catch (ElementNotAvailableException) { }
            }
            if (DateTime.UtcNow > deadline) throw new TimeoutException("no " + type + " named " + Quote(name) + "; available: " + string.Join(", ", seen));
            Thread.Sleep(100);
        }
    }

    static int ClickElement(uint processId, string type, string name, string mode)
    {
        var item = Element(processId, type, name);
        var rect = item.Current.BoundingRectangle;
        int x = (int)(rect.Left + rect.Width / 2), y = (int)(rect.Top + rect.Height / 2);
        if (mode == "invoke")
        {
            ((InvokePattern)item.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
            Console.WriteLine("{\"x\":" + x + ",\"y\":" + y + "}");
            return 0;
        }
        int interval = mode == "double" ? 80 : mode == "right" || mode == "ctrl" || mode == "" ? -1 : int.Parse(mode);
        var appWindow = Windows(processId, null, true).First(hwnd => TextOf(hwnd) == "FTPeach");
        ShowWindowAsync(appWindow, 9); // SW_RESTORE
        SetWindowPos(appWindow, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // TOPMOST | NOSIZE | NOMOVE | NOACTIVATE
        SetForegroundWindow(appWindow);
        Thread.Sleep(200);
        Send(Mouse(x, y, 0));
        Thread.Sleep(100);
        if (mode == "right") Send(Mouse(x, y, 0x0008), Mouse(x, y, 0x0010));
        else
        {
            if (mode == "ctrl") Send(Key(0x11, false));
            try
            {
                Send(Mouse(x, y, 0x0002), Mouse(x, y, 0x0004));
                if (interval >= 0)
                {
                    Thread.Sleep(interval);
                    Send(Mouse(x + 1, y, 0), Mouse(x, y, 0));
                    Send(Mouse(x, y, 0x0002), Mouse(x, y, 0x0004));
                }
            }
            finally { if (mode == "ctrl") Send(Key(0x11, true)); }
        }
        Console.WriteLine("{\"x\":" + x + ",\"y\":" + y + "}");
        return 0;
    }

    static int ElementState(uint processId, string type, string name)
    {
        var item = Element(processId, type, name);
        var selection = item.GetCurrentPattern(SelectionItemPattern.Pattern) as SelectionItemPattern;
        bool selected = selection != null && selection.Current.IsSelected;
        Console.WriteLine("{\"selected\":" + (selected ? "true" : "false") + "}");
        return 0;
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    static int WindowState(IntPtr hwnd)
    {
        if (!IsWindow(hwnd)) throw new InvalidOperationException("window no longer exists");
        Console.WriteLine("{\"visible\":" + (IsWindowVisible(hwnd) ? "true" : "false") + ",\"minimized\":" + (IsIconic(hwnd) ? "true" : "false") + "}");
        return 0;
    }

    static int Foreground(uint processId)
    {
        var foreground = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(foreground, out pid);
        var window = Windows(processId, null, true).FirstOrDefault(hwnd => TextOf(hwnd) == "FTPeach");
        bool iconic = window != IntPtr.Zero && IsIconic(window);
        if (pid != processId || foreground != window || iconic)
            throw new InvalidOperationException("FTPeach is not the restored foreground window");
        Console.WriteLine("{\"handle\":" + (long)foreground + "}");
        return 0;
    }

    static int Toast(string count)
    {
        string expected = count + " files transferred";
        string expectedName = "New notification from FTPeach, Transfer Complete, " + expected + ".. 1 of 1";
        string seen = "";
        var deadline = DateTime.UtcNow.AddSeconds(45);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                // workaround: Windows omits unfocused shell toasts from UIA traversal; Win+Shift+V exposes them.
                Send(Key(0x5B, false), Key(0x10, false), Key(0x56, false), Key(0x56, true), Key(0x10, true), Key(0x5B, true));
                Thread.Sleep(100);
                var toast = AutomationElement.FocusedElement;
                seen = toast.Current.Name;
                if (seen == expectedName)
                {
                    var rect = toast.Current.BoundingRectangle;
                    if (toast.Current.IsOffscreen || rect.Width <= 0 || rect.Height <= 0)
                        throw new InvalidOperationException("the transfer toast is not visible");
                    int x = (int)(rect.Left + rect.Width / 2), y = (int)(rect.Top + rect.Height / 2);
                    Send(Mouse(x, y, 0));
                    Thread.Sleep(100);
                    Send(Mouse(x, y, 0x0002), Mouse(x, y, 0x0004));
                    Console.WriteLine("{\"text\":" + Quote(expected) + ",\"name\":" + Quote(seen) + "}");
                    return 0;
                }
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(250);
        }
        throw new TimeoutException("no visible toast named " + Quote(expectedName) + "; focused: " + Quote(seen));
    }

    static int AppWindow(uint processId, string title)
    {
        var hwnd = WaitWindow(processId, null, 30, window => TextOf(window) == title);
        Console.WriteLine("{\"handle\":" + (long)hwnd + "}");
        return 0;
    }

    [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] static extern bool SetDoubleClickTime(uint milliseconds);
    static int DoubleClickSpeed(int milliseconds)
    {
        uint previous = GetDoubleClickTime();
        if (milliseconds > 0 && !SetDoubleClickTime((uint)milliseconds))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        Console.WriteLine("{\"previous\":" + previous + ",\"current\":" + GetDoubleClickTime() + "}");
        return 0;
    }

    /**
     * The box a file dialog takes the name in: the File name box of Open
     * (1148) and of Save (1001), or the Folder box of a folder picker (1152).
     * Automation ids, so any display language.
     */
    static AutomationElement NameBox(AutomationElement dialog)
    {
        var edits = dialog.FindAll(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        foreach (string id in new[] { "1148", "1001", "1152" })
            foreach (AutomationElement edit in edits)
                if (edit.Current.AutomationId == id) return edit;
        var seen = new List<string>();
        foreach (AutomationElement edit in edits) seen.Add(edit.Current.AutomationId + " " + Quote(edit.Current.Name));
        throw new InvalidOperationException("no name box in the dialog; its edit boxes: " + string.Join(", ", seen));
    }

    /**
     * Presses the dialog's button with control id `id` (1 the default, 2
     * Cancel) with a click message to the button itself, rather than UI
     * Automation: Windows has shown the default button of a file dialog as a
     * pane there, with no Invoke. Posted, so a message box the press opens
     * does not hold this process.
     */
    static void Press(IntPtr dialog, int id)
    {
        IntPtr button = IntPtr.Zero;
        EnumChildWindows(dialog, (child, _) =>
        {
            if (GetDlgCtrlID(child) != id || ClassOf(child) != "Button" || !IsWindowVisible(child)) return true;
            button = child;
            return false;
        }, IntPtr.Zero);
        if (button == IntPtr.Zero)
            throw new InvalidOperationException("no button " + id + " in the dialog: " + Describe(dialog));
        PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
    }

    static void Click(AutomationElement element)
    {
        var rect = element.Current.BoundingRectangle;
        if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0 || !element.Current.IsEnabled)
            throw new InvalidOperationException("the native control is not ready for a click");
        int x = (int)(rect.Left + rect.Width / 2), y = (int)(rect.Top + rect.Height / 2);
        Send(Mouse(x, y, 0), Mouse(x, y, 0x0002), Mouse(x, y, 0x0004));
    }

    static string Describe(IntPtr hwnd)
    {
        var texts = new List<string>();
        foreach (AutomationElement text in AutomationElement.FromHandle(hwnd).FindAll(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)))
            if (text.Current.Name != "") texts.Add(text.Current.Name);
        return string.Join(" | ", texts);
    }

    // ---- Tray ----

    /** The hidden window that owns the process's tray icon, if it has one. */
    static IntPtr TrayWindow(uint processId)
    {
        var found = Windows(processId, "tray_icon_app", false);
        return found.Count > 0 ? found[0] : IntPtr.Zero;
    }

    /**
     * Whether the process has a tray icon, and whether the shell holds it:
     * where the notification area draws it. tray-icon numbers its icons, so
     * the first few numbers are asked.
     */
    static int TrayIcon(uint processId)
    {
        var hwnd = TrayWindow(processId);
        if (hwnd == IntPtr.Zero) { Console.WriteLine("{\"icon\":false}"); return 0; }
        for (uint id = 0; id < 64; id++)
        {
            var key = new NotifyIconId { Window = hwnd, Id = id };
            key.Size = (uint)Marshal.SizeOf(key);
            Rect rect;
            if (Shell_NotifyIconGetRect(ref key, out rect) == 0)
            {
                Console.WriteLine("{\"icon\":true,\"inShell\":true,\"id\":" + id + ",\"width\":" + (rect.Right - rect.Left) + "}");
                return 0;
            }
        }
        Console.WriteLine("{\"icon\":true,\"inShell\":false}");
        return 0;
    }

    static int TrayClick(uint processId, string button)
    {
        PostTrayClick(processId, button);
        Console.WriteLine("{}");
        return 0;
    }

    /** What the shell sends the icon's window when the icon is clicked. */
    static void PostTrayClick(uint processId, string button)
    {
        var hwnd = TrayWindow(processId);
        if (hwnd == IntPtr.Zero) throw new InvalidOperationException("the process has no tray icon");
        PostMessage(hwnd, TrayCallback, IntPtr.Zero, new IntPtr(button == "left" ? LeftButtonUp : RightButtonUp));
    }

    /**
     * Opens the icon's menu with a right click, prints it, and closes it
     * again: each item's text, whether it is checked or disabled, and a
     * submenu's items. Read from the menu itself, not from its picture.
     */
    static int TrayMenu(uint processId)
    {
        var menu = OpenTrayMenu(processId);
        var handle = SendMessage(menu, GetMenuHandle, IntPtr.Zero, IntPtr.Zero);
        string items = MenuItems(handle);
        CloseMenus(processId);
        Console.WriteLine("{\"items\":" + items + "}");
        return 0;
    }

    static IntPtr OpenTrayMenu(uint processId)
    {
        CloseMenus(processId);
        PostTrayClick(processId, "right");
        return WaitWindow(processId, "#32768", 10, _ => true);
    }

    static void CloseMenus(uint processId)
    {
        // WM_KEYDOWN Escape closes one level; a menu loop ends with its last level.
        for (int level = 0; level < 3; level++)
        {
            var open = Windows(processId, "#32768", true);
            if (open.Count == 0) return;
            foreach (var hwnd in open) PostMessage(hwnd, 0x0100, new IntPtr(0x1B), IntPtr.Zero);
            Thread.Sleep(200);
        }
    }

    static string MenuItems(IntPtr menu)
    {
        const uint ByPosition = 0x400, Checked = 0x8, Grayed = 0x1, Disabled = 0x2, Popup = 0x10, Separator = 0x800;
        var items = new List<string>();
        int count = GetMenuItemCount(menu);
        for (int i = 0; i < count; i++)
        {
            uint state = GetMenuState(menu, (uint)i, ByPosition);
            if ((state & Separator) != 0) { items.Add("{\"separator\":true}"); continue; }
            var text = new StringBuilder(512);
            GetMenuString(menu, (uint)i, text, text.Capacity, ByPosition);
            string item = "{\"text\":" + Quote(text.ToString()) +
                ",\"checked\":" + ((state & Checked) != 0 ? "true" : "false") +
                ",\"disabled\":" + ((state & (Grayed | Disabled)) != 0 ? "true" : "false");
            if ((state & Popup) != 0) item += ",\"items\":" + MenuItems(GetSubMenu(menu, i));
            items.Add(item + "}");
        }
        return "[" + string.Join(",", items) + "]";
    }

    /**
     * Opens the icon's menu and picks `item`, or `sub` in the submenu `item`
     * opens, using UI Automation to locate each item and the mouse to select it.
     */
    static int TrayChoose(uint processId, string item, string sub)
    {
        var menu = OpenTrayMenu(processId);
        var entry = MenuEntry(menu, item);
        if (sub != null)
        {
            Click(entry);
            var submenu = WaitWindow(processId, "#32768", 10, hwnd => hwnd != menu);
            entry = MenuEntry(submenu, sub);
        }
        Click(entry);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (Windows(processId, "#32768", true).Count > 0)
        {
            if (DateTime.UtcNow > deadline) throw new InvalidOperationException("the menu stayed open after the click");
            Thread.Sleep(100);
        }
        Console.WriteLine("{}");
        return 0;
    }

    static AutomationElement MenuEntry(IntPtr menu, string name)
    {
        var entry = AutomationElement.FromHandle(menu).FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
            new PropertyCondition(AutomationElement.NameProperty, name)));
        if (entry == null) throw new InvalidOperationException("no menu item " + Quote(name));
        return entry;
    }

    // ---- Windows on the screen ----

    static int DesktopFocus(uint processId)
    {
        EnumWindows((hwnd, _) =>
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string type = ClassOf(hwnd);
            if (pid != processId && IsWindowVisible(hwnd) && type != "Progman" && type != "WorkerW")
                ShowWindow(hwnd, 6); // SW_MINIMIZE
            return true;
        }, IntPtr.Zero);
        SetForegroundWindow(GetShellWindow());
        var area = new Rect();
        SystemParametersInfo(0x0030, 0, ref area, 0);
        int x = area.Left + 5, y = area.Bottom - 5;
        // A real desktop click also releases WebView2's keyboard focus.
        Send(Mouse(x, y, 0), Mouse(x, y, 0x0002), Mouse(x, y, 0x0004));
        Console.WriteLine("{}");
        return 0;
    }

    static int WindowAt(int x, int y)
    {
        var hwnd = WindowFromPoint(new Point { X = x, Y = y });
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        Console.WriteLine("{\"class\":" + Quote(ClassOf(hwnd)) + ",\"pid\":" + pid + ",\"title\":" + Quote(TextOf(hwnd)) + "}");
        return 0;
    }

    static int WorkArea()
    {
        var rect = new Rect();
        SystemParametersInfo(0x0030, 0, ref rect, 0); // SPI_GETWORKAREA
        Console.WriteLine("{\"x\":" + rect.Left + ",\"y\":" + rect.Top + ",\"width\":" + (rect.Right - rect.Left) + ",\"height\":" + (rect.Bottom - rect.Top) + "}");
        return 0;
    }

    /**
     * Prints which program, if any, dims the screen for a prompt of its own
     * (a Windows Security or firewall question): the dimmed layer lies over
     * every window and takes the mouse, so no drag or click reaches them.
     */
    static int ScreenFree()
    {
        // What the mouse meets in the middle of the working area.
        var area = new Rect();
        SystemParametersInfo(0x0030, 0, ref area, 0);
        var hwnd = WindowFromPoint(new Point { X = (area.Left + area.Right) / 2, Y = (area.Top + area.Bottom) / 2 });
        string blockedBy = null;
        // Shell_SystemDim over the whole screen, Shell_SystemDialog in its middle.
        if (ClassOf(hwnd) == "Shell_SystemDim" || ClassOf(hwnd) == "Shell_SystemDialog")
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            try
            {
                var process = System.Diagnostics.Process.GetProcessById((int)pid);
                blockedBy = process.ProcessName + (process.MainWindowTitle != "" ? " (" + process.MainWindowTitle + ")" : "");
            }
            catch (ArgumentException) { blockedBy = "process " + pid; }
        }
        Console.WriteLine("{\"blockedBy\":" + (blockedBy == null ? "null" : Quote(blockedBy)) + "}");
        return 0;
    }

    /** Puts a window at a place on the screen, above every other one, without activating it; width 0 keeps its size. */
    static int Place(IntPtr hwnd, int x, int y, int width, int height)
    {
        // HWND_TOPMOST, SWP_NOACTIVATE | SWP_SHOWWINDOW, and SWP_NOSIZE
        if (!SetWindowPos(hwnd, new IntPtr(-1), x, y, width, height, 0x0010 | 0x0040 | (width == 0 ? 0x0001u : 0u)))
            throw new InvalidOperationException("could not place window " + hwnd);
        Console.WriteLine("{}");
        return 0;
    }

    static int ClientOrigin(IntPtr hwnd)
    {
        var point = new Point();
        ClientToScreen(hwnd, ref point);
        Console.WriteLine("{\"x\":" + point.X + ",\"y\":" + point.Y + "}");
        return 0;
    }

    // ---- Explorer ----

    /** Explorer's window, or tab, showing `folder`, through the shell's own list of them. */
    static dynamic ExplorerWindow(string folder)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
        foreach (dynamic window in shell.Windows())
        {
            try
            {
                string shown = window.Document.Folder.Self.Path;
                if (string.Equals(shown.TrimEnd('\\'), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    return window;
            }
            catch (Exception) { }
        }
        return null;
    }

    static int ExplorerOpen(string folder)
    {
        Process.Start("explorer.exe", "\"" + folder + "\"");
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            var window = ExplorerWindow(folder);
            if (window != null)
            {
                Console.WriteLine("{\"handle\":" + (long)window.HWND + "}");
                return 0;
            }
            Thread.Sleep(250);
        }
        throw new TimeoutException("Explorer did not show " + folder);
    }

    /** Closes the Explorer window or tab showing `folder`, and only that tab. */
    static int ExplorerClose(string folder)
    {
        var window = ExplorerWindow(folder);
        if (window != null) window.Quit();
        Console.WriteLine("{}");
        return 0;
    }

    static int Center(AutomationElement element, string what)
    {
        if (element == null) throw new InvalidOperationException("Explorer shows no " + what);
        var rect = element.Current.BoundingRectangle;
        Console.WriteLine("{\"x\":" + (int)(rect.Left + rect.Width / 2) + ",\"y\":" + (int)(rect.Top + rect.Height / 2) +
            ",\"left\":" + (int)rect.Left + ",\"top\":" + (int)rect.Top + ",\"right\":" + (int)rect.Right + ",\"bottom\":" + (int)rect.Bottom + "}");
        return 0;
    }

    /** Where Explorer draws the entry `name` in its window `hwnd`. */
    static int ExplorerItem(IntPtr hwnd, string name)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (true)
        {
            var item = AutomationElement.FromHandle(hwnd).FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
                new PropertyCondition(AutomationElement.NameProperty, name)));
            if (item != null || DateTime.UtcNow > deadline) return Center(item, "entry " + Quote(name));
            Thread.Sleep(250);
        }
    }

    static int ExplorerFind(string folder)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            var window = ExplorerWindow(folder);
            if (window != null)
            {
                Console.WriteLine("{\"handle\":" + (long)window.HWND + "}");
                return 0;
            }
            Thread.Sleep(250);
        }
        throw new TimeoutException("Explorer did not show " + folder);
    }

    static int ExplorerSelection(IntPtr hwnd, string[] expected)
    {
        var items = AutomationElement.FromHandle(hwnd).FindAll(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem));
        var selected = new List<string>();
        foreach (AutomationElement item in items)
        {
            var pattern = item.GetCurrentPattern(SelectionItemPattern.Pattern) as SelectionItemPattern;
            if (pattern != null && pattern.Current.IsSelected) selected.Add(item.Current.Name);
        }
        selected.Sort(StringComparer.OrdinalIgnoreCase);
        var wanted = expected.OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToArray();
        if (!selected.SequenceEqual(wanted, StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException("Explorer selection is [" + string.Join(", ", selected) + "], expected [" + string.Join(", ", wanted) + "]");
        Console.WriteLine("{\"selected\":[" + string.Join(",", selected.Select(Quote)) + "]}");
        return 0;
    }

    static int ExplorerAdd(IntPtr hwnd, string name)
    {
        var item = AutomationElement.FromHandle(hwnd).FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
            new PropertyCondition(AutomationElement.NameProperty, name)));
        var rect = item.Current.BoundingRectangle;
        int x = (int)(rect.Left + rect.Width / 2), y = (int)(rect.Top + rect.Height / 2);
        Send(Key(0x11, false));
        try
        {
            Send(Mouse(x, y, 0));
            Thread.Sleep(100);
            Send(Mouse(x, y, 0x0002), Mouse(x, y, 0x0004));
        }
        finally { Send(Key(0x11, true)); }
        Console.WriteLine("{}");
        return 0;
    }

    /** The list of entries in Explorer's window `hwnd`: where a drop lands in the folder. */
    static int ExplorerView(IntPtr hwnd)
    {
        var view = AutomationElement.FromHandle(hwnd).FindFirst(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ClassNameProperty, "UIItemsView"));
        return Center(view, "list of entries");
    }

    // ---- The mouse ----

    static void Send(params Input[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))); }

    static Input Mouse(int x, int y, uint flags)
    {
        // Absolute on the whole virtual desktop, 0 to 65535 on each axis.
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        var input = new Input { Type = 0 };
        input.Union.Mouse.X = (int)Math.Round((x - left) * 65535.0 / (width - 1));
        input.Union.Mouse.Y = (int)Math.Round((y - top) * 65535.0 / (height - 1));
        input.Union.Mouse.Flags = 0x0001 | 0x8000 | 0x4000 | flags; // MOVE | ABSOLUTE | VIRTUALDESK
        return input;
    }

    static Input Key(ushort key, bool up)
    {
        var input = new Input { Type = 1 };
        input.Union.Key.Key = key;
        input.Union.Key.Flags = up ? 0x0002u : 0u;
        return input;
    }

    static void Glide(int fromX, int fromY, int toX, int toY, int steps, int pause)
    {
        for (int i = 1; i <= steps; i++)
        {
            Send(Mouse(fromX + (toX - fromX) * i / steps, fromY + (toY - fromY) * i / steps, 0));
            Thread.Sleep(pause);
        }
    }

    /**
     * press x y combo...: clicks a point to give its window the keyboard, then
     * presses each combo (`f5`, `ctrl+r`: modifiers ctrl, shift, alt, then one
     * letter or F-key) as real keys, which reach WebView2's own shortcuts.
     */
    static int Press(string[] args)
    {
        if (args[0] == "press")
        {
            int x = int.Parse(args[1]), y = int.Parse(args[2]);
            Send(Mouse(x, y, 0));
            Thread.Sleep(100);
            Send(Mouse(x, y, 0x0002), Mouse(x, y, 0x0004)); // LEFTDOWN, LEFTUP
            Thread.Sleep(300);
        }
        for (int i = args[0] == "keys" ? 1 : 3; i < args.Length; i++)
        {
            var keys = new List<ushort>();
            foreach (string part in args[i].ToLowerInvariant().Split('+'))
            {
                if (part == "ctrl") keys.Add(0x11);
                else if (part == "shift") keys.Add(0x10);
                else if (part == "alt") keys.Add(0x12);
                else if (part.Length == 1) keys.Add(char.ToUpperInvariant(part[0]));
                else keys.Add((ushort)(0x6F + int.Parse(part.Substring(1)))); // F1 is 0x70
            }
            foreach (var key in keys) Send(Key(key, false));
            Thread.Sleep(50);
            for (int k = keys.Count - 1; k >= 0; k--) Send(Key(keys[k], true));
            Thread.Sleep(700);
        }
        Console.WriteLine("{}");
        return 0;
    }

    /**
     * drag fromX fromY toX toY [keys] [drop|cancel] [holdMs]: presses the left
     * button at the start, moves to the end the way a hand does, holds `keys`
     * (shift, ctrl, alt, joined by +) over the target, and releases there, or
     * with `cancel` presses Escape first. With `holdMs` it rests over the
     * target that long first, the keys repeating as a held key does.
     */
    static int Drag(string[] args)
    {
        var keys = new List<ushort>();
        if (args.Length > 5 && args[5] != "" && args[5] != "-")
            foreach (string key in args[5].Split('+'))
                keys.Add(key == "shift" ? (ushort)0x10 : key == "ctrl" ? (ushort)0x11 : key == "alt" ? (ushort)0x12 : (ushort)0);
        if (keys.Contains(0)) throw new ArgumentException("keys are shift, ctrl and alt");
        Gesture(int.Parse(args[1]), int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), keys,
            args.Length > 6 && args[6] == "cancel", args.Length > 7 ? int.Parse(args[7]) : 0);
        Console.WriteLine("{}");
        return 0;
    }

    static void Gesture(int fromX, int fromY, int toX, int toY, List<ushort> keys, bool cancel, int holdMs)
    {
        try
        {
            Send(Mouse(fromX, fromY, 0));
            Thread.Sleep(200);
            Send(Mouse(fromX, fromY, 0x0002)); // LEFTDOWN
            Thread.Sleep(150);
            // Past the distance that starts a drag, in both FTPeach and Explorer.
            Glide(fromX, fromY, fromX + 24, fromY + 12, 8, 30);
            int nearX = toX - (toX - fromX) / 8, nearY = toY - (toY - fromY) / 8;
            Glide(fromX + 24, fromY + 12, nearX, nearY, 40, 25);
            foreach (var key in keys) Send(Key(key, false));
            Glide(nearX, nearY, toX, toY, 10, 30);
            // A few small moves over the target, so it hears the drag over it.
            for (int i = 0; i < 6; i++)
            {
                Send(Mouse(toX + (i % 2 == 0 ? 2 : -2), toY, 0));
                Thread.Sleep(120);
            }
            Send(Mouse(toX, toY, 0));
            Thread.Sleep(200);
            // Still, with the keys repeating about 30 times a second.
            for (var until = DateTime.UtcNow.AddMilliseconds(holdMs); DateTime.UtcNow < until; Thread.Sleep(33))
                foreach (var key in keys) Send(Key(key, false));
            if (cancel)
            {
                Send(Key(0x1B, false));
                Thread.Sleep(100);
                Send(Key(0x1B, true));
                // Moves after it, as a hand keeps moving, so the drag loop looks at the keys.
                for (int i = 0; i < 5; i++)
                {
                    Send(Mouse(toX + (i % 2 == 0 ? 3 : -3), toY, 0));
                    Thread.Sleep(150);
                }
            }
            Send(Mouse(toX, toY, 0x0004)); // LEFTUP
            Thread.Sleep(300);
        }
        finally
        {
            foreach (var key in keys) Send(Key(key, true));
            Send(Mouse(toX, toY, 0x0004));
        }
    }

    /**
     * drop-file path toX toY: drags a file to a point the way any program
     * other than Explorer may, from a small window of this helper's own in the
     * left part of the screen, and prints the effect the target reported back
     * when the file was dropped: 1 is copy, 2 move, 4 link.
     */
    static int DropFile(string[] args)
    {
        string file = args[1];
        int toX = int.Parse(args[2]), toY = int.Parse(args[3]);
        var area = new Rect();
        SystemParametersInfo(0x0030, 0, ref area, 0);
        int fromX = area.Left + 100, fromY = toY;
        var form = new System.Windows.Forms.Form
        {
            FormBorderStyle = System.Windows.Forms.FormBorderStyle.None,
            ShowInTaskbar = false,
            TopMost = true,
            StartPosition = System.Windows.Forms.FormStartPosition.Manual,
            Bounds = new System.Drawing.Rectangle(fromX - 30, fromY - 30, 60, 60),
        };
        int effect = -1;
        string startError = null;
        form.MouseDown += (sender, e) =>
        {
            Console.Error.WriteLine("foreign drop: MouseDown received, entering DoDragDrop");
            var data = new System.Windows.Forms.DataObject(System.Windows.Forms.DataFormats.FileDrop, new[] { file });
            effect = (int)form.DoDragDrop(data, System.Windows.Forms.DragDropEffects.Copy |
                System.Windows.Forms.DragDropEffects.Move | System.Windows.Forms.DragDropEffects.Link);
            form.Close();
        };
        form.Shown += (sender, e) =>
        {
            form.Activate();
            form.BeginInvoke(new Action(() =>
            {
                if (WindowFromPoint(new Point { X = fromX, Y = fromY }) != form.Handle)
                {
                    startError = "the foreign drop source is covered by another window";
                    form.Close();
                    return;
                }
                new Thread(() => Gesture(fromX, fromY, toX, toY, new List<ushort>(), false, 0)) { IsBackground = true }.Start();
            }));
        };
        System.Windows.Forms.Application.Run(form);
        if (startError != null) throw new InvalidOperationException(startError);
        if (effect < 0) throw new InvalidOperationException("the drag never started");
        Console.WriteLine("{\"effect\":" + effect + "}");
        return 0;
    }
}
