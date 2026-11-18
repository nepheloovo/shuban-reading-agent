const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let BOOK = null;
let current = 'c06';
let selection = '';

const SUGGEST = [
  '隐鼠到底是怎么死的？',
  '长妈妈为什么要故意害死隐鼠？',
  '总结一下这一篇',
  '考考我',
  '藤野先生的生日是哪天？',
  '帮我写一份周报',
];

async function init() {
  BOOK = await (await fetch('/api/book')).json();
  $('#toc').innerHTML = BOOK.chapters.map((c) => `<li><button data-ch="${c.id}">${esc(c.title)}</button></li>`).join('');
  $('#toc').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openChapter(b.dataset.ch); });
  $('#chips').innerHTML = SUGGEST.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
  $('#chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) ask(b.textContent); });
  openChapter(new URLSearchParams(location.search).get('ch') || current);
}

function openChapter(id, scrollTo) {
  current = id;
  const c = BOOK.chapters.find((x) => x.id === id);
  $('#chTitle').textContent = c.title;
  $('#chBody').innerHTML = c.paras.map((p, i) => `<p id="${c.id}-${i + 1}" data-n="${i + 1}">${esc(p)}</p>`).join('');
  document.querySelectorAll('#toc button').forEach((b) => b.classList.toggle('on', b.dataset.ch === id));
  if (!scrollTo) $('#reader').scrollTop = 0;
}

function jumpTo(paraId) {
  const ch = paraId.split('-')[0];
  if (ch !== current) openChapter(ch, true);
  const el = document.getElementById(paraId);
  if (!el) return;
  document.querySelectorAll('.ch-body p.hl').forEach((p) => p.classList.remove('hl'));
  el.classList.add('hl');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
window.jumpTo = jumpTo;

// ---------- 划线 ----------
document.addEventListener('mouseup', (e) => {
  if (e.target.closest('.sel-pop')) return;
  setTimeout(() => {
    const s = window.getSelection();
    const text = s.toString().trim();
    const pop = $('#selPop');
    if (!text || !s.anchorNode || !$('#chBody').contains(s.anchorNode)) { pop.hidden = true; return; }
    const r = s.getRangeAt(0).getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = `${Math.max(8, r.left + r.width / 2 - 90)}px`;
    pop.style.top = `${r.top - 46}px`;
    pop.dataset.text = text.slice(0, 200);
  }, 10);
});
$('#popExplain').addEventListener('click', () => { const t = $('#selPop').dataset.text; $('#selPop').hidden = true; window.getSelection().removeAllRanges(); setSel(''); ask('', t); });
$('#popAsk').addEventListener('click', () => { setSel($('#selPop').dataset.text); $('#selPop').hidden = true; window.getSelection().removeAllRanges(); $('#q').focus(); });
$('#selClear').addEventListener('click', () => setSel(''));
function setSel(t) { selection = t; $('#selChip').hidden = !t; $('#selText').textContent = t ? `“${t}”` : ''; }
window.setSel = setSel;

// ---------- 对话 ----------
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#q').value.trim(); if (!q && !selection) return; ask(q, selection); });

async function ask(question, sel = '') {
  $('#q').value = '';
  setSel('');
  const log = $('#log');
  log.insertAdjacentHTML('beforeend', `<div class="msg-user">${sel ? `<span class="q-sel">“${esc(sel.length > 40 ? sel.slice(0, 40) + '…' : sel)}”</span>` : ''}${esc(question || '解释这句')}</div>`);
  const holder = document.createElement('div');
  holder.className = 'card';
  holder.innerHTML = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span>书伴正在路由、检索原文并核验引用…</div>`;
  log.appendChild(holder);
  log.scrollTop = log.scrollHeight;
  $('#send').disabled = true;
  try {
    const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, selection: sel, chapterId: current }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    holder.innerHTML = renderAnswer(d);
    bindCard(holder, d);
    window.__last = d;
  } catch (e) {
    holder.innerHTML = `<p class="ans">出错了：${esc(e.message)}</p>`;
  }
  $('#send').disabled = false;
  holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.ask = ask;

function supify(text, cites) {
  const map = new Map((cites || []).map((c) => [String(c.n), c]));
  return esc(text).replace(/\s?\[(\d+)\]/g, (m, n) => (map.has(n) ? `<sup data-p="${map.get(n).para}">[${n}]</sup>` : ''));
}

function renderAnswer(d) {
  const v = d.verification || { total: 0 };
  const vtag = v.total ? (v.dropped ? `<span class="tag warn">引用 ${v.verified + v.relocated}/${v.total} 核验通过</span>` : `<span class="tag ok">✓ 引用 ${v.total}/${v.total} 原文核验</span>`) : '';
  let h = `<div class="meta"><span class="tag">路由 · ${esc(d.intentLabel)}</span>${d.routeBy === 'rule' ? '<span class="tag gray">规则层</span>' : ''}${vtag}<span class="tag gray">${(d.totalMs / 1000).toFixed(1)}s</span></div>`;
  if (d.premise_issue) h += `<p class="premise"><b>⚠ 前提有误</b>${esc(d.premise_issue)}</p>`;
  h += `<p class="ans">${supify(d.answer, d.citations)}</p>`;
  if (d.points?.length) {
    h += `<ul class="points">${d.points.map((p) => `<li class="pt">${esc(p.text)}${p.citations.map((c) => ` <sup data-p="${c.para}">[第${c.para.split('-')[1]}段]</sup>`).join('')}</li>`).join('')}</ul>`;
  }
  if (d.quiz?.length) {
    h += `<div class="quiz">${d.quiz.map((q, i) => `<div class="qz" data-i="${i}"><div class="qq">${i + 1}. ${esc(q.q)}</div><div class="opts">${q.options.map((o, j) => `<button class="opt" type="button" data-j="${j}">${'ABCD'[j]}. ${esc(o)}</button>`).join('')}</div><div class="why">${esc(q.explain)}${q.source && q.source.status !== 'dropped' ? ` <sup data-p="${q.source.para}">[${esc(q.source.label)}]</sup>` : ''}</div></div>`).join('')}</div>`;
  }
  if (d.outside) h += `<div class="outside"><b>📎 书外补充</b>以下不是原文内容：${esc(d.outside)}</div>`;
  if (d.citations?.length) {
    h += `<div class="cites">${d.citations.map((c) => `<button class="cite" type="button" data-p="${c.para}"><span class="n">[${c.n}]</span><span><span class="src">${esc(c.label)}</span> <span class="qt">“${esc(c.quote)}”</span></span><span class="st ${c.status === 'relocated' ? 're' : ''}">${c.status === 'relocated' ? '已纠正段落' : '✓ 逐字核验'}</span></button>`).join('')}</div>`;
  }
  h += `<details class="trace" ${window.__demo ? 'open' : ''}><summary>Agent 执行轨迹（${d.trace.length} 步）</summary><ol>${d.trace.map((t) => `<li><b>${esc(t.step)}</b>${esc(t.detail)}${t.ms ? `<span class="ms">${t.ms}ms</span>` : ''}</li>`).join('')}</ol></details>`;
  return h;
}

function bindCard(el, d) {
  el.addEventListener('click', (e) => {
    const s = e.target.closest('[data-p]');
    if (s) return jumpTo(s.dataset.p);
    const o = e.target.closest('.opt');
    if (o) {
      const qz = o.closest('.qz');
      if (qz.classList.contains('done')) return;
      const q = d.quiz[+qz.dataset.i];
      qz.classList.add('done');
      qz.querySelectorAll('.opt').forEach((b) => { if (+b.dataset.j === q.answer_index) b.classList.add('right'); });
      if (+o.dataset.j !== q.answer_index) o.classList.add('wrong');
    }
  });
}

// 录屏用字幕
window.__caption = (t, sub) => {
  const c = $('#caption');
  if (!t) { c.hidden = true; return; }
  c.innerHTML = `${esc(t)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  c.hidden = false;
};
window.__demo = new URLSearchParams(location.search).has('demo');

init();
