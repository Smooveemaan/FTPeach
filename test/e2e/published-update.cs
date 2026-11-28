using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

static class PublishedUpdate
{
    static bool TryActivate(AutomationElement element)
    {
        object pattern;
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
        {
            ((InvokePattern)pattern).Invoke();
            return true;
        }
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
        {
            var expandable = (ExpandCollapsePattern)pattern;
            if (expandable.Current.ExpandCollapseState == ExpandCollapseState.Expanded)
                expandable.Collapse();
            else
                expandable.Expand();
            return true;
        }
        return false;
    }

    static string Describe(AutomationElement element)
    {
        var patterns = new List<string>();
        foreach (var supported in element.GetSupportedPatterns())
            patterns.Add(supported.ProgrammaticName);
        return string.Format("{0} ({1}, offscreen={2}, enabled={3}, patterns=[{4}])",
            element.Current.Name.Trim(),
            element.Current.ControlType.ProgrammaticName,
            element.Current.IsOffscreen,
            element.Current.IsEnabled,
            string.Join(",", patterns));
    }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            int pid = int.Parse(args[0]);
            string action = args[1], name = args[2];
            string lastMatches = "";
            var deadline = DateTime.UtcNow.AddSeconds(45);
            while (DateTime.UtcNow < deadline)
            {
                var process = Process.GetProcessById(pid);
                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    try
                    {
                        var window = AutomationElement.FromHandle(process.MainWindowHandle);
                        if (args.Length > 3)
                        {
                            AutomationElement scope = null;
                            foreach (AutomationElement candidate in window.FindAll(TreeScope.Descendants,
                                new PropertyCondition(AutomationElement.NameProperty, args[3])))
                            {
                                if (!candidate.Current.IsOffscreen && candidate.FindFirst(TreeScope.Descendants,
                                    new AndCondition(new PropertyCondition(AutomationElement.NameProperty, "Close"),
                                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))) != null)
                                {
                                    scope = candidate;
                                    break;
                                }
                            }
                            if (scope == null) { Thread.Sleep(200); continue; }
                            window = scope;
                        }
                        var matches = new List<string>();
                        var elements = window.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                        foreach (AutomationElement element in elements)
                        {
                            string text = element.Current.Name.Trim();
                            if (text == name || text == "FTPeach " + name)
                                matches.Add(Describe(element));
                            if (element.Current.IsOffscreen) continue;
                            if (action == "text" && (text == name || text == "FTPeach " + name))
                            {
                                Console.WriteLine(text);
                                return 0;
                            }
                            if (text != name) continue;
                            if (action == "invoke" && element.Current.IsEnabled && TryActivate(element))
                            {
                                return 0;
                            }
                        }
                        if (matches.Count > 0)
                            lastMatches = string.Join("; ", matches);
                    }
                    catch (ElementNotAvailableException) { }
                }
                Thread.Sleep(200);
            }
            string detail = lastMatches.Length > 0 ? " (seen: " + lastMatches + ")" : "";
            throw new TimeoutException("UIA " + action + " did not find: " + name + detail);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
