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
 * The review call is also the evidence gate: before the user is asked, the Host
 * re-reads every path the model claims it read (`read_pass`), checks the path
 * exists, checks this Session actually read it (fs/observed), and checks the
 * file did not change after that read. A plan built on guesses therefore cannot
 * reach the approval step. Approval clears the mode — one use per click.
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
  '【计划·盘问模式已开启】你现在的任务不是马上动手，而是把方案问到自己能直接执行的精度，再交一份有证据的计划让用户批准。',
  '',
  '盘问纪律（硬性）：',
  '1. 一次只问一个问题。用 ask_user_question 提问，给 2–4 个具体选项，标出你的推荐项与理由；用户答完再问下一个。一次抛出多个问题视为失职。',
  '2. 能自己查的事实绝不问用户：读文件、grep、看配置、看日志、看调用方、跑只读命令。只有「决策」归用户。',
  '3. 按决策树推进：先钉父决策（目标、边界、验收标准），再展开它下面的子决策；依赖未定的分支先不问。',
  '4. 每个问题都必须能改变计划；问了也不影响方案的，是废话，别问。',
  '5. 问题必须具体到能验收：要么点名具体的文件/函数/现象（带行号、命令输出或日志片段），要么锁死一个可验收的边界（触发条件、错误表现、成功标准）。两样都做不到，说明你还没读够——回去读，别发问。',
  '6. 这些问题一律禁止，问出来就是浪费用户时间：「你能详细说说吗」「还有别的吗」「你希望我怎么改」「需要我继续吗」「你的使用场景是什么」「要不要我先看看代码再说」。',
  '7. 提问模板：「<在哪个环节/哪段代码>，你要 <A> 还是 <B>？我推荐 A，因为 <证据>；选 B 的代价是 <代价>。」选项 2–4 个，推荐项排第一并写清理由。',
  '8. 用户说「大概/应该/可能/看情况」的地方就是歧义点：要么问清楚，要么自己查清楚。',
  '9. 达成共识前只读不写：不改文件、不写代码、不跑有副作用的命令。',
  '',
  '发问前自查四件事，有一条不满足就重写这个提问：① 真的只有这一个问题？② 带推荐项和理由？③ 用户答完真能改变计划？④ 有具体证据，或锁死了可验收的边界？',
].join('\n')

const EVIDENCE_RULES = [
  '证据纪律（计划里的每句话都要能落地）：',
  '- 结论必须带证据：文件路径:行号、函数名、命令输出、日志片段、配置项、测试结果。没有证据的断言不许写进计划。',
  '- 必须猜的地方，写成「待验证假设」：每条配一个能证伪它的验证动作（读哪个文件、跑什么命令、看什么输出），并标出置信度。猜完不验证＝不合格。',
  '- 修 bug 先定位根因，禁止贴症状补丁：读失败路径 → 读触发条件 → 读所有调用方与共享状态 → 搜同类写法是否同病。计划里要回答两件事：为什么这是根因而非症状；改完之后问题会不会挪到别处（列出受影响的调用方、配置、数据）。',
  '- 提交前做「预确认读取」：把计划要改的每个文件/函数、它的调用方、相关配置与测试实际读一遍，把路径填进 plan_grill_review 的 read_pass。插件会核对这些路径是否存在、本会话是否真的读过、读过之后文件有没有再变；对不上就先补充读取或修计划，别硬提交。',
].join('\n')

const CONFIRM_RULES = [
  '收口（只有这一条路）：',
  '- 达成共识后调用 plan_grill_review 提交计划：plan（markdown，以 # 开头，至少 3 个二级标题）、evidence（至少 2 条，claim 与 proof 一一对应）、read_pass（实际读过的文件路径）。',
  '- 计划至少覆盖：现状与根因、证据、改动清单（精确到文件）、验证方式、风险与回滚。',
  '- 用户点「批准」：计划模式自动关闭，从下一步开始按计划执行，不要再重复盘问。',
  '- 用户点「继续盘问」：留在计划模式，带着用户的反馈继续问，改完再提交。',
  '- 本模式独立于内置 /plan；两者同时开启时，以本插件协议为准，计划只用 plan_grill_review 提交。',
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

/**
 * Re-read every path the model claims it read: existence, this Session's own
 * read record, and whether the file changed after that read.
 */
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
  lines.push('', '> 核对在本轮向用户提问之前完成：路径不存在、本会话没读过、或读后又变了的内容，都不会被当作证据。')
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
  const readPass = (Array.isArray(args && args.read_pass) ? args.read_pass : [])
    .map((value) => textOf(value))
    .filter((value) => value !== '')
  return { plan, evidence, assumptions, readPass }
}

function registerReviewTool(ctx, options) {
  ctx.tools.register({
    name: TOOL_NAME,
    description:
      '提交计划给用户批准（仅在「计划·盘问」模式激活时可用）。调用前必须：已与用户达成共识；已实际读过计划涉及的每个文件/函数及其调用方，并把路径写进 read_pass；evidence 覆盖计划的关键结论（claim+proof 一一对应），必须猜的地方放进 assumptions 且每条都带验证动作。Host 会在向你提问之前重新核对 read_pass：路径是否存在、本会话是否真的读过、读过之后文件有没有再变；对不上会直接拒绝提交。用户批准后计划模式自动关闭并从下一步开始执行；用户选择继续盘问时，反馈会回到你这里继续问。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: {
          type: 'string',
          description: '完整计划 markdown，以 # 开头，至少 3 个二级标题，覆盖现状与根因 / 证据 / 改动清单 / 验证 / 风险与回滚',
        },
        evidence: {
          type: 'array',
          description: '计划所依赖的关键证据，claim 与 proof 一一对应',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              claim: { type: 'string', description: '结论或断言' },
              proof: { type: 'string', description: '证据：文件:行号、函数名、命令输出、日志片段、配置项或测试结果' },
              kind: { type: 'string', enum: ['file', 'command', 'log', 'doc', 'test', 'other'] },
            },
            required: ['claim', 'proof'],
          },
        },
        assumptions: {
          type: 'array',
          description: '必须靠猜的地方：每条都要有能证伪它的验证动作',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assumption: { type: 'string' },
              verify: { type: 'string', description: '怎么证伪它：读哪个文件、跑什么命令、看什么输出' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['assumption', 'verify'],
          },
        },
        read_pass: {
          type: 'array',
          description: '提交前实际读过的文件路径（相对会话工作目录或绝对路径），Host 会逐个核对',
          items: { type: 'string' },
        },
        root_cause: { type: 'string', description: '一句话根因（不是症状）' },
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
        throw new Error(`${TOOL_NAME}: 计划模式要求先读代码再提交。read_pass 至少给 1 个你实际读过的文件路径（用 read / grep 看过），否则计划只能算猜测`)
      }
      const audit = await auditReadPass(ctx, exec, sessionId, input.readPass)
      if (audit.missing.length > 0) {
        throw new Error(`${TOOL_NAME}: 这些路径不存在，不能当作读取证据：${audit.missing.join('、')}。用 read 重新核对路径后重提`)
      }
      if (audit.stale.length > 0) {
        throw new Error(`${TOOL_NAME}: 这些文件在你读取之后被修改过，证据可能已过期：${audit.stale.join('、')}。重新读一遍再提交`)
      }
      if (options.enforceReadEvidence && audit.rows.length > 0 && audit.observed === 0) {
        throw new Error(`${TOOL_NAME}: 本会话没有这些文件的读取记录（read_pass 只是抄了路径）。用 read 工具实际读取：${audit.rows.map((row) => row.path).join('、')}`)
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
