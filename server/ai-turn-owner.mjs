import { spawn } from "node:child_process";
import { Socket } from "node:net";

import { executableCommand } from "../shared/executable-command.mjs";
import { signalProcessTree } from "../shared/process-tree.mjs";

const [executable, encodedArgs] = process.argv.slice(2);
if (!executable || !encodedArgs) process.exit(2);

const command = executableCommand(executable, JSON.parse(encodedArgs));
const child = spawn(command.executable, command.args, {
  env: process.env,
  stdio: "inherit",
});

const control = new Socket({ fd: 3, readable: true, writable: false });
const terminateGroup = () => {
  if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGKILL");
      return;
    } catch {}
  }
  signalProcessTree(child, "SIGKILL");
  process.exit(1);
};
control.once("end", terminateGroup);
control.once("error", terminateGroup);
control.resume();

child.once("error", (error) => {
  const detail = error.code === "ENOENT"
    ? "Codex CLI was not found on this machine"
    : error.message;
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (process.platform === "win32") {
    // On Windows `process.kill(pid, signal)` does not re-raise a POSIX signal;
    // for SIGINT/SIGBREAK it sends a console event (GenerateConsoleCtrlEvent)
    // that terminates this process with STATUS_CONTROL_C_EXIT (0xC000013A),
    // which the server records as a misleading "killed mid-run" exit. Exit with
    // a stable non-zero code instead so the failure reason stays readable.
    process.exit(signal ? 1 : (code ?? 1));
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
