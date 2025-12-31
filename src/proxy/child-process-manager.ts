import { spawn, type ChildProcess } from "node:child_process";
import { ProxyChildProcessError } from "../utils/errors.js";
import type { ManagedChildProcess } from "./types.js";

export class ChildProcessManager {
  private child: ChildProcess | null = null;
  private _restartCount = 0;
  private _isRunning = false;
  private readonly command: string;
  private readonly maxRestarts: number;
  private readonly verbose: boolean;
  private readonly onExit?: (code: number | null, signal: string | null) => void;
  private readonly onError?: (error: Error) => void;

  constructor(options: {
    command: string;
    maxRestarts?: number;
    verbose?: boolean;
    onExit?: (code: number | null, signal: string | null) => void;
    onError?: (error: Error) => void;
  }) {
    this.command = options.command;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.verbose = options.verbose ?? false;
    this.onExit = options.onExit;
    this.onError = options.onError;
  }

  get restartCount(): number {
    return this._restartCount;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.error(`[ChildProcessManager] ${message}`);
    }
  }

  async spawn(): Promise<ManagedChildProcess> {
    if (this._isRunning && this.child) {
      return this.getManagedProcess();
    }

    this.log(`Spawning child process: ${this.command}`);

    const child = spawn(this.command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this._isRunning = true;

    child.on("error", (error) => {
      this.log(`Child process error: ${error.message}`);
      this._isRunning = false;
      this.onError?.(error);
    });

    child.on("exit", (code, signal) => {
      this.log(`Child process exited with code ${code}, signal ${signal}`);
      this._isRunning = false;
      this.onExit?.(code, signal);
    });

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        if (this.verbose) {
          console.error(`[child stderr] ${data.toString()}`);
        }
      });
    }

    await this.waitForReady(child);

    return this.getManagedProcess();
  }

  private async waitForReady(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 1000);

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on("spawn", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async restart(): Promise<ManagedChildProcess> {
    this._restartCount++;

    if (this._restartCount > this.maxRestarts) {
      throw new ProxyChildProcessError(
        this.command,
        this._restartCount,
        `Maximum restart attempts (${this.maxRestarts}) exceeded`,
      );
    }

    this.log(`Restarting child process (attempt ${this._restartCount}/${this.maxRestarts})`);

    this.kill();
    await this.delay(500 * this._restartCount);

    return this.spawn();
  }

  resetRestartCount(): void {
    if (this._restartCount > 0) {
      this.log("Resetting restart count (child is healthy)");
      this._restartCount = 0;
    }
  }

  kill(): void {
    if (this.child && this._isRunning) {
      this.log("Killing child process");
      this.child.kill("SIGTERM");

      setTimeout(() => {
        if (this.child && this._isRunning) {
          this.log("Force killing child process with SIGKILL");
          this.child.kill("SIGKILL");
        }
      }, 1000);

      this._isRunning = false;
    }
  }

  private getManagedProcess(): ManagedChildProcess {
    if (!this.child || !this.child.stdin || !this.child.stdout || !this.child.stderr) {
      throw new ProxyChildProcessError(
        this.command,
        this._restartCount,
        "Child process streams not available",
      );
    }

    return {
      process: this.child,
      stdin: this.child.stdin,
      stdout: this.child.stdout,
      stderr: this.child.stderr,
      kill: () => this.kill(),
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
