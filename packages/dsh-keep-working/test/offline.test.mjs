import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createConnectivityProbe,
  hasExternalInterface,
  usesExplicitProxy,
} from '../src/offline.mjs'

const interfacesOf = (entries) => () => entries

test('无外部网卡时判定离线', () => {
  assert.equal(hasExternalInterface(interfacesOf({})), false)
  assert.equal(hasExternalInterface(interfacesOf({ lo: [{ internal: true, family: 'IPv4' }] })), false)
  assert.equal(
    hasExternalInterface(interfacesOf({ eth0: [{ internal: false, family: 'IPv4' }] })),
    true,
  )
})

test('读不到网卡信息时放行,不误判离线', () => {
  assert.equal(
    hasExternalInterface(() => {
      throw new Error('boom')
    }),
    true,
  )
})

test('显式代理存在时不依赖本地 DNS', () => {
  assert.equal(usesExplicitProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890' }), true)
  assert.equal(usesExplicitProxy({ https_proxy: 'http://127.0.0.1:7890' }), true)
  assert.equal(usesExplicitProxy({ HTTPS_PROXY: '   ' }), false)
  assert.equal(usesExplicitProxy({}), false)
})

test('任一探测主机可解析即在线', async () => {
  const probe = createConnectivityProbe({
    interfaces: interfacesOf({ eth0: [{ internal: false }] }),
    env: {},
    hosts: ['a.invalid', 'b.invalid'],
    lookup: async (host) => {
      if (host === 'b.invalid') return { address: '127.0.0.1' }
      throw new Error('ENOTFOUND')
    },
  })
  assert.equal(await probe(), true)
})

test('全部探测主机不可解析即离线', async () => {
  const probe = createConnectivityProbe({
    interfaces: interfacesOf({ eth0: [{ internal: false }] }),
    env: {},
    hosts: ['a.invalid', 'b.invalid'],
    lookup: async () => {
      throw new Error('ENOTFOUND')
    },
  })
  assert.equal(await probe(), false)
})

test('探测失败不 reject,一律折算为在线或离线', async () => {
  const probe = createConnectivityProbe({
    interfaces: interfacesOf({ eth0: [{ internal: false }] }),
    env: {},
    hosts: ['a.invalid'],
    lookup: () => Promise.reject(new Error('boom')),
  })
  assert.equal(await probe(), false)
})

test('无外部网卡时短路,不触发 DNS', async () => {
  let called = false
  const probe = createConnectivityProbe({
    interfaces: interfacesOf({ lo: [{ internal: true }] }),
    env: {},
    hosts: ['a.invalid'],
    lookup: async () => {
      called = true
      return { address: '127.0.0.1' }
    },
  })
  assert.equal(await probe(), false)
  assert.equal(called, false)
})
