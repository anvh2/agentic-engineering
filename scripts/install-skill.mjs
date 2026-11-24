#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../skills/autonomous-engineering/SKILL.md');
const content = readFileSync(source, 'utf8');

function usage() {
  process.stdout.write(`Usage: node scripts/install-skill.mjs [--target PATH] [--agents claude,codex]

Install the Agentic Engineering skill into an existing target repository.
No network access, dependency installation, provider setup, or runtime execution is performed.

Options:
  --target PATH          Target repository (default: current directory)
  --agents LIST          Comma-separated: claude,codex (default: both)
  --help                 Show this help
`);
}

function parse(argv) {
  const result = { target: process.cwd(), agents: ['claude', 'codex'] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--target' || arg === '--agents') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--target') result.target = resolve(value);
      else {
        const agents = value.split(',').map((v) => v.trim()).filter(Boolean);
        if (!agents.length || agents.some((v) => !['claude', 'codex'].includes(v))) {
          throw new Error('--agents accepts only claude,codex');
        }
        result.agents = [...new Set(agents)];
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function ensureDirectoryWithoutSymlinks(root, relativePath) {
  let current = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing non-directory or symlink path: ${current}`);
      }
    } else {
      mkdirSync(current);
    }
  }
  return current;
}

function install(target, agent) {
  const relative = agent === 'claude'
    ? join('.claude', 'skills', 'autonomous-engineering')
    : join('.agents', 'skills', 'autonomous-engineering');
  const directory = ensureDirectoryWithoutSymlinks(target, relative);
  const destination = join(directory, 'SKILL.md');

  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to replace non-regular skill file: ${destination}`);
    }
    if (readFileSync(destination, 'utf8') === content) {
      process.stdout.write(`unchanged ${destination}\n`);
      return;
    }
    throw new Error(`Skill already exists with different content; refusing to overwrite: ${destination}`);
  }

  writeFileSync(destination, content, { flag: 'wx', mode: 0o644 });
  process.stdout.write(`installed ${destination}\n`);
}

const options = parse(process.argv.slice(2));
if (options.help) {
  usage();
} else {
  const target = resolve(options.target);
  if (!isAbsolute(target) || !existsSync(target) || !lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) {
    throw new Error(`Target must be an existing real directory: ${target}`);
  }
  const gitPath = join(target, '.git');
  if (!existsSync(gitPath)) throw new Error(`Target must be the root of an existing Git repository: ${target}`);
  const gitStat = lstatSync(gitPath);
  if (gitStat.isSymbolicLink() || (!gitStat.isDirectory() && !gitStat.isFile())) {
    throw new Error(`Refusing invalid Git metadata path: ${gitPath}`);
  }
  for (const agent of options.agents) install(target, agent);
}
