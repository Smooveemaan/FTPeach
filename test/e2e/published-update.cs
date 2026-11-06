using System;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

static class PublishedUpdate
{
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            int pid = int.Parse(args[0]);
            string action = args[1], name = args[2];
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
                        var elements = window.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                        foreach (AutomationElement element in elements)
                        {
                            if (element.Current.IsOffscreen) continue;
                            string text = element.Current.Name.Trim();
                            if (action == "text" && (text == name || text == "FTPeach " + name))
                            {
                                Console.WriteLine(text);
                                return 0;
                            }
                            if (text != name) continue;
                            object pattern;
                            if (action == "invoke" && element.Current.IsEnabled &&
                                element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                            {
                                ((InvokePattern)pattern).Invoke();
                                return 0;
                            }
                        }
                    }
                    catch (ElementNotAvailableException) { }
                }
                Thread.Sleep(200);
            }
            throw new TimeoutException("UIA " + action + " did not find: " + name);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
