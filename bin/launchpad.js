#!/usr/bin/env node
/**
 * Thin shim so `launchpad <command>` works from any directory.
 *
 * It runs the TypeScript sources through tsx rather than a build output, so
 * edits take effect with no rebuild step. The child inherits the caller's
 * working directory, which is what makes it read the .env and .launch/ of
 * wherever you happen to be rather than of the install location.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsx = resolve(root, 'node_modules/.bin/tsx')

if (!existsSync(tsx)) {
  console.error(`tsx not found at ${tsx}. Run \`npm install\` in ${root}.`)
  process.exit(1)
}

const result = spawnSync(tsx, [resolve(root, 'src/cli.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})

process.exit(result.status ?? 1)
