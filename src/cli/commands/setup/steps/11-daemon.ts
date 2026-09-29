/** Step 9: PAI daemon installation via launchd plist (macOS) or systemd user unit (Linux). */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { c, line, section, type Rl, promptYesNo } from "../utils.js";

export async function stepDaemon(rl: Rl): Promise<boolean> {
  section("Step 9: Daemon Install");
  line();
  line("  The PAI daemon indexes your projects every 5 minutes in the background.");
  line();

  const isLinux = process.platform === "linux";
  const servicePath = isLinux
    ? join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "systemd", "user", "pai-daemon.service")
    : join(homedir(), "Library", "LaunchAgents", "com.pai.pai-daemon.plist");
  const serviceKind = isLinux ? "systemd user unit" : "launchd plist";
  const exists = existsSync(servicePath);

  if (exists) {
    console.log(c.dim(`  PAI daemon ${serviceKind} already installed.`));
    line();

    const reinstall = await promptYesNo(rl, `Reinstall the PAI daemon ${serviceKind}?`, false);
    if (!reinstall) {
      console.log(c.dim("  Keeping existing daemon installation."));
      return false;
    }
  } else {
    const install = await promptYesNo(rl, "Install the PAI daemon to run automatically at login?", true);
    if (!install) {
      console.log(c.dim("  Skipping daemon install. Run manually: pai daemon install"));
      return false;
    }
  }

  line();
  const result = spawnSync("pai", ["daemon", "install"], { stdio: "inherit" });

  if (result.status !== 0) {
    console.log(c.warn("  Daemon install failed. Run manually: pai daemon install"));
    return false;
  }

  console.log(c.ok(`Daemon installed as ${isLinux ? "pai-daemon.service" : "com.pai.pai-daemon"}.`));
  return true;
}
