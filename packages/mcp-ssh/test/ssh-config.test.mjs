// BDD: ssh-config 解析与 host 安全校验(不依赖网络;fake HOME 环境变量重定向)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const realHome = homedir()

function withFakeHome(setup) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-shell-ssh-'))
  const sshDir = join(dir, '.ssh')
  mkdirSync(sshDir)
  setup(sshDir)
  process.env.AGENT_SSH_CONFIG = join(sshDir, 'config')
  process.env.AGENT_SSH_KNOWN_HOSTS = join(sshDir, 'known_hosts')
  return dir
}

function restoreHome(dir) {
  delete process.env.AGENT_SSH_CONFIG
  delete process.env.AGENT_SSH_KNOWN_HOSTS
}

test('解析 config:多别名/跳过 Host */无 Hostname 块/known_hosts 补充', async () => {
  const dir = withFakeHome((ssh) => {
    writeFileSync(join(ssh, 'config'), [
      'Host web1 web2',
      '  HostName 10.0.0.1',
      '  User deploy',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_ed25519',
      '',
      'Host broken',
      '  User nobody',
      '',
      'Host *',
      '  Compression yes',
      '',
      '# @password: s3cret',
      'Host db1',
      '  HostName db.internal',
      '  User root',
    ].join('\n'))
    writeFileSync(join(ssh, 'known_hosts'), [
      '10.9.9.9 ssh-ed25519 AAAA',
      '|1|hashed=|hash= ssh-ed25519 AAAA',
      'web1,10.0.0.1 ssh-ed25519 AAAA',
    ].join('\n'))
  })
  try {
    const { discoverHosts } = await import('../src/ssh-config.mjs')
    const hosts = await discoverHosts()
    const byAlias = Object.fromEntries(hosts.map((host) => [host.alias, host]))

    const web1 = byAlias['web1']
    assert.equal(web1.hostname, '10.0.0.1')
    assert.equal(web1.user, 'deploy')
    assert.equal(web1.port, 2222)
    assert.deepEqual(web1.aliases, ['web1', 'web2'])
    assert.equal(web1.source, 'ssh_config')

    // 无 Hostname 的块:不收录(broken 不可达)
    assert.equal(byAlias['broken'], undefined)
    // 通配块 Host * 不是主机
    assert.equal(byAlias['*'], undefined)

    // @password 只暴露布尔
    const db1 = byAlias['db1']
    assert.equal(db1.passwordAuth, true)
    assert.equal(JSON.stringify(db1).includes('s3cret'), false)

    // known_hosts 补充:web1 已在 config 不重复;10.9.9.9 收录;hashed 跳过
    assert.equal(byAlias['10.9.9.9'].source, 'known_hosts')
    assert.equal(hosts.filter((host) => host.alias === 'web1').length, 1)
  } finally {
    restoreHome(dir)
  }
})

test('Include 递归展开', async () => {
  const dir = withFakeHome((ssh) => {
    writeFileSync(join(ssh, 'config'), 'Include extra_*.conf\n')
    writeFileSync(join(ssh, 'extra_work.conf'), 'Host jump1\n  HostName jump.internal\n')
  })
  try {
    const { discoverHosts } = await import('../src/ssh-config.mjs')
    const hosts = await discoverHosts()
    assert.equal(hosts.some((host) => host.alias === 'jump1' && host.hostname === 'jump.internal'), true)
  } finally {
    restoreHome(dir)
  }
})

test('host 别名白名单:拒选项注入', async () => {
  const { assertSafeHostAlias } = await import('../src/ssh.mjs')
  assert.throws(() => assertSafeHostAlias('-oProxyCommand=calc'), /非法 host/)
  assert.throws(() => assertSafeHostAlias(''), /非空/)
  assert.throws(() => assertSafeHostAlias('a b'), /非法 host/)
  assert.doesNotThrow(() => assertSafeHostAlias('web1'))
  assert.doesNotThrow(() => assertSafeHostAlias('deploy@10.0.0.1'))
})

test('scp localPath 防第二远端 + ~/.ssh 写保护', async () => {
  const { assertLocalPath, assertNotSshDirectory } = await import('../src/ssh.mjs')
  assert.throws(() => assertLocalPath('evil:/path'), /远端写法/)
  assert.throws(() => assertLocalPath('scp://evil/x'), /远端写法/)
  assert.doesNotThrow(() => assertLocalPath('C:\\Users\\tmp\\file.txt'))
  assert.doesNotThrow(() => assertLocalPath('/tmp/file.txt'))
  assert.throws(() => assertNotSshDirectory(join(realHome, '.ssh', 'config')), /信任边界/)
  assert.throws(() => assertNotSshDirectory('~/.ssh/id_new'), /信任边界/)
  assert.doesNotThrow(() => assertNotSshDirectory(join(realHome, 'work', 'a.txt')))
})
