/**
 * Host half of the dsh-plan-grill bundle.
 *
 * The feature is a "plan before you touch anything" mode with three flavours
 * borrowed from the grillme toolkit:
 *
 *   A  grill-me         stateless questioning, no files written
 *   B  grill-with-docs  questioning + CONTEXT.md glossary + ADRs on the spot
 *   C  wayfinder        decision map for efforts too large for one session
 *
 * One selected mode arms one planning cycle for exactly one Session, from any
 * turn (not only the first message). While armed:
 *
 *   - a `plan-grill:policy` system-prompt section carries the grilling protocol
 *     (one question at a time, facts looked up instead of asked, decisions to
 *     the user, no execution before consensus, evidence-or-hypothesis rule);
 *   - the `plan_grill_review` tool presents the finished plan through the
 *     ordinary question channel, using the shipped plan-review intent so the
 *     Web client renders the full Markdown with Approve / Keep planning.
 *
 * The review gate checks path metadata and this Session's fs/observed records;
 * it does not re-read file contents. By default at least one listed path must
 * have a read record. Shell reads do not produce those records, so recovery
 * asks for one relevant read window instead of re-reading the whole file list.
 * Approval clears the mode — one use per click.
 *
 * State is process-local and per Session: no other plugin's state is touched,
 * nothing is written to the profile, and every registration uses a name this
 * package owns (`plan-grill:policy`, `plan_grill_review`, `/plan-grill/api`,
 * slot id `plan-grill.mode`).
 */

const ROUTE_PATH = '/plan-grill/api'
const SECTION_NAME = 'plan-grill:policy'
const TOOL_NAME = 'plan_grill_review'
const REVIEW_ID = 'plan-grill-review'
const APPROVE_LABEL = '批准，按计划执行'
const REVISE_LABEL = '继续盘问'
const MODE_IDS = ['grill-me', 'grill-with-docs', 'wayfinder']
const MAX_BODY_BYTES = 64 * 1024
const MAX_SESSIONS = 200
const MAX_OBSERVATIONS_PER_SESSION = 600

const DEFAULTS = {
  enforceReadEvidence: true,
  requireReadPass: true,
  minEvidence: 2,
  ttlMinutes: 480,
}

/* --------------------------------------------------------------- config */

function resolveOptions(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const unknown = Object.keys(raw).filter((key) => !Object.prototype.hasOwnProperty.call(DEFAULTS, key))
  if (unknown.length > 0) {
    throw new Error(`dsh-plan-grill: unknown config key(s) ${unknown.join(', ')} — accepted: ${Object.keys(DEFAULTS).join(', ')}`)
  }
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const int = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    const rounded = Math.trunc(value)
    if (rounded < min) return min
    if (rounded > max) return max
    return rounded
  }
  return {
    enforceReadEvidence: bool(raw.enforceReadEvidence, DEFAULTS.enforceReadEvidence),
    requireReadPass: bool(raw.requireReadPass, DEFAULTS.requireReadPass),
    minEvidence: int(raw.minEvidence, DEFAULTS.minEvidence, 0, 20),
    ttlMinutes: int(raw.ttlMinutes, DEFAULTS.ttlMinutes, 5, 24 * 60),
  }
}

/* ----------------------------------------------------------------- state */

/** sessionId -> { mode, at } */
const modes = new Map()
/** sessionId -> Map(normalized path -> { version, at }) */
const observations = new Map()

function sessionIdOf(agent) {
  try {
    const id = agent && agent.session ? agent.session.id : undefined
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

function trimSessions() {
  while (modes.size > MAX_SESSIONS) {
    const oldest = modes.keys().next().value
    if (oldest === undefined) break
    modes.delete(oldest)
  }
  while (observations.size > MAX_SESSIONS) {
    const oldest = observations.keys().next().value
    if (oldest === undefined) break
    observations.delete(oldest)
  }
}

/** The armed mode for a Session, expiry-checked. */
function activeMode(sessionId, options, now = Date.now()) {
  if (sessionId === undefined) return undefined
  const entry = modes.get(sessionId)
  if (entry === undefined) return undefined
  if (now - entry.at > options.ttlMinutes * 60 * 1000) {
    modes.delete(sessionId)
    return undefined
  }
  return entry.mode
}

function normalizePath(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

function rememberObservation(sessionId, keys, version) {
  if (sessionId === undefined || keys.length === 0) return
  let bucket = observations.get(sessionId)
  if (bucket === undefined) {
    bucket = new Map()
    observations.set(sessionId, bucket)
    trimSessions()
  }
  const stamp = Date.now()
  for (const key of keys) {
    bucket.delete(key)
    bucket.set(key, { version, at: stamp })
  }
  while (bucket.size > MAX_OBSERVATIONS_PER_SESSION) {
    const oldest = bucket.keys().next().value
    if (oldest === undefined) break
    bucket.delete(oldest)
  }
}

/** Best-effort lookup of a Session's read record for one path. */
function findObservation(sessionId, path) {
  const bucket = sessionId === undefined ? undefined : observations.get(sessionId)
  if (bucket === undefined) return undefined
  const wanted = normalizePath(path)
  if (wanted === '') return undefined
  let found = bucket.get(wanted)
  if (found !== undefined) return found
  for (const [key, value] of bucket) {
    if (key.endsWith('/' + wanted) || wanted.endsWith('/' + key)) return value
  }
  return undefined
}

/* --------------------------------------------------------------- policy */

const CORE_RULES = [
  '【计划·盘问模式已开启】先澄清目标、边界与验收标准，再交可执行的计划，用户批准后实现。',
  '1. 一次只问一个问题，用 ask_user_question 给 2–4 个具体选项，推荐项排第一并说明证据、理由及替代项的代价；答完再问。',
  '2. 事实自己查，决策问用户。沿决策依赖由父到子推进，未定分支先不展开；含糊回答要查明或问清。',
  '3. 只问会改变计划的问题，带文件/函数/输出证据，或明确触发条件与成功标准；禁止宽泛、重复或征求继续的问题。',
  '4. 批准前不写实现、不执行有副作用的命令；仅模式 B/C 可写规定的规划文档。',
].join('\n')

const EVIDENCE_RULES = [
  '证据与上下文：',
  '- 关键结论给文件:行号、命令输出或测试证据；待验证假设写置信度及证伪动作。修 bug 核对失败路径、调用方与共享状态，说明根因和影响范围。',
  '- 只查当前决策需要的函数、行段、配置与测试，限制搜索输出。复用已读且未变的内容，提交前不批量重读、不重复粘贴计划。',
  '- read_pass 列实际读过且计划依赖的路径；Host 只查元数据，不重读正文。read 可建立 fs/observed 记录，shell/ops_bash 不会。已有 shell 证据时，只需对一个核心文件用 read(offset, limit) 读相关片段建立记录，无需重读整批文件；其余命令证据保留在 evidence，评审会标明无记录的路径。',
].join('\n')

const CONFIRM_RULES = [
  '收口：共识后仅用 plan_grill_review 提交计划，不另用内置 /plan。plan 以 # 开头，至少 3 个二级标题，含现状/根因、证据、文件改动、验证、风险与回滚；evidence 至少 2 条 claim/proof，read_pass 填实际路径。批准后模式关闭并执行；继续盘问则带反馈修订，复用证据。',
].join('\n')

const MODE_RULES = {
  'grill-me': [
    '【模式 A · 无状态盘问】',
    '- 只盘问，不写任何文件（不建 CONTEXT.md、不写 ADR、不落任何工作区产物）。',
    '- 共识只存在于本轮对话里，最后用 plan_grill_review 交给用户批准。',
    '- 适合中小改动、一次性任务、只想在动手前把方案问透的场景。',
  ].join('\n'),
  'grill-with-docs': [
    '【模式 B · 盘问并留痕】',
    '- 边问边落盘，当场写，不攒到最后批量写（除文档外仍然只读）：',
    '  · 术语一落定就写进项目根的 CONTEXT.md 术语表：一行一个「**术语**：一句话定义，区别于易混词」。文件不存在时首次落地才创建。',
    '  · 只有同时满足三条才写 ADR（docs/adr/NNNN-<slug>.md）：难逆转、没有背景会让人惊讶、当时有真实替代方案与权衡。缺一条就跳过。',
    '- 只写文档，不写实现代码；实现仍然要等计划批准。',
  ].join('\n'),
  'wayfinder': [
    '【模式 C · 决策地图（wayfinder）】',
    '- 适用于大到一次会话装不下、通往目标的路还看不清的活。只规划，不实现。',
    '- 第一件事是命名 Destination（这张地图的终点：要交付的 spec / 要锁定的决策 / 要做的改动），再谈票据。',
    '- 地图：项目根 WAYFINDER.md，含 Destination / Notes / Decisions so far / Not yet specified / Out of scope。票据：wayfinder/<名字>.md，frontmatter 含 type（research/prototype/grilling/task）与 status（open/closed），正文只有一行 ## Question；阻塞写 blocked_by: [名字]。引用一律用名字，不用编号。',
    '- 铺图广度优先：先把整个空间铺开，再挑一条线深钻。现在说不清的决策放进 Not yet specified（战争迷雾），够清楚了再毕业成票据；目的地之外的直接判 Out of scope。',
    '- 一次只解一个票据；HITL 票据必须由真人回答，不能替他作答。',
    '- 本次收口时用 plan_grill_review 提交「地图 + 当前票据结论 + 下一步要执行的票据与顺序」，批准后本插件关闭，再开始执行。',
  ].join('\n'),
}

function policyText(mode) {
  const body = MODE_RULES[mode]
  if (body === undefined) return ''
  return [CORE_RULES, '', EVIDENCE_RULES, '', body, '', CONFIRM_RULES].join('\n')
}

/* ------------------------------------------------------------------ HTTP */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, arg) => {
      if (!settled) {
        settled = true
        fn(arg)
      }
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('request body too large')
        done(reject, error)
        try { req.destroy(error) } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => done(reject, error))
  })
}

/** Loopback is trusted; anything else must be same-origin with the served page. */
function sameOriginOk(req) {
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/* ----------------------------------------------------------------- audit */

function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function sessionCwd(ctx, exec) {
  const workingDirectory = safeGet(ctx, 'workingDirectory')
  try {
    if (workingDirectory && typeof workingDirectory.get === 'function' && exec.agent) {
      const cwd = workingDirectory.get(exec.agent.session)
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
    }
  } catch { /* fall through */ }
  return undefined
}

function versionKey(version) {
  if (version === undefined || version === null) return ''
  try {
    return JSON.stringify(version)
  } catch {
    return String(version)
  }
}

/** Check path metadata and reuse this Session's read records without reading contents. */
async function auditReadPass(ctx, exec, sessionId, paths) {
  const fs = safeGet(ctx, 'fs')
  const cwd = sessionCwd(ctx, exec)
  const rows = []
  for (const raw of paths) {
    const path = String(raw === undefined || raw === null ? '' : raw).trim()
    if (path === '') continue
    const row = { path, exists: false, observed: false, stale: false, kind: '' }
    let info
    try {
      if (fs && typeof fs.lstat === 'function') {
        info = await fs.lstat(path, cwd === undefined ? undefined : { cwd })
      }
    } catch {
      info = undefined
    }
    if (info !== undefined && info !== null) {
      row.exists = true
      row.kind = typeof info.type === 'string' ? info.type : ''
    }
    const record = findObservation(sessionId, path)
    if (record !== undefined) {
      row.observed = true
      if (info !== undefined && info !== null && versionKey(record.version) !== versionKey(info.version)) {
        row.stale = true
      }
    }
    rows.push(row)
  }
  const exists = rows.filter((row) => row.exists).length
  const observed = rows.filter((row) => row.observed).length
  return {
    rows,
    exists,
    observed,
    missing: rows.filter((row) => !row.exists).map((row) => row.path),
    unread: rows.filter((row) => !row.observed).map((row) => row.path),
    stale: rows.filter((row) => row.stale).map((row) => row.path),
  }
}

function buildReviewDetail(plan, audit, evidence, assumptions) {
  const lines = [plan.trim(), '', '---', '', '## 插件核对（提交时自动执行）']
  lines.push(`- 读取证据：${audit.rows.length} 个路径`)
  lines.push(`- 文件存在：${audit.exists}/${audit.rows.length}`)
  lines.push(`- 本会话确有读取记录：${audit.observed}/${audit.rows.length}`)
  if (audit.unread.length > 0) lines.push(`- 无读取记录（仅做了存在性检查）：${audit.unread.join('、')}`)
  if (audit.stale.length > 0) lines.push(`- 读取之后又被修改（证据可能已过期）：${audit.stale.join('、')}`)
  lines.push(`- 证据条目：${evidence.length} 条`)
  lines.push(`- 待验证假设：${assumptions.length} 条${assumptions.length === 0 ? '' : '（均已附验证动作）'}`)
  if (evidence.length > 0) {
    lines.push('', '### 证据清单')
    for (const item of evidence) lines.push(`- ${item.claim} → ${item.proof}`)
  }
  if (assumptions.length > 0) {
    lines.push('', '### 待验证假设')
    for (const item of assumptions) {
      const confidence = typeof item.confidence === 'string' ? item.confidence : 'medium'
      lines.push(`- ${item.assumption}（置信度 ${confidence}）→ 验证：${item.verify}`)
    }
  }
  lines.push('', '> 插件核对路径、读取记录与版本，不验证结论真假；无读取记录的路径仅通过存在性检查，不代表 Host 确认读过。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ tool */

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validateReviewArgs(ctx, options, args) {
  const plan = textOf(args && args.plan)
  if (plan === '') throw new Error(`${TOOL_NAME}: plan 不能为空，需要完整 markdown 计划`)
  if (!/^#\s+\S/.test(plan)) throw new Error(`${TOOL_NAME}: plan 必须以一级标题（# 标题）开头`)
  const headings = plan.split('\n').filter((line) => /^##\s+\S/.test(line)).length
  if (headings < 3) {
    throw new Error(`${TOOL_NAME}: plan 至少要有 3 个二级标题，覆盖「现状与根因 / 证据 / 改动清单 / 验证 / 风险与回滚」（当前只有 ${headings} 个）`)
  }
  const evidenceRaw = Array.isArray(args && args.evidence) ? args.evidence : []
  const evidence = []
  for (const item of evidenceRaw) {
    const claim = textOf(item && item.claim)
    const proof = textOf(item && item.proof)
    if (claim === '' || proof === '') continue
    evidence.push({ claim, proof, kind: textOf(item && item.kind) || 'other' })
  }
  if (evidence.length < options.minEvidence) {
    throw new Error(`${TOOL_NAME}: evidence 至少 ${options.minEvidence} 条 claim/proof 完整对应的证据（当前 ${evidence.length} 条）—— 先去读代码/日志/配置，再写计划`)
  }
  const assumptionsRaw = Array.isArray(args && args.assumptions) ? args.assumptions : []
  const assumptions = []
  for (const item of assumptionsRaw) {
    const assumption = textOf(item && item.assumption)
    if (assumption === '') continue
    const verify = textOf(item && item.verify)
    if (verify === '') {
      throw new Error(`${TOOL_NAME}: 假设「${assumption}」没有验证动作。必须猜的地方要写清楚怎么证伪它（读哪个文件 / 跑什么命令 / 看什么输出）`)
    }
    const confidence = textOf(item && item.confidence)
    assumptions.push({
      assumption,
      verify,
      confidence: confidence === 'low' || confidence === 'high' ? confidence : 'medium',
    })
  }
  const readPass = []
  const seen = new Set()
  for (const value of Array.isArray(args && args.read_pass) ? args.read_pass : []) {
    const path = textOf(value)
    const key = normalizePath(path)
    if (path === '' || seen.has(key)) continue
    seen.add(key)
    readPass.push(path)
  }
  return { plan, evidence, assumptions, readPass }
}

function registerReviewTool(ctx, options) {
  ctx.tools.register({
    name: TOOL_NAME,
    description:
      '计划模式中提交共识计划供用户批准。复用证据，不批量重读；shell 无 fs/observed 时仅用 read(offset, limit) 补一个核心文件的相关片段。Host 核对路径、记录与版本。批准即关闭，修订则保留模式。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: {
          type: 'string',
          description: '完整 Markdown 计划：# 标题、至少 3 个二级标题，含根因、证据、文件改动、验证与回滚',
        },
        evidence: {
          type: 'array',
          description: '关键结论与对应证据',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              claim: { type: 'string' },
              proof: { type: 'string', description: '文件:行号、命令输出、日志或测试结果' },
              kind: { type: 'string', enum: ['file', 'command', 'log', 'doc', 'test', 'other'] },
            },
            required: ['claim', 'proof'],
          },
        },
        assumptions: {
          type: 'array',
          description: '待验证假设及证伪动作',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assumption: { type: 'string' },
              verify: { type: 'string', description: '证伪用的文件、命令与预期输出' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['assumption', 'verify'],
          },
        },
        read_pass: {
          type: 'array',
          description: '实际读过的相关路径；默认至少一个需有本会话 read 记录，其余标明仅检查存在',
          items: { type: 'string' },
        },
        root_cause: { type: 'string' },
      },
      required: ['plan', 'evidence', 'read_pass'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value && value.approved
          ? '计划已批准，计划模式已关闭。按计划开始执行，不要再重复盘问。'
          : '本次评审没有批准计划，计划模式仍然开启。',
      }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec.agent)
      const mode = activeMode(sessionId, options)
      if (mode === undefined) {
        throw new Error(`${TOOL_NAME} 只能在计划模式激活时使用：让用户在输入框左侧的「计划」里选一个模式，或直接正常回答`)
      }
      const input = validateReviewArgs(ctx, options, args)
      if (options.requireReadPass && input.readPass.length === 0) {
        throw new Error(`${TOOL_NAME}: read_pass 至少给 1 个实际读过的相关文件路径；优先用 read(offset, limit) 读取必要行段并复用记录`)
      }
      const audit = await auditReadPass(ctx, exec, sessionId, input.readPass)
      if (audit.missing.length > 0) {
        throw new Error(`${TOOL_NAME}: 这些路径不存在，不能当作读取证据：${audit.missing.join('、')}。用 read 重新核对路径后重提`)
      }
      if (audit.stale.length > 0) {
        throw new Error(`${TOOL_NAME}: 这些文件在你读取之后被修改过，证据可能已过期：${audit.stale.join('、')}。仅用 read(offset, limit) 更新这些文件的相关行段，未变的文件无需重读`)
      }
      if (options.enforceReadEvidence && audit.rows.length > 0 && audit.observed === 0) {
        const sample = audit.rows.find((row) => row.kind === 'file') || audit.rows[0]
        throw new Error(`${TOOL_NAME}: 本会话没有这些文件的读取记录；shell/ops_bash 不产生 fs/observed，这不等于未取得命令证据。只需选择一个核心文件（如 ${sample.path}），用 read(offset, limit) 读取相关片段后重提；无需将全部 read_pass 整文件重读。其余路径会标明仅检查存在性`)
      }
      const interaction = safeGet(ctx, 'userQuestions')
      if (interaction === undefined || typeof interaction.ask !== 'function') {
        throw new Error('当前部署没有可用的提问通道，无法发起计划评审')
      }
      const detail = buildReviewDetail(input.plan, audit, input.evidence, input.assumptions)
      let answer
      try {
        answer = await interaction.ask({
          questions: [{
            id: REVIEW_ID,
            header: '计划评审',
            question: '按这份计划执行吗？',
            detail,
            options: [
              { label: APPROVE_LABEL, description: '关闭计划模式，从下一步开始按计划执行。' },
              { label: REVISE_LABEL, description: '留在计划模式，把意见带回给模型继续盘问。' },
            ],
            intent: { kind: 'plan-review', approve: APPROVE_LABEL },
          }],
          agent: exec.agent,
          signal: exec.signal,
        })
      } catch (cause) {
        if (cause && cause.code === 'ASK_CANCELLED') {
          if (typeof exec.concludeTurn === 'function') exec.concludeTurn()
          return { approved: false }
        }
        throw cause
      }
      const items = Array.isArray(answer && answer.answers)
        ? answer.answers.filter((entry) => entry && entry.id === REVIEW_ID)
        : []
      const item = items.length === 1 ? items[0] : undefined
      const selected = item && Array.isArray(item.selected) ? item.selected : []
      if (selected.length === 1 && selected[0] === APPROVE_LABEL && item.custom === undefined) {
        modes.delete(sessionId)
        return { approved: true }
      }
      const feedback = textOf(item && item.custom)
      throw new Error(
        feedback === ''
          ? '用户选择继续盘问：修改计划后再次提交，或继续提出下一个关键问题。'
          : `用户选择继续盘问，反馈：${feedback}`,
      )
    },
    presentCall: (args) => {
      const plan = textOf(args && args.plan)
      const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(plan)
      return {
        card: 'generic',
        title: heading ? heading[1] : '计划评审',
        kind: 'other',
        content: [{ type: 'text', text: plan }],
      }
    },
    presentResult: (_args, view) => ({
      card: 'generic',
      title: '计划评审',
      content: view && view.content ? view.content : [],
    }),
  })
}

/* ------------------------------------------------------------------- HTTP */

function handleHttp(ctx, options, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST only' })
    return
  }
  if (!sameOriginOk(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
    return
  }
  readBody(req)
    .then((raw) => {
      let body
      try {
        body = raw.trim() === '' ? {} : JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad request body' })
        return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { ok: false, error: 'bad request body' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const op = body.op === undefined ? 'state' : body.op
      if (op === 'state') {
        const mode = activeMode(sessionId, options)
        sendJson(res, 200, { ok: true, mode: mode === undefined ? null : mode, modes: MODE_IDS, ttlMinutes: options.ttlMinutes })
        return
      }
      if (op === 'set') {
        const mode = typeof body.mode === 'string' ? body.mode : ''
        if (!MODE_IDS.includes(mode)) {
          sendJson(res, 400, { ok: false, error: `unknown mode: ${mode}` })
          return
        }
        modes.set(sessionId, { mode, at: Date.now() })
        trimSessions()
        sendJson(res, 200, { ok: true, mode })
        return
      }
      if (op === 'clear') {
        modes.delete(sessionId)
        sendJson(res, 200, { ok: true, mode: null })
        return
      }
      sendJson(res, 400, { ok: false, error: `unknown op: ${String(op)}` })
    })
    .catch((error) => {
      sendJson(res, 400, { ok: false, error: error && error.message ? error.message : 'bad request' })
    })
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, config) {
  const options = resolveOptions(config)

  ctx.inject(['systemPrompt'], (promptCtx) => {
    const order = (() => {
      try {
        const base = promptCtx.systemPrompt.getSectionOrder('PLAN_POLICY')
        return typeof base === 'number' && Number.isFinite(base) ? base + 5 : 505
      } catch {
        return 505
      }
    })()
    try {
      promptCtx.systemPrompt.section({
        name: SECTION_NAME,
        order,
        text: (context) => {
          const sessionId = sessionIdOf(context && context.agent)
          const mode = activeMode(sessionId, options)
          return mode === undefined ? '' : policyText(mode)
        },
      })
    } catch (error) {
      ctx.logger.warn('dsh-plan-grill: prompt section registration failed: %o', error)
    }
  })

  ctx.on('fs/observed', (target, observation, actor) => {
    try {
      const sessionId = sessionIdOf(actor && actor.agent)
      if (sessionId === undefined) return
      const keys = []
      const add = (value) => {
        const key = typeof value === 'string' ? normalizePath(value) : ''
        if (key !== '' && !keys.includes(key)) keys.push(key)
      }
      if (target && typeof target === 'object') {
        add(target.displayPath)
        add(target.hostPath)
        add(target.path)
        const fs = safeGet(ctx, 'fs')
        if (fs && typeof fs.processPath === 'function') {
          try { add(fs.processPath(target)) } catch { /* path shape differs */ }
        }
      }
      rememberObservation(sessionId, keys, observation && observation.kind === 'present' ? observation.version : undefined)
    } catch { /* observation bookkeeping must never break a read */ }
  })

  ctx.inject(['tools'], (toolCtx) => {
    try {
      registerReviewTool(toolCtx, options)
    } catch (error) {
      ctx.logger.error('dsh-plan-grill: tool registration failed: %o', error)
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => handleHttp(ctx, options, req, res),
      }))
    } catch (error) {
      ctx.logger.warn('dsh-plan-grill: HTTP route registration failed: %o', error)
    }
  })
}
