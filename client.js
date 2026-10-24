/**
 * Client half of the dsh-plan-grill bundle.
 *
 * Two seats:
 *   conversation.input.left  — the "计划" control in the composer tool row.
 *   shell.overlay            — the mode menu, positioned above that control.
 *
 * A module-scoped store carries the open flag, the anchor rectangle, the
 * Session id and the armed mode between the two seats, so the menu can sit in
 * the root overlay (never clipped by the composer card) without reading another
 * plugin's DOM.
 *
 * Hovering a mode fills an inline description block immediately — that is the
 * "when should I use this" answer the menu exists for. Selecting one arms it for
 * this Session; the Host keeps the authority and clears it after the plan is
 * approved.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-plan-grill',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const NS = 'plan-grill'
    const API = '/plan-grill/api'

    const ZH = {
      button: '计划',
      menuTitle: '计划模式 · 先盘问，后执行',
      menuHint: '悬停看每个模式适合什么情况；选中后它只对这一轮任务生效。',
      hoverHint: '把鼠标移到模式上，这里会说明什么情况下该用它。',
      whenLabel: '什么时候用',
      fitLabel: '适合',
      outLabel: '产出',
      current: '当前',
      choose: '选用',
      close: '关闭菜单',
      clear: '关闭计划模式（恢复默认）',
      footer: '任意一轮都能开启；计划被批准或点关闭后自动恢复默认。',
      busy: '切换中…',
      error: '切换失败',
      activeHint: '计划模式已开启：先问清楚，再出计划，批准后才动手。',
    }
    const EN = {
      button: 'Plan',
      menuTitle: 'Plan mode · grill first, execute later',
      menuHint: 'Hover a mode to see when it fits; picking one arms it for this task only.',
      hoverHint: 'Hover a mode to read when it fits.',
      whenLabel: 'When to use it',
      fitLabel: 'Best for',
      outLabel: 'Produces',
      current: 'active',
      choose: 'Use',
      close: 'Close menu',
      clear: 'Turn plan mode off (back to default)',
      footer: 'Works in any turn; resets after the plan is approved or you turn it off.',
      busy: 'Switching…',
      error: 'Switch failed',
      activeHint: 'Plan mode is on: clarify first, plan next, act only after approval.',
    }

    const MODES = [
      {
        id: 'grill-me',
        key: 'A',
        zh: {
          name: '盘问',
          tag: '无状态 · 问透就动手',
          when: '方案大概对，但里面还有没拍板的决策；或者要修一个 bug，想先把自己的假设问清楚。只盘问、不写任何文件，共识只留在这次对话里。',
          fit: '小到中等改动、一次性任务、临时排查',
          out: '对话里的共识 + 一份待批准的计划',
        },
        en: {
          name: 'Grill',
          tag: 'stateless · ask, then act',
          when: 'The plan looks roughly right but decisions are still implicit, or you want a bug’s assumptions challenged first. Pure conversation, no files written.',
          fit: 'small to medium changes, one-off tasks, quick triage',
          out: 'shared understanding + a plan to approve',
        },
      },
      {
        id: 'grill-with-docs',
        key: 'B',
        zh: {
          name: '盘问 + 文档',
          tag: '留痕 · 术语与 ADR',
          when: '改动刚开始、术语和边界还没定，希望盘问结论留下来给下次复用：术语进 CONTEXT.md 术语表，真正不可逆的决策进 ADR。只写文档，不写实现。',
          fit: '长期项目、多人协作、需要留下决策记录',
          out: 'CONTEXT.md 术语表 + ADR + 待批准的计划',
        },
        en: {
          name: 'Grill + docs',
          tag: 'keep a record · glossary and ADRs',
          when: 'Changes just started and the domain language is still fuzzy: sharpen terms into CONTEXT.md and record only irreversible decisions as ADRs. Docs only, no implementation.',
          fit: 'long-lived projects, shared codebases, decision history',
          out: 'CONTEXT.md glossary + ADRs + a plan to approve',
        },
      },
      {
        id: 'wayfinder',
        key: 'C',
        zh: {
          name: '决策地图',
          tag: '大 effort · 先画地图',
          when: '项目大到一次会话装不下、通往目标的还看不清。先把决策绘制成地图，一次只解一个决策票据，把迷雾变成能走下去的路；只规划，不实现。',
          fit: '大重构、跨模块改造、方向还模糊的大工程',
          out: 'WAYFINDER.md 地图 + 票据 + 下一步执行计划',
        },
        en: {
          name: 'Wayfinder',
          tag: 'big effort · chart the decisions',
          when: 'The effort is too large for one session and the route to the destination is still foggy. Chart the decisions, solve one ticket at a time, plan only.',
          fit: 'large refactors, cross-module rewrites, fuzzy big efforts',
          out: 'WAYFINDER.md map + tickets + the next execution plan',
        },
      },
    ]

    function makeTranslator(ctx) {
      const fallback = (key) => (Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key)
      try {
        ctx.locale.register(NS, 'zh', ZH)
        ctx.locale.register(NS, 'en', EN)
        const translate = ctx.locale.bind(NS)
        return (key) => {
          try {
            const value = translate(key)
            return typeof value === 'string' && value !== '' ? value : fallback(key)
          } catch {
            return fallback(key)
          }
        }
      } catch {
        return fallback
      }
    }

    /* ------------------------------------------------------------- store */

    const store = {
      open: false,
      anchor: null,
      sessionId: null,
      mode: null,
      busy: false,
      error: null,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      emit() {
        for (const listener of Array.from(this.listeners)) {
          try { listener() } catch { /* one dead component must not stop the rest */ }
        }
      },
    }

    function snapshot() {
      return {
        open: store.open,
        anchor: store.anchor,
        sessionId: store.sessionId,
        mode: store.mode,
        busy: store.busy,
        error: store.error,
      }
    }

    function useStoreState() {
      const [state, setState] = useState(snapshot)
      useEffect(() => store.subscribe(() => setState(snapshot())), [])
      return state
    }

    function modeById(id) {
      for (const mode of MODES) {
        if (mode.id === id) return mode
      }
      return undefined
    }

    async function callApi(body) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data === null || data.ok !== true) {
        const reason = data && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return data
    }

    let attached = null
    function attach(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        if (attached !== null) {
          attached = null
          store.sessionId = null
          store.mode = null
          store.emit()
        }
        return
      }
      if (attached === sessionId) return
      attached = sessionId
      store.sessionId = sessionId
      store.mode = null
      store.error = null
      store.emit()
      callApi({ op: 'state', sessionId })
        .then((data) => {
          if (attached !== sessionId) return
          store.mode = typeof data.mode === 'string' ? data.mode : null
          store.emit()
        })
        .catch(() => { /* the Host may not be reachable yet; the menu still works on select */ })
    }

    async function choose(modeId) {
      const sessionId = store.sessionId
      if (sessionId === null || store.busy) return
      store.busy = true
      store.error = null
      store.emit()
      try {
        const data = await callApi({ op: 'set', sessionId, mode: modeId })
        store.mode = typeof data.mode === 'string' ? data.mode : modeId
        store.open = false
      } catch (error) {
        store.error = error && error.message ? error.message : 'failed'
      } finally {
        store.busy = false
        store.emit()
      }
    }

    async function clearMode() {
      const sessionId = store.sessionId
      if (sessionId === null || store.busy) return
      store.busy = true
      store.error = null
      store.emit()
      try {
        await callApi({ op: 'clear', sessionId })
        store.mode = null
        store.open = false
      } catch (error) {
        store.error = error && error.message ? error.message : 'failed'
      } finally {
        store.busy = false
        store.emit()
      }
    }

    /* --------------------------------------------------------------- view */

    const glyph = (size) => ({
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block', flex: 'none' },
    })

    function CompassIcon(props) {
      return h('svg', glyph(props.size || 14), [
        h('circle', { key: 'c', cx: 12, cy: 12, r: 8.5 }),
        h('path', { key: 'p', d: 'M15.2 8.8l-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9Z' }),
      ])
    }

    function createComponents(t, lang) {
      function copyOf(mode) {
        return lang === 'en' ? mode.en : mode.zh
      }

      function Button(props) {
        const sessionId = props && props.sessionId
        const state = useStoreState()
        const ref = useRef(null)
        useEffect(() => { attach(sessionId) }, [sessionId])

        const active = modeById(state.mode)
        // A fixed-width label: switching modes must not reflow the composer row.
        const label = active ? `${t('button')}·${active.key}` : t('button')
        const style = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 9px',
          borderRadius: 999,
          border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
          background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '24px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          opacity: state.busy ? 0.6 : 1,
        }

        const open = () => {
          const node = ref.current
          if (!node) return
          const rect = node.getBoundingClientRect()
          store.anchor = { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width }
          store.open = !store.open
          store.error = null
          store.emit()
        }

        return h(
          'button',
          {
            ref,
            type: 'button',
            style,
            title: active ? `${copyOf(active).name} · ${t('activeHint')}` : t('menuHint'),
            'aria-haspopup': 'dialog',
            'aria-expanded': state.open ? 'true' : 'false',
            onClick: open,
          },
          h(CompassIcon, { size: 13 }),
          h('span', null, label),
          h('span', { style: { fontSize: 9, opacity: 0.7, transform: state.open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' } }, '▾'),
        )
      }

      function Menu() {
        const state = useStoreState()
        const [hover, setHover] = useState(null)
        const panelRef = useRef(null)

        useEffect(() => {
          if (!state.open) return undefined
          const onKey = (event) => {
            if (event.key === 'Escape') {
              store.open = false
              store.emit()
            }
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [state.open])

        if (!state.open) return null

        const viewport = typeof window === 'undefined' ? 1200 : window.innerWidth
        const width = Math.max(280, Math.min(460, viewport - 16))
        const anchor = state.anchor || { top: 400, left: 40, bottom: 420, right: 120, width: 80 }
        const left = Math.max(8, Math.min(anchor.left, viewport - width - 8))
        const bottom = Math.max(8, (typeof window === 'undefined' ? 800 : window.innerHeight) - anchor.top + 10)

        const hovered = modeById(hover) || modeById(state.mode) || MODES[0]
        const hoverCopy = copyOf(hovered)

        const rows = MODES.map((mode) => {
          const copy = copyOf(mode)
          const selected = state.mode === mode.id
          const isHover = hover === mode.id
          return h(
            'button',
            {
              key: mode.id,
              type: 'button',
              onMouseEnter: () => setHover(mode.id),
              onFocus: () => setHover(mode.id),
              onClick: () => { choose(mode.id) },
              title: copy.when,
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: 9,
                width: '100%',
                minHeight: 44,
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 10,
                border: `1px solid ${selected ? 'var(--dsw-alias-brand-primary)' : isHover ? 'var(--dsw-alias-border-l2)' : 'transparent'}`,
                background: isHover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
                fontSize: 12.5,
                cursor: state.busy ? 'progress' : 'pointer',
              },
            },
            h(
              'span',
              {
                style: {
                  flex: 'none',
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
                  color: selected ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
                  fontSize: 11,
                  fontWeight: 700,
                },
              },
              mode.key,
            ),
            h(
              'span',
              { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
              h(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { fontWeight: 600 } }, copy.name),
                selected
                  ? h(
                    'span',
                    {
                      style: {
                        fontSize: 10,
                        lineHeight: '15px',
                        padding: '0 5px',
                        borderRadius: 999,
                        color: 'var(--dsw-alias-brand-primary)',
                        border: '1px solid var(--dsw-alias-brand-primary)',
                      },
                    },
                    t('current'),
                  )
                  : null,
              ),
              h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, copy.tag),
            ),
          )
        })

        const detail = h(
          'div',
          {
            style: {
              margin: '4px 2px 0',
              padding: '9px 10px',
              borderRadius: 10,
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              lineHeight: 1.6,
              height: 178,
              boxSizing: 'border-box',
              overflowY: 'auto',
            },
          },
          h('div', { style: { fontWeight: 600, marginBottom: 3 } }, `${t('whenLabel')} · ${hoverCopy.name}`),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, hoverCopy.when),
          h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', { style: { opacity: 0.8 } }, `${t('fitLabel')}：`), hoverCopy.fit),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } },
            h('span', { style: { opacity: 0.8 } }, `${t('outLabel')}：`), hoverCopy.out),
        )

        const footer = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
          h(
            'button',
            {
              type: 'button',
              disabled: state.mode === null,
              onClick: () => { clearMode() },
              'aria-hidden': state.mode === null ? 'true' : 'false',
              style: {
                alignSelf: 'flex-start',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                borderRadius: 8,
                padding: '4px 9px',
                font: 'inherit',
                fontSize: 11.5,
                cursor: state.mode === null ? 'default' : 'pointer',
                visibility: state.mode === null ? 'hidden' : 'visible',
              },
            },
            t('clear'),
          ),
          state.error === null ? null : h(
            'div',
            { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11.5 } },
            `${t('error')}：${state.error}`,
          ),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', opacity: 0.85 } }, t('footer')),
        )

        const panel = h(
          'div',
          {
            ref: panelRef,
            role: 'dialog',
            'aria-label': t('menuTitle'),
            style: {
              position: 'fixed',
              left,
              bottom,
              width,
              maxHeight: '72vh',
              overflowY: 'auto',
              padding: 10,
              borderRadius: 14,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-overlay)',
              boxShadow: '0 14px 44px rgba(0, 0, 0, 0.28)',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 12.5,
              zIndex: 61,
              pointerEvents: 'auto',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 2px 8px' } },
            h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('menuTitle')),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              {
                type: 'button',
                onClick: () => { store.open = false; store.emit() },
                title: t('close'),
                style: {
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: 'pointer',
                  fontSize: 15,
                  lineHeight: '16px',
                  padding: '0 2px',
                },
              },
              '×',
            ),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, rows),
          detail,
          footer,
        )

        return h(
          'div',
          { style: { position: 'fixed', inset: 0, zIndex: 60 } },
          h('div', {
            style: { position: 'absolute', inset: 0, background: 'transparent' },
            onClick: () => { store.open = false; store.emit() },
          }),
          panel,
        )
      }

      return { Button, Menu }
    }

    /* -------------------------------------------------------------- entry */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeTranslator(ctx)
        const lang = (() => {
          try {
            const snapshot = typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : undefined
            const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
            if (active.toLowerCase().startsWith('en')) return 'en'
          } catch { /* default to Chinese */ }
          return 'zh'
        })()
        const { Button, Menu } = createComponents(t, lang)
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'plan-grill.mode',
          order: 20,
        }, Button))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'plan-grill.menu',
          order: 70,
        }, Menu))
      },
    }
  },
})
