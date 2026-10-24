import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'

let sequence = 0
function host(config = {}) {
  const state = { id: `mock-session-${++sequence}`, files: new Map([['src/app.js', 1], ['src/other.js', 1]]), events: {}, reviews: [] }
  const services = {
    fs: { async lstat(file) { return state.files.has(file) ? { type: 'file', version: state.files.get(file) } : undefined } },
    workingDirectory: { get: () => '/workspace' },
    userQuestions: { async ask(request) {
      state.reviews.push(request)
      if (state.cancel) throw Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
      return { answers: [{ id: 'plan-grill-review', selected: [state.revise ? '继续盘问' : '批准，按计划执行'], ...(state.revise ? { custom: '请补充回滚步骤' } : {}) }] }
    } },
  }
  const ctx = {
    inject: (_names, callback) => callback(ctx),
    get: name => services[name],
    on: (name, callback) => { state.events[name] = callback },
    effect: callback => callback(),
    logger: { warn: (...args) => { throw new Error(String(args[0])) }, error: (...args) => { throw new Error(String(args[0])) } },
    systemPrompt: { getSectionOrder: () => 500, section: value => { state.section = value } },
    tools: { register: value => { state.tool = value } },
    webServer: { register: value => { state.route = value; return () => {} } },
  }
  apply(ctx, config)
  state.exec = { agent: { session: { id: state.id } }, concludeTurn() { state.concluded = true } }
  state.observe = (file, version = 1) => state.events['fs/observed']({ path: file }, { kind: 'present', version }, { agent: state.exec.agent })
  state.http = (body, options = {}) => new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
    req.method = options.method || 'POST'
    req.headers = { host: 'dsh.example', ...options.headers }
    req.socket = { remoteAddress: options.remote || '127.0.0.1' }
    let status
    const res = { writeHead(value) { status = value }, end(value) { resolve({ status, body: JSON.parse(value) }) } }
    try { state.route.handler(req, res) } catch (error) { reject(error) }
  })
  state.select = (mode = 'grill-me') => state.http({ op: 'set', sessionId: state.id, mode })
  state.mode = async () => (await state.http({ op: 'state', sessionId: state.id })).body.mode
  state.review = overrides => state.tool.execute({
    plan: '# 修复计划\n## 现状与根因\n已核对。\n## 改动清单\n修改入口。\n## 验证与回滚\n运行自测。',
    evidence: [{ claim: '入口存在', proof: 'src/app.js:1' }, { claim: '已核对调用方', proof: 'src/other.js:1' }],
    read_pass: ['src/app.js'], ...overrides,
  }, state.exec)
  return state
}

test('unknown configuration keys fail before registration', () => {
  assert.throws(() => host({ unknown: true }), /unknown config key/)
})

test('numeric configuration is clamped to the documented TTL limits', async () => {
  for (const [ttlMinutes, expected] of [[1, 5], [2000, 1440], ['invalid', 480]]) {
    const h = host({ ttlMinutes })
    assert.equal((await h.http({ sessionId: h.id })).body.ttlMinutes, expected)
  }
})

test('registered tool uses an object schema and rejects an inactive session', async () => {
  const h = host()
  assert.equal(h.tool.parameters.type, 'object')
  assert.equal(h.route.path, '/plan-grill/api')
  await assert.rejects(h.review(), /只能在计划模式激活时使用/)
})

test('each supported mode injects a policy and stays within its session', async () => {
  const h = host()
  for (const mode of ['grill-me', 'grill-with-docs', 'wayfinder']) {
    assert.equal((await h.select(mode)).status, 200)
    assert.equal(await h.mode(), mode)
    assert.match(h.section.text({ agent: h.exec.agent }), /一次只问一个问题/)
  }
  assert.equal(h.section.text({ agent: { session: { id: 'unrelated-session' } } }), '')
  await h.http({ op: 'clear', sessionId: h.id })
  assert.equal(await h.mode(), null)
})

test('HTTP rejects invalid methods, JSON, sessions, modes and operations', async () => {
  const h = host()
  assert.equal((await h.http({}, { method: 'GET' })).status, 405)
  for (const body of ['{', [], null, {}, { sessionId: h.id, op: 'unknown' }, { sessionId: h.id, op: 'set', mode: 'unknown' }]) {
    assert.equal((await h.http(body)).status, 400)
  }
})

test('non-loopback connections require a matching origin host', async () => {
  const h = host()
  assert.equal((await h.http({ sessionId: h.id }, { remote: '192.0.2.1' })).status, 403)
  assert.equal((await h.http({ sessionId: h.id }, { remote: '192.0.2.1', headers: { origin: 'https://dsh.example' } })).status, 200)
})

test('approval displays evidence and clears only this plugin policy', async () => {
  const h = host()
  await h.select()
  h.observe('src/app.js')
  assert.deepEqual(await h.review(), { approved: true })
  assert.match(h.reviews[0].questions[0].detail, /证据清单/)
  assert.equal(h.reviews[0].questions[0].intent.kind, 'plan-review')
  assert.equal(await h.mode(), null)
  assert.equal(h.section.text({ agent: h.exec.agent }), '')
})

test('requesting revision preserves the mode and returns feedback', async () => {
  const h = host()
  await h.select()
  h.observe('src/app.js')
  h.revise = true
  await assert.rejects(h.review(), /请补充回滚步骤/)
  assert.equal(await h.mode(), 'grill-me')
})

test('cancelled review concludes the turn and does not approve', async () => {
  const h = host()
  await h.select()
  h.observe('src/app.js')
  h.cancel = true
  assert.deepEqual(await h.review(), { approved: false })
  assert.equal(h.concluded, true)
  assert.equal(await h.mode(), 'grill-me')
})

test('plan format, evidence count and assumption verification are validated', async () => {
  const h = host()
  await h.select()
  await assert.rejects(h.review({ plan: 'No heading' }), /一级标题/)
  await assert.rejects(h.review({ plan: '# 标题\n## 只有一节' }), /3 个二级标题/)
  await assert.rejects(h.review({ evidence: [] }), /evidence 至少 2 条/)
  await assert.rejects(h.review({ assumptions: [{ assumption: '需要验证' }] }), /没有验证动作/)
})

test('default configuration rejects an empty read list', async () => {
  const h = host()
  await h.select()
  await assert.rejects(h.review({ read_pass: [] }), /read_pass 至少给 1 个/)
})

test('missing paths cannot be used as evidence', async () => {
  const h = host()
  await h.select()
  await assert.rejects(h.review({ read_pass: ['src/missing.js'] }), /这些路径不存在/)
  assert.equal(h.reviews.length, 0)
})

test('default configuration rejects a list with no observed reads', async () => {
  const h = host()
  await h.select()
  await assert.rejects(h.review(), /本会话没有这些文件的读取记录/)
})

test('changed versions are rejected before user review', async () => {
  const h = host()
  await h.select()
  h.observe('src/app.js', 1)
  h.files.set('src/app.js', 2)
  await assert.rejects(h.review(), /被修改过/)
  assert.equal(h.reviews.length, 0)
})

test('documented limitation: a partly observed list can pass', async () => {
  const h = host()
  await h.select()
  h.observe('src/app.js')
  assert.deepEqual(await h.review({ read_pass: ['src/app.js', 'src/other.js'] }), { approved: true })
  assert.match(h.reviews[0].questions[0].detail, /无读取记录（仅做了存在性检查）：src\/other.js/)
})

test('discussion configuration can explicitly allow no file evidence', async () => {
  const h = host({ requireReadPass: false, enforceReadEvidence: false, minEvidence: 0 })
  await h.select()
  assert.deepEqual(await h.review({ read_pass: [], evidence: [] }), { approved: true })
})
