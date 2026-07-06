const SshService = require('./src/services/sshService');

async function main() {
    try {
        console.log("Fetching CrashCore.log (last 100 lines)...");
        const coreLogs = await SshService.runRemoteCommand('tail -n 100 /tmp/ShellCrash/CrashCore.log 2>/dev/null || echo "No CrashCore.log found"');
        console.log("--- CrashCore Logs ---");
        console.log(coreLogs);
        
        console.log("\nFetching syslog (last 100 lines for drops/restarts)...");
        const sysLogs = await SshService.runRemoteCommand('logread -e "mihomo\\|Clash\\|CrashCore" | tail -n 100 || echo "No syslog matches"');
        console.log("--- Syslogs ---");
        console.log(sysLogs);
        
        console.log("\nFetching config yaml main group name...");
        const yaml = await SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml');
        const selectMatch = yaml.match(/name:\s*['"]?([^'"\n]*(?:选择节点|节点选择))['"]?/);
        console.log("Main group name in config:", selectMatch ? selectMatch[1] : 'NOT FOUND');
    } catch (e) {
        console.error(e);
    }
}
main();
