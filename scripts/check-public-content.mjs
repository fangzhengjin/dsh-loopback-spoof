/** Fail when public project files contain likely credentials or private machine/network identifiers. */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const scanRoot = resolve(process.argv[2] ?? projectRoot)
const ignoredDirectories = new Set(['.git', '.agent-teams', '.pnpm-store', 'coverage', 'node_modules'])
const ignoredExtensions = ['.tgz']
const documentationExtensions = ['.env', '.json', '.md', '.toml', '.txt', '.yaml', '.yml']
const codeExtensions = ['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']

/** @typedef {{ label: string, pattern: RegExp, codeCommentsOnly?: boolean, documentationOnly?: boolean }} Rule */
/** @type {Rule[]} */
const rules = [
  {
    label: 'private IPv4 literal',
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  },
  {
    label: 'private or link-local IPv6 literal',
    pattern: /\b(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+\b/gi,
  },
  {
    label: 'absolute Windows path',
    pattern: /\b[A-Za-z]:\x5c[^\s"'`]+/g,
  },
  {
    label: 'forward-slash Windows path',
    pattern: /\b[A-Za-z]:\/[^\s"'`]+/g,
  },
  {
    label: 'UNC network path',
    pattern: /\x5c\x5c[^\x5c\s"'`]+\x5c[^\x5c\s"'`]+(?:\x5c[^\s"'`]*)?/g,
  },
  {
    label: 'Unix user home path',
    pattern: /\/(?:home|Users)\/[^/\\\s"'`]+/g,
  },
  {
    label: 'Unix machine path',
    pattern: /\/(?:etc|media|mnt|opt|root|run|srv|tmp|usr\/local|var)\/[^\\\s"'`]+/g,
  },
  {
    label: 'private or internal hostname',
    pattern: /(?:https?:\/\/|wss?:\/\/|["'`])(?:[a-z0-9-]+\.)+(?:corp|home|internal|intranet|lan|local)(?=[:/?"'`\s]|$)/gi,
  },
  {
    label: 'private or internal hostname in documentation',
    pattern: /\b(?:[a-z0-9-]+\.)+(?:corp|home|internal|intranet|lan|local)\b/gi,
    documentationOnly: true,
  },
  {
    label: 'private or internal hostname in code comment',
    pattern: /(?:^[ \t]*\/\/|[ \t]+\/\/)[^\r\n]*\b(?:[a-z0-9-]+\.)+(?:corp|home|internal|intranet|lan|local)\b/gim,
    codeCommentsOnly: true,
  },
  {
    label: 'private or internal hostname in block comment',
    pattern: /\/\*(?:(?!\*\/)[\s\S])*?\b(?:[a-z0-9-]+\.)+(?:corp|home|internal|intranet|lan|local)\b(?:(?!\*\/)[\s\S])*?\*\//gi,
    codeCommentsOnly: true,
  },
  {
    label: 'email address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    label: 'credential-bearing URL',
    pattern: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi,
  },
  {
    label: 'private key material',
    pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g,
  },
  {
    label: 'well-known access token',
    pattern: /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    label: 'Bearer credential',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  },
  {
    label: 'JWT credential',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    label: 'literal credential assignment',
    pattern: /["']?(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|passwd|password|private[_-]?key|token)["']?\s*[:=]\s*["'][^"'\r\n]{4,}["']/gi,
  },
  {
    label: 'unquoted credential assignment',
    pattern: /\b(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|passwd|password|private[_-]?key|token)\s*[:=]\s*(?!["'`$<])[A-Za-z0-9_.+/=-]{8,}\b/gi,
  },
  {
    label: 'environment credential assignment',
    pattern: /\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PASSWD|PRIVATE_KEY|TOKEN)\s*=\s*(?!["'`$<])[A-Za-z0-9_.+/=-]{8,}\b/g,
  },
]

// The pinned official browser artifact contains one non-routable parser base and
// synthetic fixture paths. None of these values identify a real network or user.
const allowedUpstreamHostname = `http://dsh${'.internal'}`
const allowedFixtureHome = `/${'home'}/${'fixture'}`
const allowedFixtureTemp = `/${'tmp'}/${'fixture'}`

/** @param {string} relativePath @param {string} label @param {string} value */
function isAllowed(relativePath, label, value) {
  if (relativePath !== 'lib/client.js') return false
  if (label === 'private or internal hostname') return value === allowedUpstreamHostname
  if (label === 'Unix user home path') return value === allowedFixtureHome
  if (label === 'Unix machine path') {
    return value === allowedFixtureTemp || value.startsWith(`${allowedFixtureTemp}/`)
  }
  return false
}

async function validateInternalTaskBoundary() {
  if (scanRoot !== projectRoot) return

  const ignoreLines = (await readFile(resolve(scanRoot, '.gitignore'), 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
  if (!ignoreLines.includes('.agents/tasks/')) {
    throw new Error('public-content check: .gitignore must exclude .agents/tasks/')
  }

  const manifest = JSON.parse(await readFile(resolve(scanRoot, 'package.json'), 'utf8'))
  const expectedFiles = ['lib', 'cordis.patch.yml', 'LICENSE', 'README.md']
  if (!Array.isArray(manifest.files) || JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
    throw new Error(`public-content check: package files must equal ${JSON.stringify(expectedFiles)}`)
  }

  if (!existsSync(resolve(scanRoot, '.git'))) return
  const tracked = spawnSync('git', ['-C', scanRoot, 'ls-files', '--', ':(glob).agents/tasks/**'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (tracked.error !== undefined) {
    throw new Error(`public-content check: failed to inspect tracked task files: ${String(tracked.error)}`, {
      cause: tracked.error,
    })
  }
  if (tracked.status !== 0) {
    throw new Error(`public-content check: git ls-files failed with exit ${String(tracked.status)}: ${tracked.stderr.trim()}`)
  }
  if (tracked.stdout.trim() !== '') {
    throw new Error(`public-content check: internal task files are tracked by Git:\n${tracked.stdout.trim()}`)
  }
}

/** @param {string} path @returns {Promise<string[]>} */
async function publicFiles(path) {
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name)
    const relativePath = relative(scanRoot, entryPath).split(sep).join('/')
    if (entry.isSymbolicLink()) {
      throw new Error(`public-content check: symbolic links are not allowed: ${relativePath}`)
    }
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || relativePath === '.agents/tasks') continue
      result.push(...await publicFiles(entryPath))
      continue
    }
    if (!entry.isFile() || ignoredExtensions.some(extension => entry.name.endsWith(extension))) continue
    result.push(entryPath)
  }
  return result
}

/** @param {string} value @param {number} index */
function lineNumber(value, index) {
  let line = 1
  for (let offset = 0; offset < index; offset += 1) {
    if (value.charCodeAt(offset) === 10) line += 1
  }
  return line
}

await validateInternalTaskBoundary()

const findings = []
let scanned = 0
for (const path of await publicFiles(scanRoot)) {
  const stats = await lstat(path)
  if (!stats.isFile()) continue
  const buffer = await readFile(path)
  const relativePath = relative(scanRoot, path).split(sep).join('/')
  if (buffer.includes(0)) {
    throw new Error(`public-content check: NUL-containing files are not allowed: ${relativePath}`)
  }
  const source = buffer.toString('utf8')
  scanned += 1
  for (const rule of rules) {
    if (rule.documentationOnly === true && !documentationExtensions.some(extension => relativePath.endsWith(extension))) continue
    if (rule.codeCommentsOnly === true && !codeExtensions.some(extension => relativePath.endsWith(extension))) continue
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    for (const match of source.matchAll(pattern)) {
      const value = match[0]
      if (isAllowed(relativePath, rule.label, value)) continue
      findings.push({
        file: relativePath,
        label: rule.label,
        line: lineNumber(source, match.index ?? 0),
        value,
      })
    }
  }
}

if (findings.length > 0) {
  const details = findings.map(finding => (
    `${finding.file}:${String(finding.line)}: ${finding.label}: ${JSON.stringify(finding.value)}`
  ))
  throw new Error(`public-content check found ${String(findings.length)} issue(s):\n${details.join('\n')}`)
}

process.stdout.write(`public-content check passed: ${String(scanned)} files scanned\n`)
