import { spawn } from 'node:child_process';

export interface ClaudePrintResult {
  is_error: boolean;
  result: string;
  structured_output?: unknown;
}

/**
 * Invokes the local Claude Code CLI in non-interactive, tool-less mode
 * (`--tools ''`) and asks it to produce structured output matching
 * `jsonSchema`. Shared by the supervisor (planning) and the reviewer
 * (post-hoc, read-only review) - both need the exact same "one-shot text
 * in, structured JSON out, no filesystem access" shape.
 *
 * Uses whatever authentication the CLI already has configured (Claude
 * Pro/Max subscription login via `claude auth login`) - no API key is read
 * or required.
 */
export async function runClaudeCli(options: {
  prompt: string;
  systemPrompt: string;
  jsonSchema: unknown;
}): Promise<ClaudePrintResult> {
  // Claude Code refuses to start a nested session when CLAUDECODE is set (to
  // protect interactive sessions from clobbering each other). That guard
  // doesn't apply to a one-shot, non-interactive `-p` call like this one.
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const stdout = await new Promise<string>((resolve, reject) => {
    // Use spawn (not execFile) so stdin can be explicitly closed. Left as an
    // inherited/open pipe, some CLIs block waiting for stdin to reach EOF.
    const child = spawn(
      'claude',
      [
        '-p',
        options.prompt,
        '--system-prompt',
        options.systemPrompt,
        // Empty tool list: this call can only generate text/structured
        // output, never read or write the filesystem. This is what makes
        // the reviewer genuinely read-only, not just read-only by prompt.
        '--tools',
        '',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(options.jsonSchema),
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutData += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrData += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdoutData);
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderrData || stdoutData}`));
      }
    });
  });

  return JSON.parse(stdout) as ClaudePrintResult;
}
