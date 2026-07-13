const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function check() {
    const ps = `
$shell = New-Object -ComObject WScript.Shell
$success = $shell.AppActivate("微信")
Write-Output "AppActivate returned: $success"
`;
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 10000 });
    console.log(stdout);
}
check().catch(console.error);
