import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PAGES_DEPLOY_ARGS,
  PRODUCTION_SMOKE_ARGS,
  GIT_BRANCH_ARGS,
  GIT_HEAD_ARGS,
  GIT_DIRTY_ARGS,
  WRANGLER_ENTRY,
  launchCommand,
  pagesDeployArgs,
  parseArguments,
  runRelease,
  verifyReleasePrerequisites,
  verifyReleaseTree,
} from "./deploy-pages-production.mjs";

describe("production Pages release guard", () => {
  test("pins deployment to the complete frontend directory and main branch", () => {
    assert.deepEqual(PAGES_DEPLOY_ARGS, [
      "--cwd",
      "frontend",
      "pages",
      "deploy",
      ".",
      "--project-name=epstein",
      "--branch=main",
    ]);
    assert.equal(Object.isFrozen(PAGES_DEPLOY_ARGS), true);
    assert.deepEqual(PRODUCTION_SMOKE_ARGS, ["production_smoke.py"]);
    assert.deepEqual(GIT_BRANCH_ARGS, ["branch", "--show-current"]);
    assert.deepEqual(GIT_HEAD_ARGS, ["rev-parse", "HEAD"]);
    assert.deepEqual(GIT_DIRTY_ARGS, ["status", "--porcelain", "--untracked-files=normal"]);
    assert.match(WRANGLER_ENTRY, /node_modules[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/);
    assert.deepEqual(pagesDeployArgs("a".repeat(40)), [
      ...PAGES_DEPLOY_ARGS,
      `--commit-hash=${"a".repeat(40)}`,
      "--commit-dirty=false",
    ]);
  });

  test("accepts only the explicit offline smoke switch", () => {
    assert.deepEqual(parseArguments([]), { smokeOnly: false });
    assert.deepEqual(parseArguments(["--smoke-only"]), { smokeOnly: true });
    assert.throws(() => parseArguments(["--site", "https://example.test"]));
  });

  test("runs smoke only after a successful deployment", async () => {
    const events = [];
    const code = await runRelease({
      deployImpl: async (commitHash) => {
        events.push(`deploy:${commitHash}`);
        return 0;
      },
      smokeImpl: async () => {
        events.push("smoke");
        return 0;
      },
      preflightImpl: () => {
        events.push("preflight");
        return "a".repeat(40);
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(events, ["preflight", `deploy:${"a".repeat(40)}`, "smoke"]);
  });

  test("launches Wrangler through Node without a Windows command shim", () => {
    const launch = launchCommand("wrangler", ["pages", "deploy"], {
      platform: "win32",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      wranglerEntry: "D:\\epstein-files\\node_modules\\wrangler\\bin\\wrangler.js",
    });
    assert.deepEqual(launch, {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "D:\\epstein-files\\node_modules\\wrangler\\bin\\wrangler.js",
        "pages",
        "deploy",
      ],
    });
    assert.equal(launch.command.endsWith(".cmd"), false);
  });

  test("checks local Wrangler and Python before production can mutate", () => {
    const events = [];
    verifyReleasePrerequisites({
      accessSyncImpl(path) { events.push(`wrangler:${path}`); },
      execFileSyncImpl(command, args) {
        events.push(`python:${command}:${args[0]}`);
        return "";
      },
      platform: "win32",
      wranglerEntry: "D:\\epstein-files\\node_modules\\wrangler\\bin\\wrangler.js",
    });
    assert.deepEqual(events, [
      "wrangler:D:\\epstein-files\\node_modules\\wrangler\\bin\\wrangler.js",
      "python:python.exe:-c",
    ]);

    assert.throws(
      () => verifyReleasePrerequisites({
        accessSyncImpl() { throw new Error("ENOENT"); },
        execFileSyncImpl() {},
      }),
      /local Wrangler is missing/,
    );
    assert.throws(
      () => verifyReleasePrerequisites({
        accessSyncImpl() {},
        execFileSyncImpl() { throw new Error("wrong Python"); },
      }),
      /Python 3\.11 is required/,
    );
  });

  test("rejects feature branches and dirty release trees", () => {
    const featureGit = (_command, args) => args === GIT_BRANCH_ARGS ? "codex/work\n" : "";
    assert.throws(
      () => verifyReleaseTree({ execFileSyncImpl: featureGit, platform: "linux" }),
      /requires branch main/,
    );
    const dirtyGit = (_command, args) => {
      if (args === GIT_BRANCH_ARGS) return "main\n";
      if (args === GIT_DIRTY_ARGS) return " M frontend/app.js\n";
      return "a".repeat(40) + "\n";
    };
    assert.throws(
      () => verifyReleaseTree({ execFileSyncImpl: dirtyGit, platform: "linux" }),
      /requires a clean/,
    );
  });

  test("never starts smoke after a failed deployment", async () => {
    let smokeCalled = false;
    const code = await runRelease({
      deployImpl: async () => 17,
      smokeImpl: async () => {
        smokeCalled = true;
        return 0;
      },
    });
    assert.equal(code, 17);
    assert.equal(smokeCalled, false);
  });

  test("smoke-only tests cannot invoke the deploy function", async () => {
    let deployCalled = false;
    const code = await runRelease({
      smokeOnly: true,
      deployImpl: async () => {
        deployCalled = true;
        return 0;
      },
      smokeImpl: async () => 0,
    });
    assert.equal(code, 0);
    assert.equal(deployCalled, false);
  });
});
