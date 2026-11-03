// 网页AI答题助手 —— 后台 Service Worker（Manifest V3）
// 接收内容脚本的 API 请求，用 fetch 发起（host_permissions 允许跨域），流式回传。
'use strict';

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'waqa-api') return;

  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => {
    try { ctrl.abort(); } catch (e) {}
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start') return;
    const { url, headers, body, stream } = msg;
    if (!url) {
      port.postMessage({ type: 'error', message: '缺少请求地址' });
      return;
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers || {},
        body: body,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch (e) {}
        port.postMessage({ type: 'error', message: 'HTTP ' + res.status + (detail ? '：' + detail : '') });
        return;
      }

      if (!stream) {
        const text = await res.text();
        port.postMessage({ type: 'raw', text: text });
        port.postMessage({ type: 'done' });
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) {
            port.postMessage({ type: 'raw', text: decoder.decode(value, { stream: true }) });
          }
        }
        port.postMessage({ type: 'done' });
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      port.postMessage({ type: 'error', message: (e && e.message) || String(e) });
    }
  });
});
