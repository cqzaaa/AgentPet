const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function check() {
  const ps = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WindowInfo {
    public IntPtr Handle;
    public string Title;
    public int ProcessId;
    public string ProcessName;
}

public class WinAPI {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public static List<WindowInfo> GetVisibleWindows() {
        var windows = new List<WindowInfo>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (IsWindowVisible(hWnd)) {
                int length = GetWindowTextLength(hWnd);
                string title = "";
                if (length > 0) {
                    StringBuilder builder = new StringBuilder(length + 1);
                    GetWindowText(hWnd, builder, builder.Capacity);
                    title = builder.ToString();
                }
                
                uint processId;
                GetWindowThreadProcessId(hWnd, out processId);
                
                string processName = "";
                try {
                    var proc = System.Diagnostics.Process.GetProcessById((int)processId);
                    processName = proc.ProcessName;
                } catch { }

                windows.Add(new WindowInfo {
                    Handle = hWnd,
                    Title = title,
                    ProcessId = (int)processId,
                    ProcessName = processName
                });
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
"@ -ErrorAction SilentlyContinue

$windows = [WinAPI]::GetVisibleWindows()
$windows | Select-Object ProcessId, ProcessName, Title | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 10000 });
  const parsed = JSON.parse(stdout.trim());
  console.log(parsed.filter(p => p.Title !== ""));
}
check().catch(console.error);
