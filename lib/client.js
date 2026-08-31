// dsh-peak-block 浏览器半身：设置面板里的一个独立标签页。
// host 侧（lib/index.js）完成真正的拦截与路由切换。本半身提供配置入口的 UI 骨架：
// enabled、targetProvider、officialProviders、peakWindow 与预留的「转 API 端口」。
// 当前仅为界面演示，字段值不写回 host；正式生效需后续接线 host 的配置读写通道。
// 真正的「被拦截且未配置目标」提示，由 host 侧抛出的失败文案随界面失败信息呈现，本半身不重复注入，避免易碎的 UI 依赖。

window.__ModuleLoader__.load({
  id: 'dsh-peak-block',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')

    const plugin = {
      name: 'dsh-peak-block',
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get && ctx.get('slots')
        if (!slots) return

        const DOC = typeof document !== 'undefined' ? document : null
        let styleTag = null

        function ensureStyle() {
          if (!DOC || styleTag) return
          const css = [
            '.dshpb-section{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}',
            '.dshpb-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
            '.dshpb-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}',
            '.dshpb-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}',
            '.dshpb-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:14px}',
            '.dshpb-field{display:flex;flex-direction:column;gap:6px}',
            '.dshpb-fieldLabel{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
            '.dshpb-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
            '.dshpb-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
            '.dshpb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
            '.dshpb-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
            'select.dshpb-input{max-width:320px;cursor:pointer}',
            '.dshpb-rowInput{max-width:320px}',
            '.dshpb-actions{display:flex;justify-content:flex-end;gap:8px}',
            '.dshpb-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:18px;font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
            '.dshpb-buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
            '.dshpb-buttonPrimary:hover{background:var(--dsw-alias-button-primary-hover)}',
            '.dshpb-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;line-height:22px}',
          ].join('')
          const tag = DOC.createElement('style')
          tag.textContent = css
          DOC.head.appendChild(tag)
          styleTag = tag
        }

        const TARGET_TYPES = {
          none: '未配置（高峰阻止并提示）',
          proxy: '第三方中转路由',
          port: '转 API 端口',
        }

        function Section() {
          const [enabled, setEnabled] = React.useState(true)
          const [targetType, setTargetType] = React.useState('none')
          const [proxyRoute, setProxyRoute] = React.useState('opencode-go')
          const [apiPort, setApiPort] = React.useState('127.0.0.1:8080')
          const [official, setOfficial] = React.useState('deepseek-official')
          const [savedHint, setSavedHint] = React.useState('')

          function onSave() {
            setSavedHint('已保存到界面状态，尚未写回 host，正式生效需接线后端。')
          }

          return React.createElement(
            'div',
            { className: 'dshpb-section', role: 'region', 'aria-label': '梁文峰拦截设置' },
            React.createElement('h2', { className: 'dshpb-title' }, '梁文峰时间拦截'),
            React.createElement('p', { className: 'dshpb-intro' }, '在 DeepSeek 官方高峰时段拦截官方 provider 请求，可切换到第三方中转或本机转 API 端口。'),
            React.createElement('p', { className: 'dshpb-notice' }, '当前为配置界面骨架，改动不写回 host，正式生效需后续接线。'),
            React.createElement(
              'div',
              { className: 'dshpb-card' },
              React.createElement(
                'label',
                { className: 'dshpb-switch' },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: enabled,
                  onChange: function (e) { setEnabled(e.target.checked) },
                }),
                '启用拦截'
              ),
              React.createElement(
                'div',
                { className: 'dshpb-field' },
                React.createElement('label', { className: 'dshpb-fieldLabel', htmlFor: 'dshpb-target' }, '拦截目标 targetProvider'),
                React.createElement(
                  'select',
                  {
                    id: 'dshpb-target',
                    className: 'dshpb-input',
                    value: targetType,
                    onChange: function (e) { setTargetType(e.target.value) },
                  },
                  React.createElement('option', { value: 'none' }, TARGET_TYPES.none),
                  React.createElement('option', { value: 'proxy' }, TARGET_TYPES.proxy),
                  React.createElement('option', { value: 'port' }, TARGET_TYPES.port)
                ),
                targetType === 'proxy' &&
                  React.createElement('input', {
                    className: 'dshpb-input dshpb-rowInput',
                    value: proxyRoute,
                    placeholder: '如 opencode-go',
                    'aria-label': '第三方中转路由',
                    onChange: function (e) { setProxyRoute(e.target.value) },
                  }),
                targetType === 'port' &&
                  React.createElement(
                    'div',
                    { className: 'dshpb-field' },
                    React.createElement('label', { className: 'dshpb-fieldLabel', htmlFor: 'dshpb-port' }, '转 API 端口'),
                    React.createElement('input', {
                      id: 'dshpb-port',
                      className: 'dshpb-input dshpb-rowInput',
                      value: apiPort,
                      placeholder: '127.0.0.1:8080',
                      onChange: function (e) { setApiPort(e.target.value) },
                    }),
                    React.createElement('p', { className: 'dshpb-hint' }, '预留：把被拦请求转发到本机 OpenAI 兼容端口。')
                  )
              ),
              React.createElement(
                'div',
                { className: 'dshpb-field' },
                React.createElement('label', { className: 'dshpb-fieldLabel', htmlFor: 'dshpb-official' }, '官方判定 provider 名单（逗号分隔）'),
                React.createElement('input', {
                  id: 'dshpb-official',
                  className: 'dshpb-input dshpb-rowInput',
                  value: official,
                  onChange: function (e) { setOfficial(e.target.value) },
                })
              ),
              React.createElement(
                'div',
                { className: 'dshpb-field' },
                React.createElement('span', { className: 'dshpb-fieldLabel' }, '高峰时段'),
                React.createElement('p', { className: 'dshpb-hint' }, '北京时间工作日 09:00–12:00、14:00–18:00，周末全天谷价。')
              ),
              React.createElement(
                'div',
                { className: 'dshpb-actions' },
                React.createElement(
                  'button',
                  { type: 'button', className: 'dshpb-button dshpb-buttonPrimary', onClick: onSave },
                  '保存（演示）'
                )
              ),
              savedHint !== '' &&
                React.createElement('p', { className: 'dshpb-hint' }, savedHint)
            )
          )
        }

        slots.inject('settings.section', function () {
          return slots.register(
            {
              name: 'settings.section',
              id: 'peak-block',
              order: 90,
              label: '梁文峰拦截',
            },
            () => React.createElement(Section)
          )
        })

        ctx.effect(function () {
          ensureStyle()
          return function () {
            if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
            styleTag = null
          }
        })
      },
    }

    exports.default = plugin
    exports.name = plugin.name
    exports.inject = plugin.inject
    exports.apply = plugin.apply

    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    return module.exports
  },
})
