import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

interface Manifest {
  name?: unknown
  version?: unknown
  private?: unknown
  repository?: { type?: unknown; url?: unknown }
  exports?: Record<string, unknown>
  files?: unknown
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
  dsh?: {
    bundle?: { patch?: unknown }
    client?: { inject?: unknown; platform?: unknown; immediately?: unknown }
  }
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as Manifest
}

describe('combined Profile Bundle declaration', () => {
  it('declares one Bundle with root and browser Connection exports', async () => {
    const value = await manifest()
    expect(value.name).toBe('dsh-loopback-spoof')
    expect(value.private).toBe(true)
    expect(value.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/fangzhengjin/dsh-loopback-spoof.git',
    })
    expect(value.exports?.['.']).toMatchObject({
      types: './lib/index.d.ts',
      default: './lib/index.js',
    })
    expect(value.exports?.['./webserver']).toBeUndefined()
    expect(value.exports?.['./client']).toBe('./lib/client.js')
    expect(value.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(value.dsh?.client).toEqual({ inject: [], platform: 'web', immediately: true })
    expect(value.files).toEqual(['lib', 'cordis.patch.yml', 'LICENSE', 'README.md'])
    expect(value.scripts?.['check:public']).toBe('node scripts/check-public-content.mjs')
    for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
      expect(value.scripts?.[lifecycle]).toBeUndefined()
    }
    expect(value.scripts?.['test:tarball']).toBe('pnpm run build:package && node tests/tarball.integration.mjs')
    expect(value.scripts?.check).toBe('pnpm run check:quick && node tests/tarball.integration.mjs')
    expect(value.scripts?.['pack:check']).toBe('pnpm run build:package && pnpm pack --dry-run')
    const ignoreLines = (await readFile(resolve(root, '.gitignore'), 'utf8')).split(/\r?\n/)
    expect(ignoreLines).not.toContain('lib/')
  })

  it('requires the active official Connection without installing another Harness graph', async () => {
    const value = await manifest()
    expect(value.version).toBe('0.2.0')
    expect(value.dependencies).toBeUndefined()
    expect(value.peerDependencies).toEqual({
      '@deepseek-ai/dsh-client-connection': '0.1.3-alpha.2',
    })
  })

  it('configures the official WebServer and replaces only the shipped Connection', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch.match(/- id: webserver\r?\n  config:/g)).toHaveLength(1)
    expect(patch).toContain("host: !!js ctx.webStartup.host ?? '0.0.0.0'")
    expect(patch).toContain('compression: gzip')
    expect(patch.match(/- id: connection\r?\n  name: '@deepseek-ai\/dsh-client-connection'\r?\n  disabled: true/g)).toHaveLength(1)
    expect(patch).not.toContain('dsh-loopback-spoof/webserver')
    expect(patch.match(/name: dsh-loopback-spoof(?:\r?\n|$)/g)).toHaveLength(1)
    expect(patch).toContain('trustedHosts: !!js "[\'dsh.hale-halibut.ts.net\', ...ctx.webRuntime.trustedHosts]"')
  })

  it('keeps the root module free of a JavaScript default export', async () => {
    const source = await readFile(resolve(root, 'src', 'index.ts'), 'utf8')
    expect(source).toContain('applyOfficial')
    expect(source).toContain('return rejection === 401 ? undefined : rejection')
    expect(source).not.toMatch(/export\s+default/)
  })
})
