/**
 * 流程工坊 · 浏览器半。
 *
 * 本文件是手写的 ModuleLoader 包，不需要构建：
 *  - 侧栏入口注册到 root 作用域的 `sidebar.panellist`；
 *  - 面板本体注册到 layout 的 `main` keyed slot，key 与侧栏 id 相同；
 *  - 面板内容是一个 iframe，指向宿主半自己服务的编辑页（同一 origin）。
 *
 * 这样重活（泳道看板、拖拽、SSE）全在宿主服务的静态页里跑，
 * 浏览器半只负责把它挂进 DSH 的导航与版式，升级页面不用重装插件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workflow-studio',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');

    const NS = 'workflow-studio';
    const PANEL_ID = 'workflow-studio';
    const BASE = '/workflow-studio';

    const zh = {
      panel: '流程工坊',
      frameTitle: '流程工坊 · 事件工作流编辑页',
      unavailable: '编辑页没有响应，检查宿主端是否已启用流程工坊。',
      retry: '重新载入',
    };
    const en = {
      panel: 'Workflow Studio',
      frameTitle: 'Workflow Studio — event workflow editor',
      unavailable: 'The editor page did not respond. Check that the workflow-studio host half is enabled.',
      retry: 'Reload',
    };

    const FRAME_STYLE = {
      display: 'block',
      width: '100%',
      height: '100%',
      minHeight: '0',
      border: '0',
      background: '#0a0e15',
      colorScheme: 'dark',
    };

    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      flex: '1 1 auto',
      minHeight: '0',
      height: '100%',
    };

    function StudioIcon() {
      return React.createElement(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('rect', { x: 1.6, y: 1.9, width: 4.2, height: 3.2, rx: 1 }),
        React.createElement('rect', { x: 10.2, y: 1.9, width: 4.2, height: 3.2, rx: 1 }),
        React.createElement('rect', { x: 5.9, y: 10.9, width: 4.2, height: 3.2, rx: 1 }),
        React.createElement('path', { d: 'M5.8 3.5h4.4M3.7 5.1v3.1a1.3 1.3 0 0 0 1.3 1.3h1.6M12.3 5.1v3.1a1.3 1.3 0 0 1-1.3 1.3H9.4' }),
      );
    }

    function StudioFrame(props) {
      const t = props?.t ?? ((key) => key);
      const src = `${window.location.origin}${BASE}/`;
      const [failed, setFailed] = React.useState(false);
      const [nonce, setNonce] = React.useState(0);

      const reload = React.useCallback(() => {
        setFailed(false);
        setNonce((value) => value + 1);
      }, []);

      if (failed) {
        return React.createElement(
          'div',
          {
            style: {
              ...PANEL_STYLE,
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              padding: '32px',
              textAlign: 'center',
              color: '#c8d2e0',
              font: '13px/1.6 system-ui, sans-serif',
            },
          },
          React.createElement('p', { style: { margin: 0 } }, t('unavailable')),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: reload,
              style: {
                padding: '6px 14px',
                borderRadius: '8px',
                border: '1px solid #35507a',
                background: '#16233a',
                color: '#dce6f5',
                cursor: 'pointer',
              },
            },
            t('retry'),
          ),
        );
      }

      return React.createElement(
        'div',
        { style: PANEL_STYLE },
        React.createElement('iframe', {
          key: nonce,
          src,
          title: t('frameTitle'),
          style: FRAME_STYLE,
          allow: 'clipboard-write',
          onError: () => setFailed(true),
        }),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workflow-studio:dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            label: () => t('panel'),
            locale: NS,
          },
          StudioIcon,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ t }),
          },
          StudioFrame,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    exports.NS = NS;
    exports.PANEL_ID = PANEL_ID;
    return module.exports;
  },
});