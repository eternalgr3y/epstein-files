#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PAGES_DEPLOY_ARGS = Object.freeze([
  "--cwd",
  "frontend",
  "pages",
  "deploy",
  ".",
  "--project-name=epstein",
  "--branch=main",
]);
export const PRODUCTION_SMOKE_ARGS = Object.freeze(["production_smoke.py"]);
export const GIT_BRANCH_ARGS = Object.freeze(["branch", "--show-current"]);
export const GIT_HEAD_ARGS = Object.freeze(["rev-parse", "HEAD"]);
export const GIT_DIRTY_ARGS = Object.freeze(["status", "--porcelain", "--untracked-files=normal"]);
export const WRANGLER_ENTRY = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

export function launchCommand(
  name,
  args,
  {
    platform = process.platform,
    nodeExecutable = process.execPath,
    wranglerEntry = WRANGLER_ENTRY,
  } = {},
) {
  // Node cannot spawn a .cmd shim with shell:false on Windows. Run Wrangler's
  // JavaScript entry through the current Node executable on every platform so
  // argument boundaries remain exact and no command shell is involved.
  if (name === "wrangler") {
    return { command: nodeExecutable, args: [wranglerEntry, ...args] };
  }
  return {
    command: platform === "win32" ? "python.exe" : "python3",
    args,
  };
}

function runChild(command, args, { spawnImpl = spawn, platform = process.platform } = {}) {
  const launch = launchCommand(command, args, { platform });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(launch.command, launch.args, {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

export function pagesDeployArgs(commitHash) {
  if (!/^[0-9a-f]{40}$/.test(commitHash || "")) {
    throw new Error("production deploy requires an exact lowercase Git commit SHA");
  }
  return [...PAGES_DEPLOY_ARGS, `--commit-hash=${commitHash}`, "--commit-dirty=false"];
}

export function deployPages(commitHash, options) {
  return runChild("wrangler", pagesDeployArgs(commitHash), options);
}

export function smokeProduction(options) {
  return runChild(
    "python",
    [
      ...PRODUCTION_SMOKE_ARGS,
      "--expected-app", "frontend/app.js",
      "--expected-css", "frontend/static/app.css",
    ],
    options,
  );
}

function captureGit(args, { execFileSyncImpl, platform = process.platform }) {
  return String(execFileSyncImpl(platform === "win32" ? "git.exe" : "git", args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    shell: false,
  })).trim();
}

export function verifyReleaseTree({ execFileSyncImpl, platform } = {}) {
  if (!execFileSyncImpl) {
    throw new Error("verifyReleaseTree requires an execFileSync implementation");
  }
  const branch = captureGit(GIT_BRANCH_ARGS, { execFileSyncImpl, platform });
  if (branch !== "main") throw new Error(`production deploy requires branch main, found ${branch || "detached HEAD"}`);
  const dirty = captureGit(GIT_DIRTY_ARGS, { execFileSyncImpl, platform });
  if (dirty) throw new Error("production deploy requires a clean tracked and untracked working tree");
  const head = captureGit(GIT_HEAD_ARGS, { execFileSyncImpl, platform });
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("production deploy requires an exact Git HEAD");
  return head;
}

export function verifyReleasePrerequisites({
  accessSyncImpl = accessSync,
  execFileSyncImpl,
  platform = process.platform,
  wranglerEntry = WRANGLER_ENTRY,
} = {}) {
  if (!execFileSyncImpl) {
    throw new Error("verifyReleasePrerequisites requires an execFileSync implementation");
  }
  try {
    accessSyncImpl(wranglerEntry);
  } catch {
    throw new Error(
      "local Wrangler is missing; run the pinned frozen dependency install first",
    );
  }

  const python = launchCommand("python", [
    "-c",
    "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)",
  ], { platform });
  try {
    execFileSyncImpl(python.command, python.args, {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      shell: false,
      stdio: "pipe",
    });
  } catch {
    throw new Error("Python 3.11 is required for the mandatory production smoke");
  }
}

export function parseArguments(argv) {
  if (argv.length === 0) return { smokeOnly: false };
  if (argv.length === 1 && argv[0] === "--smoke-only") return { smokeOnly: true };
  throw new Error(`unknown argument: ${argv.join(" ")}`);
}

export async function runRelease({
  smokeOnly = false,
  deployImpl = deployPages,
  smokeImpl = smokeProduction,
  preflightImpl = () => {},
} = {}) {
  if (!smokeOnly) {
    const commitHash = preflightImpl();
    const deployCode = await deployImpl(commitHash);
    if (deployCode !== 0) return deployCode;
  }
  return smokeImpl();
}

export async function main(argv = process.argv.slice(2)) {
  const { execFileSync } = await import("node:child_process");
  const { smokeOnly } = parseArguments(argv);
  if (!smokeOnly) console.log("Deploying the complete frontend/ Pages project on branch main...");
  const code = await runRelease({
    smokeOnly,
    preflightImpl: () => {
      const head = verifyReleaseTree({ execFileSyncImpl: execFileSync });
      verifyReleasePrerequisites({ execFileSyncImpl: execFileSync });
      return head;
    },
  });
  if (code !== 0) console.error("FAIL production release gate");
  else console.log("PASS production release gate");
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`FAIL ${error.message}`);
      process.exitCode = 1;
    });
}
