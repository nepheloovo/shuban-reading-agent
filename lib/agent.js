// 书伴 · 伴读 Agent 核心：路由 → 检索 → 技能生成 → 引用核验
const { chat } = require('./llm');
const book = require('../data/book.json');

// ---------- 原文索引 ----------
const PARAS = []; // {id, chapterId, chapterTitle, idx, text}
const BY_ID = new Map();
for (const c of book.chapters) {
  c.paras.forEach((text, i) => {
    const p = { id: `${c.id}-${i + 1}`, chapterId: c.id, chapterTitle: c.title, idx: i + 1, text };
    PARAS.push(p);
    BY_ID.set(p.id, p);
  });
}
const CH_BY_ID = new Map(book.chapters.map((c) => [c.id, c]));
const label = (id) => {
  const p = BY_ID.get(id);
  return p ? `「${p.chapterTitle}」第${p.idx}段` : id;
};

const norm = (s) => (s || '').replace(/[\s“”‘’"'「」『』，。、；：！？（）《》〈〉…—\-,.;:!?()\[\]【】·]/g, '');

// 字二元组 + IDF 的轻量检索（不依赖向量库，便于讲清楚、便于评测）
const bigrams = (s) => {
  const t = norm(s);
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
const PARA_BG = PARAS.map((p) => bigrams(p.text));
const DF = new Map();
for (const bg of PARA_BG) for (const g of bg) DF.set(g, (DF.get(g) || 0) + 1);
const IDF = (g) => Math.log((PARAS.length + 1) / ((DF.get(g) || 0) + 1));

function retrieve(query, { keywords = [], chapterId = null, k = 8 } = {}) {
  const q = bigrams(query);
  const kw = new Set();
  for (const w of keywords) for (const g of bigrams(w)) kw.add(g);
  const scored = PARAS.map((p, i) => {
    let s = 0;
    for (const g of q) if (PARA_BG[i].has(g)) s += IDF(g);
    for (const g of kw) if (PARA_BG[i].has(g)) s += 1.5 * IDF(g);
    if (chapterId && p.chapterId === chapterId) s *= 1.25;
    return { p, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).filter((x) => x.s > 0).map((x) => ({ ...x.p, score: +x.s.toFixed(2) }));
}

// ---------- 版权护栏：回答里不允许出现大段原文 ----------
const SHINGLE = 24;
const SHINGLES = new Set();
for (const p of PARAS) {
  const t = norm(p.text);
  for (let i = 0; i + SHINGLE <= t.length; i += 2) SHINGLES.add(t.slice(i, i + SHINGLE));
}
function longCopy(text) {
  const t = norm(text);
  for (let i = 0; i + SHINGLE <= t.length; i++) if (SHINGLES.has(t.slice(i, i + SHINGLE))) return true;
  return false;
}

// ---------- 引用核验：逐字比对原文，对不上就纠偏或移除 ----------
function verifyCitation(c) {
  const quote = (c.quote || '').trim();
  const nq = norm(quote);
  if (nq.length < 2) return { ...c, status: 'dropped', reason: '摘录为空' };
  const p = BY_ID.get(c.para);
  if (p && norm(p.text).includes(nq)) return { ...c, status: 'verified', label: label(c.para) };
  const found = PARAS.find((x) => norm(x.text).includes(nq));
  if (found) return { ...c, para: found.id, status: 'relocated', from: c.para, label: label(found.id) };
  return { ...c, status: 'dropped', reason: '原文中找不到这句摘录' };
}

function verifyAll(result) {
  const cits = (result.citations || []).map(verifyCitation);
  const dropped = new Set(cits.filter((c) => c.status === 'dropped').map((c) => c.n));
  let answer = result.answer || '';
  for (const n of dropped) answer = answer.replaceAll(`[${n}]`, '');
  const pointRaw = [];
  const points = (result.points || []).map((pt) => {
    const pc = (pt.citations || []).map(verifyCitation);
    pointRaw.push(...pc);
    return { ...pt, citations: pc.filter((c) => c.status !== 'dropped'), droppedCount: pc.filter((c) => c.status === 'dropped').length };
  });
  const quiz = (result.quiz || []).map((q) => ({ ...q, source: verifyCitation({ para: q.para, quote: q.quote }) }));
  const all = [...cits, ...pointRaw, ...quiz.map((q) => q.source)];
  const total = all.length;
  const verified = all.filter((c) => c.status === 'verified').length;
  const relocated = all.filter((c) => c.status === 'relocated').length;
  const droppedTotal = all.filter((c) => c.status === 'dropped').length;
  const copyFlag = longCopy(answer) || points.some((p) => longCopy(p.text));
  return {
    ...result,
    answer,
    citations: cits.filter((c) => c.status !== 'dropped'),
    droppedCitations: cits.filter((c) => c.status === 'dropped'),
    points,
    quiz,
    verification: { total, verified, relocated, dropped: droppedTotal, copyFlag },
  };
}

// ---------- 路由 ----------
const ROUTER_PROMPT = `你是阅读器 AI 助手的意图路由器。用户正在读鲁迅《朝花夕拾》。
把用户的输入分到以下意图之一：
- book_qa：询问书中的人物、情节、细节、原因、作者在书里的态度等（包括书里没写、需要回答"书中没有提到"的问题，以及前提可能有误的问题）
- explain：用户划线选中了一段文字，想知道它是什么意思、在这里指什么（有划线文字且在问含义时优先选它）
- summary：要求概括、总结某一篇/本章讲了什么
- quiz：要求出题、检验、考考我
- off_topic：与这本书无关的请求（写工作文档、查天气、闲聊等）
同时给出相关篇目（从目录中选，没有就填 null）和 2-5 个检索关键词（人名、物名、事件）。
目录：${book.chapters.map((c) => `${c.id}=${c.title}`).join('；')}
只输出 JSON：{"intent":"...","chapter":"c06 或 null","keywords":["..."],"reason":"一句话理由"}`;

async function route({ question, selection, chapterId }) {
  // 规则层：只划线不提问 → 直接走解释，不调模型
  if (selection && (!question || question.trim().length <= 2)) {
    return { intent: 'explain', chapter: chapterId, keywords: [selection.slice(0, 12)], reason: '规则命中：仅划线未提问', by: 'rule', ms: 0 };
  }
  const cur = chapterId ? CH_BY_ID.get(chapterId)?.title : null;
  const user = `当前正在读：${cur || '未知'}\n划线文字：${selection || '无'}\n用户输入：${question}`;
  const r = await chat([{ role: 'system', content: ROUTER_PROMPT }, { role: 'user', content: user }], { json: true, temperature: 0, maxTokens: 200 });
  const d = r.data || {};
  const intents = ['book_qa', 'explain', 'summary', 'quiz', 'off_topic'];
  if (!intents.includes(d.intent)) d.intent = 'book_qa';
  if (d.chapter && !CH_BY_ID.has(d.chapter)) d.chapter = null;
  return { ...d, keywords: Array.isArray(d.keywords) ? d.keywords : [], by: 'llm', ms: r.ms };
}

// ---------- 技能提示词（版本化） ----------
const BOOK_TAG = '鲁迅《朝花夕拾》';
const fmtParas = (ps) => ps.map((p) => `[${p.id}]《${p.chapterTitle}》第${p.idx}段：${p.text}`).join('\n');

const PROMPTS = {
  qa_v2: `你是「书伴」，阅读器里的伴读助手，正在陪用户读${BOOK_TAG}。
规则：
1. 只依据【原文段落】回答书内问题，不要用你记忆中的内容补充书里的情节。
2. 每个关键结论后标注引用编号如 [1]；在 citations 里给出段落 id 和一句逐字摘录（不超过30字，必须和原文一字不差，可以只截取半句）。
3. 原文段落里找不到依据时，answer 直接说"书中没有提到……"，不要猜测，grounded 填 false。
4. 如果问题的前提和原文矛盾（把事实说错了），premise_issue 用一句话指出错在哪里，answer 按原文纠正。
5. 需要补充书外背景（作者生平、历史常识、词语出处）时，写进 outside 字段，不要混进 answer。
6. 用自己的话回答，不要大段照抄原文；answer 不超过150字。
只输出 JSON：{"answer":"...","citations":[{"n":1,"para":"c09-15","quote":"..."}],"grounded":true,"premise_issue":null,"outside":null}`,

  qa_v3: `你是「书伴」，阅读器里的伴读助手，正在陪用户读${BOOK_TAG}。
规则：
1. 只依据【原文段落】回答书内问题，不要用你记忆中的内容补充书里的情节。
2. 先通读全部段落再作答：答案常常分散在几个相邻的短段落里，也可能用的是和问题不同的说法（如"死"写成"打捞尸体"）。
3. 每个关键结论后标注引用编号如 [1]；在 citations 里给出段落 id 和一句逐字摘录（不超过30字，必须和原文一字不差，可以只截取半句）。
4. 只有确认段落里没有依据时，answer 才说"书中没有提到……"，grounded 填 false；不要猜测。
5. 如果问题的前提和原文矛盾（把事实说错了），premise_issue 用一句话指出错在哪里，answer 按原文纠正。
6. 需要补充书外背景（作者生平、历史常识、词语出处）时，写进 outside 字段，不要混进 answer。
7. 用自己的话回答，不要大段照抄原文；answer 不超过150字。
只输出 JSON：{"answer":"...","citations":[{"n":1,"para":"c09-15","quote":"..."}],"grounded":true,"premise_issue":null,"outside":null}`,

  qa_v1: `你是一个读书助手。参考下面的原文段落，回答用户关于${BOOK_TAG}的问题，回答不超过150字。
只输出 JSON：{"answer":"..."}`,

  qa_bare: `你是一个读书助手。回答用户关于${BOOK_TAG}的问题，回答不超过150字。
只输出 JSON：{"answer":"..."}`,

  explain_v2: `你是「书伴」，阅读器里的伴读助手，正在陪用户读${BOOK_TAG}。用户划线选中了一段文字。
请解释它：先说在本书这个语境里指什么、作者为什么这样写（依据原文，标注引用 [1]），再在 outside 里补充必要的书外知识（词义、典故、时代背景），明确是书外信息。
引用要求：citations 里给出段落 id 和逐字摘录（不超过30字，与原文一字不差）。answer 不超过120字，不要照抄原文。
只输出 JSON：{"answer":"...","citations":[{"n":1,"para":"...","quote":"..."}],"outside":"...或 null"}`,

  summary_v2: `你是「书伴」，阅读器里的伴读助手。请概括${BOOK_TAG}中的这一篇。
要求：answer 用一句话说这篇写了什么；points 给 3-4 个要点，每个要点不超过40字，附 1 条引用（段落 id + 逐字摘录，不超过30字，与原文一字不差）。不要编造原文没有的情节。
只输出 JSON：{"answer":"...","points":[{"text":"...","citations":[{"para":"...","quote":"..."}]}]}`,

  quiz_v2: `你是「书伴」，阅读器里的伴读助手。请根据${BOOK_TAG}这一篇出 3 道单选题，检验读者是否读懂（不要考生僻细节，侧重人物、情节与作者态度）。
每题 4 个选项，answer_index 从 0 开始；explain 一句话说明；para 和 quote 给出答案依据（逐字摘录，不超过30字，与原文一字不差）。
只输出 JSON：{"answer":"读完这一篇，来检验一下：","quiz":[{"q":"...","options":["..","..","..",".."],"answer_index":0,"explain":"...","para":"...","quote":"..."}]}`,
};

const OFF_TOPIC = {
  answer: '我是书伴，只陪你读《朝花夕拾》。这个问题超出了这本书的范围，我先不回答。你可以划线问我某句话的意思，或者让我总结、出题。',
  citations: [],
  grounded: true,
};

// ---------- 执行 ----------
async function runSkill(intent, { question, selection, chapterId, keywords, variant = 'v3' }) {
  const trace = [];
  if (intent === 'off_topic') {
    trace.push({ step: '兜底话术', detail: '与本书无关，走固定话术，不调用模型', ms: 0 });
    return { result: { ...OFF_TOPIC }, trace };
  }

  if (intent === 'summary' || intent === 'quiz') {
    const cid = chapterId || 'c09';
    const ch = CH_BY_ID.get(cid);
    const ps = PARAS.filter((p) => p.chapterId === cid);
    trace.push({ step: '取整篇原文', detail: `《${ch.title}》共 ${ps.length} 段`, ms: 0 });
    const r = await chat([
      { role: 'system', content: PROMPTS[`${intent}_v2`] },
      { role: 'user', content: `【原文段落】\n${fmtParas(ps)}\n\n用户：${question || (intent === 'summary' ? '总结这一篇' : '给这一篇出题')}` },
    ], { json: true, maxTokens: 1500 });
    trace.push({ step: '生成', detail: `${intent === 'summary' ? '章节摘要' : '读后出题'}技能`, ms: r.ms, tokens: r.usage?.total_tokens });
    return { result: r.data, trace, chapterTitle: ch.title, chapterId: cid };
  }

  if (intent === 'explain') {
    let anchor = selection ? PARAS.find((p) => norm(p.text).includes(norm(selection))) : null;
    const ctx = [];
    if (anchor) {
      const ps = PARAS.filter((p) => p.chapterId === anchor.chapterId);
      for (const p of ps) if (Math.abs(p.idx - anchor.idx) <= 1) ctx.push(p);
    } else {
      ctx.push(...retrieve(`${selection || ''} ${question || ''}`, { keywords, chapterId, k: 4 }));
    }
    trace.push({ step: '定位划线', detail: anchor ? `定位到 ${label(anchor.id)}，取前后各 1 段` : '未精确定位，改用检索', ms: 0 });
    const r = await chat([
      { role: 'system', content: PROMPTS.explain_v2 },
      { role: 'user', content: `【原文段落】\n${fmtParas(ctx)}\n\n划线文字：${selection || '无'}\n用户：${question || '这是什么意思？'}` },
    ], { json: true });
    trace.push({ step: '生成', detail: '划线解释技能', ms: r.ms, tokens: r.usage?.total_tokens });
    return { result: r.data, trace, anchor: anchor?.id };
  }

  // book_qa
  if (variant === 'bare') {
    const r = await chat([{ role: 'system', content: PROMPTS.qa_bare }, { role: 'user', content: question }], { json: true });
    trace.push({ step: '生成', detail: '裸模型：不给原文', ms: r.ms });
    return { result: { citations: [], ...r.data }, trace };
  }
  const t0 = Date.now();
  if (variant === 'v1' || variant === 'v2') {
    // v1/v2：只用全书检索 top-8 段（历史版本，保留用于评测对照）
    const hits = retrieve(question + ' ' + (selection || ''), { keywords, chapterId, k: 8 });
    trace.push({ step: '检索', detail: `全书检索命中 ${hits.length} 段：${hits.slice(0, 4).map((h) => label(h.id)).join('、')}${hits.length > 4 ? ' 等' : ''}`, ms: Date.now() - t0, hits: hits.map((h) => h.id) });
    const r = await chat([
      { role: 'system', content: variant === 'v1' ? PROMPTS.qa_v1 : PROMPTS.qa_v2 },
      { role: 'user', content: `【原文段落】\n${fmtParas(hits)}\n\n${selection ? `划线文字：${selection}\n` : ''}用户问题：${question}` },
    ], { json: true });
    trace.push({ step: '生成', detail: variant === 'v1' ? 'Prompt v1（无引用/拒答约束）' : '书内问答 · Prompt v2', ms: r.ms, tokens: r.usage?.total_tokens });
    return { result: { citations: [], ...r.data }, trace, hits: hits.map((h) => h.id) };
  }

  // v3（当前版本）：章节全文 + 全书检索补充；拒答前扩大范围再查一次
  const hits = retrieve(question + ' ' + (selection || ''), { keywords, chapterId, k: 10 });
  const pickChapter = chapterId || topChapter(hits);
  const buildCtx = (cid, extra) => {
    const own = PARAS.filter((p) => p.chapterId === cid);
    const others = extra.filter((h) => h.chapterId !== cid).slice(0, 4);
    return [...own, ...others];
  };
  let ctx = buildCtx(pickChapter, hits);
  trace.push({ step: '检索', detail: `锁定「${CH_BY_ID.get(pickChapter).title}」全文 + 其他篇目 ${ctx.length - PARAS.filter((p) => p.chapterId === pickChapter).length} 段`, ms: Date.now() - t0, hits: hits.map((h) => h.id) });
  const gen = (c) => chat([
    { role: 'system', content: PROMPTS.qa_v3 },
    { role: 'user', content: `【原文段落】\n${fmtParas(c)}\n\n${selection ? `划线文字：${selection}\n` : ''}用户问题：${question}` },
  ], { json: true });
  let r = await gen(ctx);
  trace.push({ step: '生成', detail: '书内问答 · Prompt v3', ms: r.ms, tokens: r.usage?.total_tokens });
  if (r.data && r.data.grounded === false) {
    // 拒答前自检：换到检索得分第二高的篇目再查一次
    const alt = topChapter(hits.filter((h) => h.chapterId !== pickChapter));
    if (alt) {
      const r2 = await gen(buildCtx(alt, hits));
      const found = r2.data && r2.data.grounded !== false;
      trace.push({ step: '拒答前复查', detail: found ? `在「${CH_BY_ID.get(alt).title}」找到依据，采用复查结果` : `扩大到「${CH_BY_ID.get(alt).title}」仍无依据，确认拒答`, ms: r2.ms });
      if (found) r = r2;
    }
  }
  return { result: { citations: [], ...r.data }, trace, hits: hits.map((h) => h.id) };
}

function topChapter(hits) {
  const score = new Map();
  for (const h of hits) score.set(h.chapterId, (score.get(h.chapterId) || 0) + h.score);
  let best = null;
  for (const [k, v] of score) if (!best || v > best[1]) best = [k, v];
  return best ? best[0] : null;
}

async function ask({ question = '', selection = '', chapterId = null, variant = 'v3', forceIntent = null, presetRoute = null }) {
  const t0 = Date.now();
  const r = presetRoute ? { ...presetRoute, by: 'preset', ms: 0 } : forceIntent ? { intent: forceIntent, keywords: [], by: 'forced', ms: 0 } : await route({ question, selection, chapterId });
  const trace = [{ step: '路由', detail: `${INTENT_LABEL[r.intent]}${r.by === 'rule' ? '（规则层）' : ''}${r.keywords?.length ? ` · 关键词：${r.keywords.join('、')}` : ''}`, ms: r.ms, reason: r.reason }];
  const out = await runSkill(r.intent, { question, selection, chapterId: r.chapter || chapterId, keywords: r.keywords, variant });
  trace.push(...out.trace);
  const verified = verifyAll(out.result || {});
  const v = verified.verification;
  if (v.total > 0 || r.intent !== 'off_topic') {
    trace.push({ step: '引用核验', detail: v.total ? `${v.verified} 条逐字核验通过${v.relocated ? `，${v.relocated} 条自动纠正段落` : ''}${v.dropped ? `，${v.dropped} 条对不上已移除` : ''}${v.copyFlag ? '；检测到大段原文，已提示' : ''}` : '本次回答无引用', ms: 0 });
  }
  return {
    intent: r.intent,
    intentLabel: INTENT_LABEL[r.intent],
    routeReason: r.reason,
    routeBy: r.by,
    routeKeywords: r.keywords,
    routeChapter: r.chapter || null,
    chapterTitle: out.chapterTitle,
    usedChapter: out.chapterId,
    anchor: out.anchor,
    hits: out.hits || [],
    ...verified,
    trace,
    totalMs: Date.now() - t0,
  };
}

const INTENT_LABEL = { book_qa: '书内问答', explain: '划线解释', summary: '章节摘要', quiz: '读后出题', off_topic: '书外请求' };

module.exports = { ask, route, retrieve, verifyCitation, label, book, PARAS, BY_ID, INTENT_LABEL, PROMPTS };
