// 网页AI答题助手 —— Chrome/Edge 扩展内容脚本（Manifest V3）
// 与原用户脚本同逻辑；GM_* 已替换为 chrome.* API。
(function () {
  'use strict';

  /* ============================================================
   * 常量与默认配置
   * ============================================================ */

  const STORE_KEY = 'webAiQuizAssistant.config.v1';
  const TAG = '[AI答题助手]';
  const SHOW_ELEMENT = 1;

  const DEFAULT_CONFIG = {
    apiBase: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    timeout: 120000,
    systemPrompt:
      '你是一个网页答题助手。用户会给你一道或多道题目，请只给出答案，不要解释、不要复述题目。' +
      '选择题给出选项字母（如 A，多选用 ABD）；判断题给出“正确”或“错误”；' +
      '填空题/简答题直接给出答案文本。',
    customHeaders: '',
    stream: true,
    selector: '',
    batch: false,
    autoFill: true,
  };

  const IDS = {
    fab: 'waqa-fab',
    panel: 'waqa-panel',
    results: 'waqa-results',
    status: 'waqa-status',
  };

  const COLORS = {
    primary: '#4f7cff',
    primaryDark: '#3a63e0',
    success: '#1fa85a',
    danger: '#e5484d',
    muted: '#8a8f99',
    border: '#e3e6ee',
    bg: '#ffffff',
    bgSoft: '#f6f7fb',
  };

  /* ============================================================
   * 工具函数
   * ============================================================ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function log() {
    try { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }
  function logErr() {
    try { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  function normalizeBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function parseCustomHeaders(text) {
    const out = {};
    String(text || '').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
      if (m && m[1] && m[2]) out[m[1]] = m[2];
    });
    return out;
  }

  function extractLetters(text) {
    const s = String(text || '').toUpperCase();
    const letters = [];
    for (const ch of s) {
      if (ch >= 'A' && ch <= 'Z') {
        if (!letters.includes(ch)) letters.push(ch);
      }
    }
    return letters;
  }

  function isOwnUI(node) {
    if (!node) return false;
    return !!node.closest('#' + IDS.panel) || node.id === IDS.fab;
  }

  /* ============================================================
   * 配置读写（chrome.storage 持久化；运行期内存缓存，保持同步读）
   * ============================================================ */

  let CURRENT_CONFIG = { ...DEFAULT_CONFIG };

  function loadConfig() {
    return { ...CURRENT_CONFIG };
  }

  function saveConfig(cfg) {
    CURRENT_CONFIG = { ...CURRENT_CONFIG, ...cfg };
    try {
      chrome.storage.local.set({ [STORE_KEY]: CURRENT_CONFIG });
    } catch (e) { logErr('保存配置失败', e); }
  }

  /* ============================================================
   * 大模型 API 客户端（OpenAI 兼容 /chat/completions）
   * ============================================================ */

  function chatCompletion(opts) {
    return new Promise((resolve, reject) => {
      const url = normalizeBase(opts.apiBase) + '/chat/completions';
      const headers = {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: 'Bearer ' + opts.apiKey } : {}),
        ...(opts.headers || {}),
      };
      const payload = {
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature,
        stream: !!opts.stream,
      };

      let port;
      try {
        port = chrome.runtime.connect({ name: 'waqa-api' });
      } catch (e) {
        reject(new Error('无法连接扩展后台：' + e.message));
        return;
      }

      let buffer = '';
      let received = '';
      let settled = false;

      const finish = (err, text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (e) {}
        if (err) reject(err);
        else resolve(text || received);
      };

      const feed = (text) => {
        if (!opts.stream) return;
        buffer += text;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          block.split('\n').forEach((line) => {
            const t = line.trim();
            if (!t.startsWith('data:')) return;
            const data = t.slice(5).trim();
            if (data === '[DONE]') return;
            try {
              const obj = JSON.parse(data);
              const delta =
                (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content) || '';
              if (delta) {
                received += delta;
                if (opts.onDelta) opts.onDelta(delta);
              }
            } catch (e) { /* 忽略 */ }
          });
        }
      };

      const timer = setTimeout(() => finish(new Error('请求超时')), opts.timeout || 120000);

      port.onMessage.addListener((msg) => {
        if (msg.type === 'raw') {
          if (opts.stream) feed(msg.text);
          else received += msg.text;
        } else if (msg.type === 'done') {
          finish(null, received);
        } else if (msg.type === 'error') {
          finish(new Error(msg.message));
        }
      });

      port.postMessage({ type: 'start', url, headers, body: JSON.stringify(payload), stream: !!opts.stream });

      if (opts.signal) {
        if (opts.signal.aborted) finish(new Error('请求已中止'));
        else opts.signal.addEventListener('abort', () => finish(new Error('请求已中止')), { once: true });
      }
    });
  }

  /* ============================================================
   * 题干 / 选项解析
   * ============================================================ */

  function cleanSpace(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // 去掉题干里的题号、分值、题型噪声
  function cleanStem(raw) {
    return cleanSpace(raw)
      .replace(/^\s*(?:第\s*\d+\s*题\s*[、.．:：]?|\d+(?:[.．]\d+)*[.．、)）:：])\s*/, '')
      .replace(/[（(]\s*\d+\s*分\s*[)）]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*(单选题|多选题|判断题|不定项选择题|填空题|简答题)\s*$/, '')
      .trim();
  }

  // 从整段文本里解析出干净题干与选项
  function parseStemOptions(rawText) {
    const text = cleanSpace(rawText);
    if (!text) return { stem: '', options: [] };

    // 选项标记：A. / B、 / C） 等；前一个字符不能是英文字母/数字
    const re = /(^|[^A-Za-z0-9])([A-H])\s*[.、．)）]\s*/g;
    const marks = [];
    let m;
    while ((m = re.exec(text))) {
      marks.push({
        letter: m[2],
        start: m.index + (m[1] ? m[1].length : 0),
        contentStart: m.index + m[0].length,
      });
      if (marks.length > 30) break;
    }

    const aIdx = marks.findIndex((mk) => mk.letter === 'A');
    if (aIdx < 0) return { stem: cleanStem(text), options: [] };

    const seq = marks.slice(aIdx);
    let stem = text.slice(0, seq[0].start).trim();
    const options = seq
      .map((mk, i) => ({
        letter: mk.letter,
        text: text.slice(mk.contentStart, i + 1 < seq.length ? seq[i + 1].start : text.length).trim(),
      }))
      .filter((o) => o.text);

    if (options.length < 2) return { stem: cleanStem(text), options: [] };
    return { stem: cleanStem(stem), options };
  }

  /* ============================================================
   * 题目识别
   * ============================================================ */

  const COMMON_CONTAINERS = [
    '.div_question',
    '.question', '.que', '.q-item', '.topic', '.subject',
    '.paper-question', '.exam-question', '.test-question',
    '.quiz-question', '.single-choice', '.multiple-choice',
    '[class*="question"]', '[class*="topic"]',
  ];

  const STEM_PATTERN = /(^|\s|>)(第?\s*\d+\s*题?\s*[、.．:：)）]|[（(]\s*\d+\s*[)）])/;

  function textOf(node) {
    return (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function countStemMatches(text) {
    const m = text.match(new RegExp(STEM_PATTERN.source, 'g'));
    return m ? m.length : 0;
  }

  function scanDocuments() {
    const docs = [document];
    try {
      $$('iframe').forEach((f) => {
        try {
          const d = f.contentDocument;
          if (d && d !== document && d.body) docs.push(d);
        } catch (e) { /* 跨域 */ }
      });
    } catch (e) { /* ignore */ }
    return docs;
  }

  function findCommonInDoc(doc) {
    const roots = [];
    for (const sel of COMMON_CONTAINERS) {
      let found = [];
      try { found = Array.from(doc.querySelectorAll(sel)); } catch (e) { /* ignore */ }
      if (found.length) { roots.push(...found); break; }
    }
    return roots.filter((r) => !isOwnUI(r));
  }

  function findHeuristicInDoc(doc) {
    const candidates = [];
    let walker;
    try {
      walker = doc.createTreeWalker(doc.body, SHOW_ELEMENT);
    } catch (e) { return []; }
    let node;
    while ((node = walker.nextNode())) {
      if (isOwnUI(node)) continue;
      const t = textOf(node);
      if (!t || t.length < 4 || t.length > 300) continue;
      if (!STEM_PATTERN.test(t)) continue;
      candidates.push(node);
    }
    return candidates;
  }

  function innermost(candidates) {
    return candidates.filter((r) => {
      const p = r.parentElement;
      while (p && p !== document.body) {
        if (candidates.includes(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  function resolveContainer(stem) {
    let cur = stem;
    let guard = 0;
    while (cur && cur !== document.body && guard++ < 8) {
      if (isOwnUI(cur)) break;
      try {
        if (cur.querySelector && cur.querySelector('input, textarea, [class*="option"], label')) break;
      } catch (e) { break; }
      if (textOf(cur).length > 250) break;
      cur = cur.parentElement;
    }
    return cur || stem;
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    list.forEach((c) => {
      if (!c || seen.has(c)) return;
      seen.add(c);
      let contained = false;
      for (const o of out) {
        if (o !== c && o.contains && o.contains(c)) { contained = true; break; }
      }
      if (!contained) out.push(c);
    });
    return out;
  }

  function splitBigContainers(list) {
    const out = [];
    list.forEach((c) => {
      const t = textOf(c);
      if (t.length > 250 && countStemMatches(t) >= 2) {
        const subs = [];
        let walker;
        try { walker = c.ownerDocument.createTreeWalker(c, SHOW_ELEMENT); } catch (e) { out.push(c); return; }
        let node;
        while ((node = walker.nextNode())) {
          const st = textOf(node);
          if (st.length >= 6 && st.length <= 250 && STEM_PATTERN.test(st) && countStemMatches(st) === 1) subs.push(node);
        }
        const inn = innermost(subs);
        if (inn.length >= 2) out.push(...inn);
        else out.push(c);
      } else {
        out.push(c);
      }
    });
    return out;
  }

  function detectQuestionContainers(cfg) {
    const list = [];

    if (pickedContainers.length) list.push(...pickedContainers);

    if (cfg.selector) {
      scanDocuments().forEach((doc) => {
        try { list.push(...Array.from(doc.querySelectorAll(cfg.selector))); } catch (e) { /* ignore */ }
      });
    }

    const docs = scanDocuments();
    if (!list.length) docs.forEach((doc) => list.push(...findCommonInDoc(doc)));
    if (!list.length) {
      docs.forEach((doc) => {
        const inn = innermost(findHeuristicInDoc(doc));
        inn.forEach((stem) => list.push(resolveContainer(stem)));
      });
    }

    return dedupe(splitBigContainers(list));
  }

  function extractQuestion(container, index) {
    const rawText = textOf(container);
    const parsed = parseStemOptions(rawText);
    const radios = $$('input[type="radio"]', container);
    const checks = $$('input[type="checkbox"]', container);
    const texts = $$('input[type="text"], input:not([type]), textarea', container);

    let type = 'single';
    if (checks.length) type = 'multiple';
    else if (texts.length && !radios.length) type = 'fill';
    else if (/判\s*断|对错|正确与否|√|×/.test(parsed.stem)) type = 'judge';
    else if (radios.length) type = 'single';
    else if (parsed.options.length) type = 'single';
    else type = 'text';

    return {
      index,
      container,
      stem: parsed.stem || rawText,
      options: parsed.options,
      type,
      radios,
      checks,
      texts,
      answer: '',
      status: 'idle',
      el: null,
      manualLetters: [],
    };
  }

  function questionPrompt(q) {
    let s = q.type === 'judge' ? '（判断题）' : '';
    s += '第' + (q.index + 1) + '题：' + q.stem;
    if (q.options && q.options.length) {
      s += '\n选项：' + q.options.map((o) => o.letter + '. ' + o.text).join(' | ');
    }
    return s;
  }

  /* ============================================================
   * 答案填入
   * ============================================================ */

  function setInputValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    try {
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, value);
    } catch (e) {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickElement(node) {
    try { node.click(); } catch (e) {
      try { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (e2) {}
    }
  }

  function labelOf(input) {
    try {
      const lab = input.closest('label');
      if (lab) return textOf(lab);
    } catch (e) {}
    if (input.parentElement) return textOf(input.parentElement);
    return '';
  }

  // 把字母映射到对应的 input（优先按标签文本里的字母，其次按顺序）
  function inputForLetter(q, letter, inputs) {
    if (!inputs.length) return null;
    const up = String(letter).toUpperCase();
    for (const inp of inputs) {
      const t = labelOf(inp);
      const m = t.match(/(?:^|[\s(（])([A-H])\s*[.、．)）]/);
      if (m && m[1].toUpperCase() === up) return inp;
    }
    const idx = up.charCodeAt(0) - 65;
    return inputs[idx] || null;
  }

  function fillAnswer(q, answerText) {
    const answer = String(answerText || '').trim();
    if (!answer) return false;
    let ok = false;

    if (q.type === 'judge') {
      const lower = answer.toLowerCase();
      let target = null;
      if (['正确', '对', '是', 'true', '√', 't', 'y'].some((k) => lower.includes(k.toLowerCase()))) target = true;
      else if (['错误', '错', '否', 'false', '×', 'f', 'n'].some((k) => lower.includes(k.toLowerCase()))) target = false;
      const inputs = q.radios.length ? q.radios : q.checks;
      if (target !== null && inputs.length >= 2) {
        const labeled = inputs.map((inp) => ({ inp, text: labelOf(inp).toLowerCase() }));
        const pos = labeled.find((x) => /正确|对|是/.test(x.text));
        const neg = labeled.find((x) => /错误|错|否/.test(x.text));
        const use = target ? (pos ? pos.inp : inputs[0]) : (neg ? neg.inp : inputs[1]);
        clickElement(use);
        ok = true;
      }
    } else if (q.type === 'single' || q.type === 'multiple') {
      const letters = extractLetters(answer);
      const inputs = q.type === 'multiple' ? q.checks : q.radios;
      for (const letter of letters) {
        const inp = inputForLetter(q, letter, inputs);
        if (inp) { clickElement(inp); ok = true; }
      }
      (q.manualLetters || []).forEach((letter) => {
        const inp = inputForLetter(q, letter, inputs);
        if (inp) { clickElement(inp); ok = true; }
      });
    } else if (q.type === 'fill' || q.type === 'text') {
      if (q.texts.length) { setInputValue(q.texts[0], answer); ok = true; }
    }

    return ok;
  }

  /* ============================================================
   * UI —— 右下角小浮窗（无遮罩，不挡页面）
   * ============================================================ */

  let ui = null;
  let pickedContainers = [];
  let pickMode = false;
  let pickHandler = null;

  function buildStyle() {
    const css = `
#${IDS.fab}{position:fixed;right:22px;bottom:22px;z-index:2147483000;width:52px;height:52px;
  border-radius:50%;background:${COLORS.primary};color:#fff;font-size:15px;font-weight:700;
  display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 18px rgba(79,124,255,.45);
  border:none;user-select:none;transition:transform .15s,background .15s;}
#${IDS.fab}:hover{background:${COLORS.primaryDark};transform:scale(1.06);}
#${IDS.panel}{position:fixed;right:22px;bottom:86px;z-index:2147483002;width:min(400px,94vw);
  max-height:74vh;display:none;flex-direction:column;overflow:hidden;background:${COLORS.bg};
  border-radius:12px;box-shadow:0 14px 40px rgba(20,24,40,.22),0 0 0 1px rgba(0,0,0,.05);
  font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;
  color:#1c2030;font-size:13px;line-height:1.55;}
#${IDS.panel} *{box-sizing:border-box;}
#${IDS.panel}.waqa-min .waqa-body{display:none;}
.waqa-header{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
  border-bottom:1px solid #eef0f5;background:#fafbff;cursor:move;user-select:none;}
.waqa-title{font-weight:700;font-size:14px;}
.waqa-hbtns{display:flex;gap:2px;}
.waqa-hbtn{width:26px;height:26px;border:none;background:transparent;cursor:pointer;border-radius:6px;
  font-size:14px;color:${COLORS.muted};line-height:1;padding:0;}
.waqa-hbtn:hover{background:#eef0f5;color:#1c2030;}
.waqa-body{padding:10px 12px 12px;overflow:auto;}
.waqa-section{margin-bottom:12px;}
.waqa-section-title{font-weight:700;margin-bottom:6px;font-size:13px;}
.waqa-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.waqa-btn{padding:6px 11px;border:none;border-radius:7px;background:${COLORS.primary};color:#fff;cursor:pointer;
  font-size:12.5px;font-weight:600;transition:background .15s;}
.waqa-btn:hover{background:${COLORS.primaryDark};}
.waqa-btn.ghost{background:#fff;color:#3a3f4d;border:1px solid ${COLORS.border};}
.waqa-btn.ghost:hover{background:${COLORS.bgSoft};}
.waqa-btn.danger{background:${COLORS.danger};}
.waqa-btn:disabled{opacity:.5;cursor:not-allowed;}
.waqa-btn.on{background:#eef1ff;color:${COLORS.primary};border-color:${COLORS.primary};}
#${IDS.status}{margin-top:8px;font-size:12.5px;color:${COLORS.muted};white-space:pre-wrap;
  padding:6px 9px;border:1px solid ${COLORS.border};border-radius:7px;background:${COLORS.bgSoft};min-height:18px;}
#${IDS.status}.ok{border-color:${COLORS.success};color:${COLORS.success};background:#eefaf2;}
#${IDS.status}.warn{border-color:#d99000;color:#9a6a00;background:#fff7e6;}
#${IDS.status}.err{border-color:${COLORS.danger};color:${COLORS.danger};background:#fdecec;}
#${IDS.results}{margin-top:8px;display:flex;flex-direction:column;gap:8px;}
.waqa-item{border:1px solid ${COLORS.border};border-radius:9px;padding:8px 10px;background:${COLORS.bgSoft};}
.waqa-item .q-stem{font-weight:600;font-size:12.5px;margin-bottom:5px;line-height:1.5;}
.waqa-item .q-meta{font-size:11.5px;color:${COLORS.muted};margin-bottom:4px;}
.waqa-item .q-answer{margin:5px 0;font-size:12.5px;}
.waqa-item .q-answer b{color:${COLORS.success};}
.waqa-item.error{border-color:${COLORS.danger};}
.waqa-item.done{border-color:${COLORS.success};}
.waqa-chips{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0;}
.waqa-opt-chip{padding:2px 8px;border:1px solid ${COLORS.border};border-radius:11px;background:#fff;
  font-size:11.5px;cursor:pointer;user-select:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.waqa-opt-chip:hover{border-color:${COLORS.primary};color:${COLORS.primary};}
.waqa-opt-chip.on{border-color:${COLORS.success};color:${COLORS.success};background:#eefaf2;}
.waqa-opt-chip.full{white-space:normal;}
.waqa-item .q-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;}
.waqa-progress{height:5px;background:${COLORS.bgSoft};border-radius:3px;overflow:hidden;margin-top:7px;}
.waqa-progress > div{height:100%;background:${COLORS.primary};width:0;transition:width .2s;}
.waqa-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.waqa-field{display:flex;flex-direction:column;gap:3px;}
.waqa-field.full{grid-column:1 / -1;}
.waqa-field label{font-size:11.5px;color:${COLORS.muted};}
.waqa-field input,.waqa-field textarea,.waqa-field select{padding:6px 8px;border:1px solid ${COLORS.border};
  border-radius:7px;font-size:12.5px;outline:none;background:#fff;color:#1c2030;width:100%;}
.waqa-field input:focus,.waqa-field textarea:focus,.waqa-field select:focus{border-color:${COLORS.primary};}
.waqa-field textarea{resize:vertical;min-height:54px;font-family:inherit;}
.waqa-check{display:flex;align-items:center;gap:5px;font-size:12px;}
.waqa-check input{width:auto;}
.waqa-note{font-size:11px;color:${COLORS.muted};margin-top:6px;}
.waqa-picked{outline:2px solid ${COLORS.success};outline-offset:2px;}
body.waqa-picking{cursor:crosshair !important;}
.waqa-settings{display:none;border-top:1px solid ${COLORS.border};padding-top:10px;margin-top:4px;}
.waqa-settings.show{display:block;}
`;
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildUI() {
    if (ui) return ui;
    const fab = el('button', { id: IDS.fab, text: 'AI', title: '打开 AI 答题助手（点击切换）' });
    const panel = el('div', { id: IDS.panel });

    // 头部
    const minBtn = el('button', { class: 'waqa-hbtn', text: '—', title: '最小化' });
    const closeBtn = el('button', { class: 'waqa-hbtn', text: '✕', title: '关闭' });
    const header = el('div', { class: 'waqa-header' }, [
      el('span', { class: 'waqa-title', text: 'AI 答题助手' }),
      el('div', { class: 'waqa-hbtns' }, [minBtn, closeBtn]),
    ]);
    panel.appendChild(header);

    const body = el('div', { class: 'waqa-body' });
    panel.appendChild(body);

    // 答题区
    const quizSection = el('div', { class: 'waqa-section' });
    const quizBtns = el('div', { class: 'waqa-row' });
    const scanBtn = el('button', { class: 'waqa-btn', text: '🔍 识别题目' });
    const pickBtn = el('button', { class: 'waqa-btn ghost', text: '🎯 点选题目' });
    const stopBtn = el('button', { class: 'waqa-btn danger', text: '⏹ 停止', disabled: 'disabled' });
    const clearBtn = el('button', { class: 'waqa-btn ghost', text: '清空' });
    quizBtns.appendChild(scanBtn);
    quizBtns.appendChild(pickBtn);
    quizBtns.appendChild(stopBtn);
    quizBtns.appendChild(clearBtn);
    quizSection.appendChild(quizBtns);

    // 模型设置：独立按钮（点击展开/收起设置区）
    const settingsBtn = el('button', { class: 'waqa-btn ghost', text: '⚙ 模型设置' });
    const settingsRow = el('div', { class: 'waqa-row', style: { marginTop: '6px' } });
    settingsRow.appendChild(settingsBtn);
    quizSection.appendChild(settingsRow);

    const statusEl = el('div', { id: IDS.status, text: '提示：先配置模型，再点击“识别题目”。' });
    quizSection.appendChild(statusEl);
    const progressWrap = el('div', { class: 'waqa-progress' });
    const progressBar = el('div');
    progressWrap.appendChild(progressBar);
    quizSection.appendChild(progressWrap);

    const resultsEl = el('div', { id: IDS.results });
    quizSection.appendChild(resultsEl);
    body.appendChild(quizSection);

    // 模型设置区（默认折叠）
    const cfg = loadConfig();
    const inputs = {};
    const settingsSection = el('div', { class: 'waqa-settings' });
    settingsSection.appendChild(el('div', { class: 'waqa-section-title', text: '模型配置（自定义）' }));

    const grid = el('div', { class: 'waqa-grid' });
    const field = (key, label, opts) => {
      if (opts && opts.type === 'textarea') {
        const ta = el('textarea', { text: cfg[key] || '' });
        return { input: ta, wrap: el('div', { class: 'waqa-field full' }, [el('label', { text: label }), ta]) };
      }
      const input = el('input', { type: 'text', value: cfg[key] || '' });
      return { input, wrap: el('div', { class: 'waqa-field' }, [el('label', { text: label }), input]) };
    };

    const baseF = field('apiBase', 'API 地址（OpenAI 兼容）');
    inputs.apiBase = baseF.input;
    grid.appendChild(baseF.wrap);
    const keyF = field('apiKey', 'API Key');
    keyF.input.type = 'password';
    inputs.apiKey = keyF.input;
    grid.appendChild(keyF.wrap);
    const modelF = field('model', '模型名称');
    inputs.model = modelF.input;
    grid.appendChild(modelF.wrap);
    const tempF = field('temperature', '温度');
    tempF.input.type = 'number';
    tempF.input.step = '0.1';
    tempF.input.min = '0';
    tempF.input.max = '2';
    tempF.input.value = String(cfg.temperature);
    inputs.temperature = tempF.input;
    grid.appendChild(tempF.wrap);
    const timeoutF = field('timeout', '超时(ms)');
    timeoutF.input.type = 'number';
    timeoutF.input.min = '5000';
    timeoutF.input.value = String(cfg.timeout);
    inputs.timeout = timeoutF.input;
    grid.appendChild(timeoutF.wrap);
    const selectorF = field('selector', '题目选择器(留空自动)');
    inputs.selector = selectorF.input;
    grid.appendChild(selectorF.wrap);
    const headersF = field('customHeaders', '自定义请求头(每行 Header: value)', { type: 'textarea' });
    inputs.customHeaders = headersF.input;
    grid.appendChild(headersF.wrap);
    const promptF = field('systemPrompt', '系统提示词', { type: 'textarea' });
    inputs.systemPrompt = promptF.input;
    grid.appendChild(promptF.wrap);
    settingsSection.appendChild(grid);

    const togglesRow = el('div', { class: 'waqa-row', style: { marginTop: '8px' } });
    const toggle = (label, key) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!cfg[key];
      return { cb, wrap: el('label', { class: 'waqa-check' }, [cb, label]) };
    };
    const streamT = toggle('流式', 'stream');
    const autoFillT = toggle('自动填入', 'autoFill');
    const batchT = toggle('批量', 'batch');
    const toggles = { stream: streamT.cb, autoFill: autoFillT.cb, batch: batchT.cb };
    togglesRow.appendChild(streamT.wrap);
    togglesRow.appendChild(autoFillT.wrap);
    togglesRow.appendChild(batchT.wrap);
    settingsSection.appendChild(togglesRow);

    const settingsBtns = el('div', { class: 'waqa-row', style: { marginTop: '8px' } });
    const saveBtn = el('button', { class: 'waqa-btn', text: '保存配置' });
    const testBtn = el('button', { class: 'waqa-btn ghost', text: '测试连接' });
    const diagBtn = el('button', { class: 'waqa-btn ghost', text: '诊断' });
    settingsBtns.appendChild(saveBtn);
    settingsBtns.appendChild(testBtn);
    settingsBtns.appendChild(diagBtn);
    settingsSection.appendChild(settingsBtns);

    body.appendChild(settingsSection);

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    ui = {
      fab, panel, header, statusEl, resultsEl, progressBar,
      scanBtn, pickBtn, stopBtn, clearBtn, saveBtn, testBtn, diagBtn,
      settingsSection, settingsBtn, minBtn, closeBtn, inputs,
      toggles,
    };

    // --- 事件 ---
    fab.addEventListener('click', togglePanel);
    closeBtn.addEventListener('click', closePanel);
    minBtn.addEventListener('click', () => panel.classList.toggle('waqa-min'));
    settingsBtn.addEventListener('click', () => {
      const open = settingsSection.classList.toggle('show');
      settingsBtn.textContent = open ? '⚙ 收起设置' : '⚙ 模型设置';
      settingsBtn.classList.toggle('on', open);
      if (open) {
        const cp = loadConfig();
        inputs.apiBase.value = cp.apiBase;
        inputs.apiKey.value = cp.apiKey;
        inputs.model.value = cp.model;
        inputs.temperature.value = String(cp.temperature);
        inputs.timeout.value = String(cp.timeout);
        inputs.selector.value = cp.selector;
        inputs.customHeaders.value = cp.customHeaders;
        inputs.systemPrompt.value = cp.systemPrompt;
        toggles.stream.checked = cp.stream;
        toggles.autoFill.checked = cp.autoFill;
        toggles.batch.checked = cp.batch;
      }
    });

    saveBtn.addEventListener('click', () => {
      const next = loadConfig();
      next.apiBase = inputs.apiBase.value.trim();
      next.apiKey = inputs.apiKey.value.trim();
      next.model = inputs.model.value.trim();
      next.temperature = parseFloat(inputs.temperature.value) || 0.3;
      next.timeout = parseInt(inputs.timeout.value, 10) || 120000;
      next.selector = inputs.selector.value.trim();
      next.customHeaders = inputs.customHeaders.value;
      next.systemPrompt = inputs.systemPrompt.value;
      next.stream = toggles.stream.checked;
      next.autoFill = toggles.autoFill.checked;
      next.batch = toggles.batch.checked;
      saveConfig(next);
      setStatus('✅ 配置已保存。', 'ok');
    });

    testBtn.addEventListener('click', async () => {
      const cfg = readConfigFromUI();
      if (!cfg.apiBase) return setStatus('❌ 请先填写 API 地址。', 'err');
      setStatus('正在测试连接…');
      try {
        const res = await chatCompletion({
          ...cfg,
          stream: false,
          messages: [{ role: 'user', content: '只回复两个字：正常' }],
        });
        setStatus('✅ 连接成功：' + String(res).slice(0, 60), 'ok');
      } catch (e) {
        setStatus('❌ 连接失败：' + e.message, 'err');
      }
    });

    scanBtn.addEventListener('click', () => runQuiz());
    stopBtn.addEventListener('click', () => { if (abortCtrl) abortCtrl.abort(); });
    clearBtn.addEventListener('click', () => {
      resultsEl.textContent = '';
      clearPicked();
      setProgress(0);
    });
    pickBtn.addEventListener('click', () => togglePickMode());
    diagBtn.addEventListener('click', () => runDiagnostics());

    // 拖动
    let drag = null;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = (e.clientX - drag.dx) + 'px';
      panel.style.top = (e.clientY - drag.dy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = null; });

    return ui;
  }

  function setStatus(text, kind) {
    if (!ui) return;
    ui.statusEl.textContent = text;
    ui.statusEl.className = kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : kind === 'err' ? 'err' : '';
  }

  function setProgress(pct) {
    if (ui) ui.progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function togglePanel() {
    const u = buildUI();
    if (u.panel.style.display === 'flex') closePanel();
    else openPanel();
  }

  function openPanel() {
    const u = buildUI();
    u.panel.style.display = 'flex';
    u.panel.classList.remove('waqa-min');
  }

  function closePanel() {
    if (!ui) return;
    ui.panel.style.display = 'none';
    if (pickMode) togglePickMode();
  }

  function readConfigFromUI() {
    const cfg = loadConfig();
    if (ui) {
      cfg.apiBase = ui.inputs.apiBase.value.trim();
      cfg.apiKey = ui.inputs.apiKey.value.trim();
      cfg.model = ui.inputs.model.value.trim();
      cfg.temperature = parseFloat(ui.inputs.temperature.value) || 0.3;
      cfg.timeout = parseInt(ui.inputs.timeout.value, 10) || 120000;
      cfg.selector = ui.inputs.selector.value.trim();
      cfg.customHeaders = ui.inputs.customHeaders.value;
      cfg.systemPrompt = ui.inputs.systemPrompt.value;
      cfg.stream = ui.toggles.stream.checked;
      cfg.autoFill = ui.toggles.autoFill.checked;
      cfg.batch = ui.toggles.batch.checked;
    }
    return cfg;
  }

  /* ============================================================
   * 点击拾取题目容器
   * ============================================================ */

  function togglePickMode() {
    pickMode = !pickMode;
    if (pickMode) {
      document.body.classList.add('waqa-picking');
      setStatus('点选模式：点击页面上每道题的题目区域（题干或选项），可连点；再点“点选题目”结束。', 'warn');
      if (!pickHandler) {
        pickHandler = (e) => {
          if (!pickMode) return;
          if (isOwnUI(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          const target = resolveContainer(e.target);
          if (target && !isOwnUI(target)) {
            target.classList.add('waqa-picked');
            pickedContainers.push(target);
            setStatus('已选择 ' + pickedContainers.length + ' 道题，继续点其它题；点“识别题目”开始。', 'warn');
          }
        };
        document.addEventListener('click', pickHandler, true);
      }
    } else {
      document.body.classList.remove('waqa-picking');
      setStatus('点选结束，已选择 ' + pickedContainers.length + ' 道题。', 'warn');
    }
  }

  function clearPicked() {
    pickedContainers.forEach((c) => c.classList.remove('waqa-picked'));
    pickedContainers = [];
    document.body.classList.remove('waqa-picking');
    if (pickMode) pickMode = false;
  }

  /* ============================================================
   * 结果渲染
   * ============================================================ */

  function typeName(t) {
    return { single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题', text: '简答题' }[t] || t;
  }

  function renderQuestionItem(q) {
    const item = el('div', { class: 'waqa-item ' + q.status, dataset: { idx: String(q.index) } });
    item.appendChild(el('div', { class: 'q-stem', text: (q.index + 1) + '. ' + q.stem }));
    item.appendChild(el('div', { class: 'q-meta', text: '类型：' + typeName(q.type) }));

    let actions = null;

    // 选项 chips（干净解析结果）
    if (q.options && q.options.length) {
      const chipsRow = el('div', { class: 'waqa-chips' });
      q.options.forEach((opt) => {
        const chip = el('span', { class: 'waqa-opt-chip', text: opt.letter + '. ' + opt.text });
        chip.dataset.letter = opt.letter;
        chip.addEventListener('click', () => {
          if (q.type === 'multiple') chip.classList.toggle('on');
          else {
            Array.from(chipsRow.children).forEach((c) => c.classList.remove('on'));
            chip.classList.add('on');
          }
          q.manualLetters = Array.from(chipsRow.querySelectorAll('.on')).map((c) => c.dataset.letter);
        });
        chipsRow.appendChild(chip);
      });
      item.appendChild(chipsRow);
    }

    const ans = el('div', { class: 'q-answer', text: '答案：等待中…' });
    item.appendChild(ans);

    actions = el('div', { class: 'q-actions' });
    const fillBtn = el('button', { class: 'waqa-btn ghost', text: '填入答案', disabled: 'disabled' });
    const copyBtn = el('button', { class: 'waqa-btn ghost', text: '复制' });
    fillBtn.addEventListener('click', () => {
      const use = q.manualLetters && q.manualLetters.length ? q.manualLetters.join('') : q.answer;
      const ok = fillAnswer(q, use);
      setStatus(ok ? '已填入第 ' + (q.index + 1) + ' 题。' : '第 ' + (q.index + 1) + ' 题填入失败，请手动选择选项。', ok ? 'ok' : 'warn');
    });
    copyBtn.addEventListener('click', () => {
      const use = q.manualLetters && q.manualLetters.length ? q.manualLetters.join('') : q.answer;
      if (navigator.clipboard) navigator.clipboard.writeText(use);
      else {
        const ta = el('textarea', { text: use });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setStatus('已复制第 ' + (q.index + 1) + ' 题答案。');
    });
    actions.appendChild(fillBtn);
    actions.appendChild(copyBtn);
    item.appendChild(actions);

    q.el = item;
    q.fillBtn = fillBtn;
    q.answerEl = ans;
    return item;
  }

  function updateItem(q) {
    if (!q.el) return;
    q.el.className = 'waqa-item ' + q.status;
    if (q.status === 'loading') {
      q.answerEl.textContent = '答案：思考中…';
      q.fillBtn.disabled = true;
    } else if (q.status === 'done') {
      q.answerEl.textContent = '';
      q.answerEl.appendChild(el('span', { text: '答案：' }));
      q.answerEl.appendChild(el('b', { text: q.answer || '—' }));
      q.fillBtn.disabled = !q.answer;
    } else if (q.status === 'error') {
      q.answerEl.textContent = '答案：获取失败（' + (q.error || '未知错误') + '）';
      q.fillBtn.disabled = true;
    }
  }

  /* ============================================================
   * 诊断
   * ============================================================ */

  function runDiagnostics() {
    try {
      const cfg = readConfigFromUI();
      const docs = scanDocuments();
      let commonCount = 0;
      for (const sel of COMMON_CONTAINERS) {
        docs.forEach((doc) => { try { commonCount += doc.querySelectorAll(sel).length; } catch (e) {} });
      }
      let heur = 0;
      docs.forEach((doc) => { heur += findHeuristicInDoc(doc).length; });
      setStatus(
        '诊断：\nURL: ' + location.href.slice(0, 100) + '\n' +
        '可扫描文档(含同源iframe): ' + docs.length + '\n' +
        '常见选择器命中: ' + commonCount + '\n' +
        '启发式命中: ' + heur + '\n' +
        '已点选: ' + pickedContainers.length + '\n' +
        'API已配置: ' + (cfg.apiBase && cfg.apiKey ? '是' : '否') + '\n' +
        '选择器: ' + (cfg.selector || '空'),
        'warn'
      );
    } catch (e) {
      setStatus('诊断出错：' + e.message, 'err');
    }
  }

  /* ============================================================
   * 主流程
   * ============================================================ */

  let abortCtrl = null;

  async function runQuiz() {
    try {
      const cfg = readConfigFromUI();
      if (!cfg.apiBase || !cfg.apiKey) {
        setStatus('❌ 请先配置 API 地址和 API Key（点右上角 ⚙）。', 'err');
        return;
      }
      if (!cfg.model) { setStatus('❌ 请填写模型名称。', 'err'); return; }

      let containers = [];
      try { containers = detectQuestionContainers(cfg); }
      catch (e) {
        logErr('识别题目出错', e);
        setStatus('❌ 识别题目出错：' + e.message + '。可点“诊断”查看。', 'err');
        return;
      }
      if (!containers.length) {
        setStatus('⚠️ 未识别到题目。可点“🎯 点选题目”手动逐题点击，或填写自定义选择器。', 'warn');
        return;
      }

      const questions = containers.map((c, i) => extractQuestion(c, i));
      setStatus('🔍 识别到 ' + questions.length + ' 道题目，开始请求…');
      ui.resultsEl.textContent = '';
      questions.forEach((q) => ui.resultsEl.appendChild(renderQuestionItem(q)));

      abortCtrl = new AbortController();
      ui.stopBtn.disabled = false;
      ui.scanBtn.disabled = true;
      setProgress(0);

      try {
        if (cfg.batch) await runBatch(cfg, questions);
        else await runSingle(cfg, questions);
      } catch (e) {
        if (e.name !== 'AbortError') { logErr(e); setStatus('❌ ' + e.message, 'err'); }
      } finally {
        abortCtrl = null;
        ui.stopBtn.disabled = true;
        ui.scanBtn.disabled = false;
      }
    } catch (e) {
      logErr('runQuiz 出错', e);
      setStatus('❌ 出错：' + (e && e.message ? e.message : String(e)), 'err');
    }
  }

  async function runSingle(cfg, questions) {
    let done = 0;
    for (const q of questions) {
      if (abortCtrl && abortCtrl.signal.aborted) break;
      q.status = 'loading';
      updateItem(q);
      try {
        const messages = [
          { role: 'system', content: cfg.systemPrompt },
          { role: 'user', content: questionPrompt(q) },
        ];
        const answer = await chatCompletion({
          ...cfg,
          headers: parseCustomHeaders(cfg.customHeaders),
          messages,
          signal: abortCtrl && abortCtrl.signal,
          onDelta: (d) => {
            q.answer = (q.answer || '') + d;
            if (q.answerEl) q.answerEl.textContent = '答案：' + q.answer;
          },
        });
        q.answer = answer || q.answer;
        q.status = 'done';
        updateItem(q);
        if (cfg.autoFill) {
          const ok = fillAnswer(q, q.answer);
          if (ok) setStatus('已自动填入第 ' + (q.index + 1) + ' 题。');
        }
      } catch (e) {
        q.status = 'error';
        q.error = e.message;
        updateItem(q);
      }
      done++;
      setProgress((done / questions.length) * 100);
    }
    if (abortCtrl && abortCtrl.signal.aborted) setStatus('⏹ 已停止。已完成 ' + done + '/' + questions.length + ' 题。', 'warn');
    else setStatus('✅ 完成，共 ' + questions.length + ' 题。可点“填入答案”或“复制”。', 'ok');
  }

  async function runBatch(cfg, questions) {
    const userContent =
      '请依次回答下面的题目。按顺序每行输出一题的答案，格式：题号. 答案。不要输出其它内容。\n\n' +
      questions.map((q) => questionPrompt(q)).join('\n\n');
    const messages = [
      { role: 'system', content: cfg.systemPrompt },
      { role: 'user', content: userContent },
    ];
    setStatus('批量请求中（共 ' + questions.length + ' 题）…');
    let full = '';
    try {
      const answer = await chatCompletion({
        ...cfg,
        headers: parseCustomHeaders(cfg.customHeaders),
        messages,
        signal: abortCtrl && abortCtrl.signal,
        onDelta: (d) => { full += d; },
      });
      full = answer || full;
      const lines = full.split(/\r?\n/);
      const map = {};
      let cur = 0;
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s*[.、．)）]\s*(.*)$/);
        if (m) {
          const idx = parseInt(m[1], 10) - 1;
          if (idx >= 0 && idx < questions.length) {
            map[idx] = (map[idx] || '') + (map[idx] ? ' ' : '') + m[2].trim();
            cur = idx;
          }
        } else if (line.trim() && cur !== null && map[cur] !== undefined) {
          map[cur] += ' ' + line.trim();
        }
      }
      let count = 0;
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (map[i] !== undefined && map[i] !== '') {
          q.answer = map[i];
          q.status = 'done';
          updateItem(q);
          if (cfg.autoFill) fillAnswer(q, q.answer);
          count++;
        } else {
          q.status = 'error';
          q.error = '批量结果缺少该题';
          updateItem(q);
        }
      }
      setProgress(100);
      setStatus(
        count === questions.length ? '✅ 批量完成，共 ' + count + ' 题。' : '⚠️ 批量完成，成功解析 ' + count + '/' + questions.length + ' 题。',
        count === questions.length ? 'ok' : 'warn'
      );
    } catch (e) {
      setStatus('❌ 批量请求失败：' + e.message, 'err');
    }
  }

  /* ============================================================
   * 初始化
   * ============================================================ */

  function init() {
    // 先从 chrome.storage 读取配置，再建界面（loadConfig 是同步读内存缓存）
    try {
      chrome.storage.local.get(STORE_KEY, (res) => {
        try {
          if (res && res[STORE_KEY] && typeof res[STORE_KEY] === 'object') {
            CURRENT_CONFIG = { ...DEFAULT_CONFIG, ...res[STORE_KEY] };
          }
        } catch (e) { logErr('读取配置失败', e); }
        try { buildStyle(); buildUI(); }
        catch (e) { logErr('初始化失败', e); }
      });
    } catch (e) { logErr('初始化失败', e); }

    try {
      window.addEventListener('error', (ev) => {
        const msg = (ev && ev.error && ev.error.message) || ev.message || '未知脚本错误';
        logErr('脚本运行错误', ev.error || ev.message);
        if (ui && ui.panel.style.display === 'flex') setStatus('⚠️ 脚本错误：' + msg, 'err');
      });
      window.addEventListener('unhandledrejection', (ev) => {
        const msg = ev && ev.reason ? (ev.reason.message || String(ev.reason)) : '未处理的 Promise 错误';
        logErr('未处理的Promise错误', ev && ev.reason);
        if (ui && ui.panel.style.display === 'flex') setStatus('⚠️ ' + msg, 'err');
      });
    } catch (e) { /* ignore */ }

    log('初始化完成');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
