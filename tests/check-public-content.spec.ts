import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const scanner = resolve(root, 'scripts', 'check-public-content.mjs')
const temporaryRoots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}

function runScanner(scanRoot: string, script = scanner) {
  return spawnSync(process.execPath, [script, scanRoot], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('public-content release gate', () => {
  it('rejects private network, machine path, internal host, and credential fixtures', async () => {
    const scanRoot = await temporaryRoot('dsh-public-rules-')
    const slash = String.fromCharCode(92)
    const value = 'abcdefghijklmnop'
    const internalHost = ['build', 'corp'].join('.')
    const credentialKey = ['pass', 'word'].join('')
    const environmentKey = ['DEPLOY', 'TOKEN'].join('_')
    const credentialUrl = ['https', '://', 'user', ':', value, '@', ['example', 'com'].join('.')].join('')
    const fixtures = [
      ['192', '168', '50', '23'].join('.'),
      ['fd12', '3456', '', '1'].join(':'),
      slash.repeat(2) + ['fileserver', 'share', 'secret.txt'].join(slash),
      ['E:', 'Workspace', 'private', 'project'].join(slash),
      ['E:', 'Workspace', 'private', 'project'].join('/'),
      `/${['home', 'private-user', 'secret.txt'].join('/')}`,
      `/${['root', '.ssh', 'id_rsa'].join('/')}`,
      `host: ${internalHost}`,
      `${['private-user', ['example', 'com'].join('.')].join('@')}`,
      credentialUrl,
      ['-----BEGIN ', ['PRIVATE', 'KEY'].join(' '), '-----'].join(''),
      `${credentialKey}: '${value}'`,
      `token = ${value}`,
      `${environmentKey}=${value}`,
      `Authorization: ${['Bear', 'er'].join('')} ${value}`,
      ['eyJabcdefghijk', 'abcdefghijk', 'abcdefghijk'].join('.'),
      ['xoxb', '1234567890', 'abcdefghij'].join('-'),
    ]
    await writeFile(join(scanRoot, 'fixture.md'), fixtures.join('\n'), 'utf8')
    await writeFile(
      join(scanRoot, 'fixture.ts'),
      [
        `const endpoint = 'https://${internalHost}/api'`,
        `// connect to ${internalHost} during development`,
        '/*',
        ` connect to ${internalHost} during development`,
        '*/',
      ].join('\n'),
      'utf8',
    )

    const result = runScanner(scanRoot)
    const output = `${result.stdout}\n${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(output).toContain('private IPv4 literal')
    expect(output).toContain('private or link-local IPv6 literal')
    expect(output).toContain('UNC network path')
    expect(output).toContain('absolute Windows path')
    expect(output).toContain('forward-slash Windows path')
    expect(output).toContain('Unix user home path')
    expect(output).toContain('Unix machine path')
    expect(output).toContain('private or internal hostname:')
    expect(output).toContain('private or internal hostname in documentation')
    expect(output).toContain('private or internal hostname in code comment')
    expect(output).toContain('private or internal hostname in block comment')
    expect(output).toContain('email address')
    expect(output).toContain('credential-bearing URL')
    expect(output).toContain('private key material')
    expect(output).toContain('literal credential assignment')
    expect(output).toContain('unquoted credential assignment')
    expect(output).toContain('environment credential assignment')
    expect(output).toContain('Bearer credential')
    expect(output).toContain('JWT credential')
    expect(output).toContain('well-known access token')
  })

  it('allows only the exact official temporary fixture path boundary', async () => {
    const scanRoot = await temporaryRoot('dsh-public-fixture-path-')
    const clientDirectory = join(scanRoot, 'lib')
    const fixtureRoot = `/${['tmp', 'fixture'].join('/')}`
    await mkdir(clientDirectory, { recursive: true })
    await writeFile(join(clientDirectory, 'client.js'), `${fixtureRoot}/deep/nested`, 'utf8')
    const allowedResult = runScanner(scanRoot)
    expect(allowedResult.status, `${allowedResult.stdout}\n${allowedResult.stderr}`).toBe(0)

    await writeFile(join(clientDirectory, 'client.js'), `${fixtureRoot}-private`, 'utf8')
    const rejectedResult = runScanner(scanRoot)
    expect(rejectedResult.status).not.toBe(0)
    expect(`${rejectedResult.stdout}\n${rejectedResult.stderr}`).toContain('Unix machine path')
  })

  it('rejects NUL files and symbolic links instead of skipping them', async () => {
    const nulRoot = await temporaryRoot('dsh-public-nul-')
    await writeFile(join(nulRoot, 'fixture.bin'), Buffer.from([65, 0, 66]))
    const nulResult = runScanner(nulRoot)
    expect(nulResult.status).not.toBe(0)
    expect(`${nulResult.stdout}\n${nulResult.stderr}`).toContain('NUL-containing files are not allowed')

    const linkRoot = await temporaryRoot('dsh-public-link-')
    const target = join(linkRoot, 'target.txt')
    await writeFile(target, 'safe fixture', 'utf8')
    await symlink(target, join(linkRoot, 'link.txt'))
    const linkResult = runScanner(linkRoot)
    expect(linkResult.status).not.toBe(0)
    expect(`${linkResult.stdout}\n${linkResult.stderr}`).toContain('symbolic links are not allowed')
  })

  it('rejects tracked task memory and accepts the same ignored untracked file', async () => {
    const scanRoot = await temporaryRoot('dsh-public-git-')
    const scripts = join(scanRoot, 'scripts')
    const tasks = join(scanRoot, '.agents', 'tasks')
    await mkdir(scripts, { recursive: true })
    await mkdir(tasks, { recursive: true })
    await copyFile(scanner, join(scripts, 'check-public-content.mjs'))
    await writeFile(join(scanRoot, '.gitignore'), '.agents/tasks/\n', 'utf8')
    await writeFile(join(scanRoot, 'package.json'), JSON.stringify({
      files: ['lib', 'cordis.patch.yml', 'LICENSE', 'README.md'],
    }), 'utf8')
    await writeFile(join(tasks, 'memory.md'), 'internal construction record', 'utf8')

    runGit(scanRoot, ['init', '-b', 'main'])
    runGit(scanRoot, ['add', '.'])
    runGit(scanRoot, ['add', '-f', '.agents/tasks/memory.md'])

    const trackedResult = runScanner(scanRoot, join(scripts, 'check-public-content.mjs'))
    expect(trackedResult.status).not.toBe(0)
    expect(`${trackedResult.stdout}\n${trackedResult.stderr}`).toContain('internal task files are tracked by Git')

    runGit(scanRoot, ['rm', '--cached', '.agents/tasks/memory.md'])
    const ignoredResult = runScanner(scanRoot, join(scripts, 'check-public-content.mjs'))
    expect(ignoredResult.status, `${ignoredResult.stdout}\n${ignoredResult.stderr}`).toBe(0)
  })
})
