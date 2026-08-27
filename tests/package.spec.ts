import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

interface Manifest {
  name?: unknown
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
  it('declares one Bundle with root Connection, browser, and WebServer subpath exports', async () => {
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
    expect(value.exports?.['./webserver']).toMatchObject({
      types: './lib/webserver.d.ts',
      default: './lib/webserver.js',
    })
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

  it('pins one DSH release family without bundling another Cordis or WebServer runtime', async () => {
    const value = await manifest()
    expect(value.dependencies?.['@deepseek-ai/dsh-client-connection']).toBe('0.1.1-rc.2')
    expect(Object.keys(value.dependencies ?? {})).toEqual(['@deepseek-ai/dsh-client-connection'])
    expect(value.peerDependencies?.['@deepseek-ai/cordis']).toBe('4.0.1')
    expect(value.peerDependencies?.['@deepseek-ai/dsh-host-webserver']).toBe('0.1.1-rc.2')
  })

  it('disables both shipped providers and inserts exactly one compatible replacement for each', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch.match(/- id: webserver\r?\n  disabled: true/g)).toHaveLength(1)
    expect(patch.match(/- id: connection\r?\n  name: '@deepseek-ai\/dsh-client-connection'\r?\n  disabled: true/g)).toHaveLength(1)
    expect(patch.match(/name: dsh-loopback-spoof\/webserver/g)).toHaveLength(1)
    expect(patch.match(/name: dsh-loopback-spoof(?:\r?\n|$)/g)).toHaveLength(1)
    expect(patch).toContain("host: !!js ctx.webStartup.host ?? '0.0.0.0'")
    expect(patch).toContain('port: !!js ctx.webStartup.port ?? 3080')
    expect(patch).toContain('trustedHosts: !!js ctx.webRuntime.trustedHosts')
  })

  it('keeps the root module free of a JavaScript default export', async () => {
    const source = await readFile(resolve(root, 'src', 'index.ts'), 'utf8')
    expect(source).toContain("export { Config, apply, inject, name } from '@deepseek-ai/dsh-client-connection'")
    expect(source).not.toMatch(/export\s+default/)
  })
})
