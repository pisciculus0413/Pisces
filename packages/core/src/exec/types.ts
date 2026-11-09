export interface WorkspaceAccess {
  resolve(path: string): string;
  ensureDirectory(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface Exec {
  run(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}
