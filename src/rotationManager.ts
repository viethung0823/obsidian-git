import * as fs from "fs/promises";
import * as path from "path";
import { Platform } from "obsidian";
import type ObsidianGit from "./main";
import { spawnAsync } from "./utils";
import { RotationModal } from "./ui/modals/rotationModal";

export interface RotationPlan {
    due: boolean;
    oldLabel: string | null;
    newLabel: string;
    oldYear?: number;
    oldMonth?: number;
}

function makeLabel(prefix: string, year: number, month: number): string {
    return `${prefix}_${String(month).padStart(2, "0")}_${year}`;
}

function parseRemote(
    prefix: string,
    remoteUrl: string
): { year: number; month: number; repoName: string } | null {
    const match = remoteUrl.match(/[:/]([^/]+?)\/([^/]+?)(?:\.git)?$/);
    const repoName = match?.[2];
    if (!repoName) return null;
    const re = new RegExp(`^${prefix}_(\\d{2})_(\\d{4})$`);
    const m = repoName.match(re);
    const monthStr = m?.[1];
    const yearStr = m?.[2];
    if (!monthStr || !yearStr) return null;
    return {
        month: parseInt(monthStr, 10),
        year: parseInt(yearStr, 10),
        repoName,
    };
}

/**
 * Desktop-only companion to the normal Git sync features: rotates a
 * screenshot-style vault to a fresh GitHub repo every calendar month, so no
 * single repo grows without bound. Never runs on mobile - it shells out to
 * the native `git`/`gh` binaries and rewrites the local `.git` directory.
 *
 * All destructive work is queued through `plugin.promiseQueue` so it never
 * runs concurrently with the plugin's own commit/push/pull routines.
 */
export class RotationManager {
    private intervalId: number | undefined;
    private statusBarEl: HTMLElement | undefined;

    constructor(private readonly plugin: ObsidianGit) {}

    async init(): Promise<void> {
        if (
            !Platform.isDesktopApp ||
            !this.plugin.settings.monthlyRotation.enabled
        ) {
            return;
        }
        this.statusBarEl = this.plugin.addStatusBarItem();
        this.statusBarEl.addClass("mod-clickable");
        this.statusBarEl.onClickEvent(() => void this.promptRotation());
        await this.refreshStatusBar();

        this.intervalId = window.setInterval(
            () => void this.checkAndNotify(false),
            6 * 60 * 60 * 1000
        );
        this.plugin.intervalsToClear.push(this.intervalId);
    }

    unload(): void {
        this.statusBarEl?.remove();
        this.statusBarEl = undefined;
    }

    private basePath(): string {
        return (
            this.plugin.gitManager as unknown as { absoluteRepoPath: string }
        ).absoluteRepoPath;
    }

    private gitBin(): string {
        return this.plugin.localStorage.getGitPath() || "git";
    }

    private env(): NodeJS.ProcessEnv {
        const pathPaths = this.plugin.localStorage.getPATHPaths();
        const env = { ...process.env };
        if (pathPaths.length > 0) {
            env["PATH"] = [...pathPaths, env["PATH"] ?? ""]
                .filter(Boolean)
                .join(path.delimiter);
        }
        return env;
    }

    private async run(cmd: string, args: string[]): Promise<string> {
        const result = await spawnAsync(cmd, args, {
            cwd: this.basePath(),
            env: this.env(),
        });
        if (result.error || result.code !== 0) {
            throw new Error(
                `${cmd} ${args.join(" ")} failed: ${result.stderr || result.error?.message || `exit ${result.code}`}`
            );
        }
        return result.stdout.trim();
    }

    private async tryRun(cmd: string, args: string[]): Promise<string | null> {
        try {
            return await this.run(cmd, args);
        } catch {
            return null;
        }
    }

    async checkStatus(): Promise<RotationPlan> {
        const settings = this.plugin.settings.monthlyRotation;
        const now = new Date();
        const newLabel = makeLabel(
            settings.repoPrefix,
            now.getFullYear(),
            now.getMonth() + 1
        );

        const remote = await this.tryRun(this.gitBin(), [
            "remote",
            "get-url",
            "origin",
        ]);
        if (!remote) return { due: false, oldLabel: null, newLabel };

        const parsed = parseRemote(settings.repoPrefix, remote);
        if (!parsed) return { due: false, oldLabel: remote, newLabel };

        return {
            due: parsed.repoName !== newLabel,
            oldLabel: parsed.repoName,
            newLabel,
            oldYear: parsed.year,
            oldMonth: parsed.month,
        };
    }

    private async refreshStatusBar(plan?: RotationPlan): Promise<void> {
        if (!this.statusBarEl) return;
        const p = plan ?? (await this.checkStatus().catch(() => null));
        if (!p) {
            this.statusBarEl.setText("ScreenMemory: status unknown");
            return;
        }
        this.statusBarEl.setText(
            p.due
                ? `ScreenMemory: rotation due -> ${p.newLabel}`
                : `ScreenMemory: ${p.newLabel}`
        );
    }

    async checkAndNotify(force: boolean): Promise<void> {
        let plan: RotationPlan;
        try {
            plan = await this.checkStatus();
        } catch (e) {
            this.plugin.displayError(e);
            return;
        }
        await this.refreshStatusBar(plan);

        const settings = this.plugin.settings.monthlyRotation;
        if (plan.due && settings.autoRunWithoutConfirm) {
            this.plugin.promiseQueue.addTask(() => this.runRotation(plan));
            return;
        }
        if (plan.due) {
            this.plugin.displayMessage(
                `ScreenMemory: rotation due (${plan.oldLabel} -> ${plan.newLabel}). Run it from the status bar or command palette.`
            );
        } else if (force) {
            this.plugin.displayMessage(
                `ScreenMemory: already on ${plan.newLabel}.`
            );
        }
    }

    async promptRotation(): Promise<void> {
        let plan: RotationPlan;
        try {
            plan = await this.checkStatus();
        } catch (e) {
            this.plugin.displayError(e);
            return;
        }
        if (!plan.due) {
            this.plugin.displayMessage(
                `ScreenMemory: already on ${plan.newLabel} - nothing to rotate.`
            );
            return;
        }
        const confirmed = await new RotationModal(
            this.plugin.app,
            plan
        ).openAndGetResult();
        if (confirmed) {
            this.plugin.promiseQueue.addTask(() => this.runRotation(plan));
        }
    }

    // Commits in small batches (mirroring the vault's previous auto_push.sh)
    // rather than one `git add -A && git commit`, since a single commit
    // holding weeks of screenshots is exactly what overflows GitHub's pack
    // size limit - chunking the *push* afterwards can't fix an oversized
    // commit that already exists.
    // Prefers the vault's own proven scripts (auto_push.sh, git-push-chunks.sh)
    // when present, since they're already tuned for this exact repo. Falls
    // back to the built-in equivalents below when a vault doesn't have them.
    private async runScriptIfPresent(
        scriptName: string,
        log: (msg: string) => void
    ): Promise<boolean> {
        const scriptPath = path.join(this.basePath(), scriptName);
        try {
            await fs.access(scriptPath);
        } catch {
            return false;
        }
        log(`Running ${scriptName}...`);
        const result = await spawnAsync(scriptPath, [], {
            cwd: this.basePath(),
            env: this.env(),
        });
        for (const line of result.stdout.split("\n").filter(Boolean)) {
            log(line);
        }
        if (result.error || result.code !== 0) {
            throw new Error(
                `${scriptName} failed: ${result.stderr || result.error?.message || `exit ${result.code}`}`
            );
        }
        return true;
    }

    private async commitInBatches(
        batchSize: number,
        oldLabel: string,
        log: (msg: string) => void
    ): Promise<void> {
        for (;;) {
            const listing = await this.run(this.gitBin(), [
                "ls-files",
                "-o",
                "-m",
                "--exclude-standard",
            ]);
            const files = listing
                .split("\n")
                .filter(Boolean)
                .slice(0, batchSize);
            if (files.length === 0) break;
            log(`Committing a batch of ${files.length} file(s)...`);
            await this.run(this.gitBin(), ["add", "--", ...files]);
            await this.run(this.gitBin(), [
                "commit",
                "-m",
                `final backup: ${oldLabel}`,
            ]);
        }
    }

    private async pushInChunks(
        branch: string,
        chunkSize: number,
        log: (msg: string) => void
    ): Promise<void> {
        await this.run(this.gitBin(), ["fetch", "origin", branch]);
        const commits = (
            await this.run(this.gitBin(), [
                "rev-list",
                `origin/${branch}..HEAD`,
                "--reverse",
            ])
        )
            .split("\n")
            .filter(Boolean);

        for (let i = chunkSize - 1; i < commits.length; i += chunkSize) {
            const commit = commits[i];
            if (!commit) continue;
            log(`Pushing up to ${commit.slice(0, 7)}...`);
            await this.run(this.gitBin(), [
                "push",
                "origin",
                `${commit}:${branch}`,
            ]);
        }
        const last = commits[commits.length - 1];
        if (last && commits.length % chunkSize !== 0) {
            log(`Pushing final commit ${last.slice(0, 7)}...`);
            await this.run(this.gitBin(), [
                "push",
                "origin",
                `${last}:${branch}`,
            ]);
        }
    }

    async runRotation(plan: RotationPlan): Promise<void> {
        const settings = this.plugin.settings.monthlyRotation;
        if (
            !plan.due ||
            !plan.oldLabel ||
            plan.oldYear === undefined ||
            plan.oldMonth === undefined
        ) {
            this.plugin.displayMessage("ScreenMemory: nothing to rotate.");
            return;
        }
        const log = (msg: string) =>
            this.plugin.displayMessage(`ScreenMemory: ${msg}`);

        try {
            log(`Rotating ${plan.oldLabel} -> ${plan.newLabel}`);

            const branch = await this.run(this.gitBin(), [
                "rev-parse",
                "--abbrev-ref",
                "HEAD",
            ]);

            const usedAutoPush = await this.runScriptIfPresent(
                "auto_push.sh",
                log
            );
            if (!usedAutoPush) {
                await this.commitInBatches(
                    settings.commitBatchSize,
                    plan.oldLabel,
                    log
                );
            }

            // Never attempt one big `git push` for a backlog - that's what
            // stalled out near GitHub's pack-size limit and blocked the
            // shared commit queue for 26+ minutes the first time this ran.
            // Always go through the vault's chunked-push script, or the
            // built-in equivalent, whenever there's more than a small number
            // of commits still unpushed.
            await this.run(this.gitBin(), ["fetch", "origin", branch]);
            const usedChunkScript = await this.runScriptIfPresent(
                "git-push-chunks.sh",
                log
            );
            if (!usedChunkScript) {
                const unpushedCount = parseInt(
                    await this.run(this.gitBin(), [
                        "rev-list",
                        "--count",
                        `origin/${branch}..HEAD`,
                    ]),
                    10
                );
                if (unpushedCount === 0) {
                    log("Nothing left to push.");
                } else if (unpushedCount > settings.pushChunkSize) {
                    log(
                        `${unpushedCount} unpushed commit(s) - pushing in chunks of ${settings.pushChunkSize}...`
                    );
                    await this.pushInChunks(
                        branch,
                        settings.pushChunkSize,
                        log
                    );
                } else {
                    log(
                        `Pushing ${unpushedCount} commit(s) to ${plan.oldLabel}...`
                    );
                    await this.run(this.gitBin(), ["push", "origin", branch]);
                }
            }

            // Never delete or reset anything until the push is verified against origin.
            await this.run(this.gitBin(), ["fetch", "origin", branch]);
            const localHead = await this.run(this.gitBin(), [
                "rev-parse",
                "HEAD",
            ]);
            const remoteHead = await this.run(this.gitBin(), [
                "rev-parse",
                `origin/${branch}`,
            ]);
            if (localHead !== remoteHead) {
                throw new Error(
                    `Push did not fully land (local ${localHead} != origin ${remoteHead}). Stopping before cleanup - nothing was deleted.`
                );
            }
            log("Push verified against origin.");

            if (settings.deleteAfterPush) {
                const monthDir = path.join(
                    this.basePath(),
                    settings.screenshotsFolder,
                    String(plan.oldYear),
                    String(plan.oldMonth).padStart(2, "0")
                );
                log(
                    `Deleting local screenshots for the completed month: ${monthDir}`
                );
                await fs.rm(monthDir, { recursive: true, force: true });
            }

            log("Resetting local git history for a clean start...");
            await fs.rm(path.join(this.basePath(), ".git"), {
                recursive: true,
                force: true,
            });
            await this.run(this.gitBin(), ["init", "-b", "main"]);

            const repoExists = await this.tryRun("gh", [
                "repo",
                "view",
                `${settings.owner}/${plan.newLabel}`,
            ]);
            if (repoExists === null) {
                log(`Creating GitHub repo ${plan.newLabel}...`);
                await this.run("gh", [
                    "repo",
                    "create",
                    `${settings.owner}/${plan.newLabel}`,
                    settings.privateRepo ? "--private" : "--public",
                ]);
            }

            await this.run(this.gitBin(), [
                "remote",
                "add",
                "origin",
                `git@${settings.sshHost}:${settings.owner}/${plan.newLabel}.git`,
            ]);
            await this.run(this.gitBin(), ["add", "-A"]);
            await this.run(this.gitBin(), [
                "commit",
                "-m",
                `Initial commit for ${plan.newLabel}`,
            ]);
            log(`Pushing initial commit to ${plan.newLabel}...`);
            await this.run(this.gitBin(), ["push", "-u", "origin", "main"]);

            log(`Rotation complete: now on ${plan.newLabel}.`);
            await this.refreshStatusBar({
                due: false,
                oldLabel: plan.newLabel,
                newLabel: plan.newLabel,
            });

            // The .git directory was completely replaced - let the rest of the
            // plugin (source control view, history view, branch status bar)
            // know its cached state is stale.
            this.plugin.app.workspace.trigger("obsidian-git:refresh");
            this.plugin.app.workspace.trigger("obsidian-git:head-change");
        } catch (e) {
            this.plugin.displayError(
                new Error(
                    `ScreenMemory Rotator FAILED: ${(e as Error).message}. Nothing further was changed.`
                )
            );
        }
    }
}
