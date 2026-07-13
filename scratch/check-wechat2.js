const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function check() {
    const ps = `
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
Select-Object Id, ProcessName, MainWindowTitle |
ConvertTo-Json -Compress
`;
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 10000 });
    let windows = [];
    try {
      const parsed = JSON.parse(stdout.trim());
      windows = Array.isArray(parsed) ? parsed : [parsed];
    } catch(e) {}
    console.log(windows);
}
check().catch(console.error);
