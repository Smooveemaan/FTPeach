// Goes through the uninstaller as people do, for the installer tests
// (install.ts builds it with the C# compiler every Windows has):
//   uninstall.exe <title> <checkbox>
// waits for the uninstaller window titled <title>, ticks the check box named
// <checkbox> on its confirmation page, presses Uninstall, and Close once it is
// done. Its process is a copy the uninstaller makes of itself, so the window
// is found by its title. Prints whether the box was ticked as one JSON line.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Uninstall
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            return Run(args[0], args[1]);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
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

    static void Press(AutomationElement dialog, string id)
    {
        var button = dialog.FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
            new PropertyCondition(AutomationElement.AutomationIdProperty, id)));
        if (button == null) throw new InvalidOperationException("no button " + id + " in the dialog");
        ((InvokePattern)button.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
    }

    static string Describe(IntPtr hwnd)
    {
        var texts = new List<string>();
        foreach (AutomationElement text in AutomationElement.FromHandle(hwnd).FindAll(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)))
            if (text.Current.Name != "") texts.Add(text.Current.Name);
        return string.Join(" | ", texts);
    }

    static int Run(string title, string checkbox)
    {
        IntPtr hwnd = IntPtr.Zero;
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (hwnd == IntPtr.Zero)
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("no window \"" + title + "\" within 60 s");
            EnumWindows((window, _) =>
            {
                // NSIS ends the caption with a space.
                if (IsWindowVisible(window) && ClassOf(window) == "#32770" && TextOf(window).Trim() == title) hwnd = window;
                return hwnd == IntPtr.Zero;
            }, IntPtr.Zero);
            Thread.Sleep(100);
        }
        var dialog = AutomationElement.FromHandle(hwnd);
        var box = dialog.FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.CheckBox),
            new PropertyCondition(AutomationElement.NameProperty, checkbox)));
        if (box == null) throw new InvalidOperationException("no check box \"" + checkbox + "\": " + Describe(hwnd));
        var toggle = (TogglePattern)box.GetCurrentPattern(TogglePattern.Pattern);
        if (toggle.Current.ToggleState != ToggleState.On) toggle.Toggle();
        bool ticked = toggle.Current.ToggleState == ToggleState.On;
        Press(dialog, "1");
        // The same button turns into Close, enabled once the files are gone.
        deadline = DateTime.UtcNow.AddSeconds(120);
        while (IsWindow(hwnd))
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("the uninstaller did not finish: " + Describe(hwnd));
            try
            {
                var close = dialog.FindFirst(TreeScope.Descendants, new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                    new PropertyCondition(AutomationElement.AutomationIdProperty, "1"),
                    new PropertyCondition(AutomationElement.IsEnabledProperty, true)));
                if (close != null && close.Current.Name != "Uninstall")
                    ((InvokePattern)close.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
            }
            // Closing under the search.
            catch (ElementNotAvailableException) { }
            Thread.Sleep(250);
        }
        Console.WriteLine("{\"ticked\":" + (ticked ? "true" : "false") + "}");
        return 0;
    }
}
