// 书伴评测：同一套题，对比「裸模型 / Prompt v1 / v2 / v3」四个版本
// 运行：npm run eval   结果写入 eval/results.json，评测看板 /eval 读取
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const { chat, MODEL } = require('../lib/llm');

const cases = require('./cases.json');
const QA_TYPES = new Set(['fact', 'absent', 'premise']);
const CONC = 4;

async function pool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; }
      process.stdout.write('.');
    }
  }));
  return out;
}

const JUDGE = `你是阅读类 AI 产品的评测员，负责给"读书助手"的回答打分。你会拿到：题目类型、用户问题、参考答案、原文依据段落、被评回答。
评分规则：
- correct：1=与参考答案一致且没有错误信息；0.5=大体对但有遗漏或夹带少量不准确内容；0=答错、答非所问或编造。
  - 类型 absent（书中没有答案）：明确说出"书中没有提到/作者不知道"才算 1；给出具体答案（编造）算 0。
  - 类型 premise（问题前提有误）：明确指出前提错误并按原文纠正才算 1；顺着错误前提解释算 0。
- hallucination：回答中是否出现原文依据和参考答案都无法支持、且与原著不符的具体情节或细节（true/false）。书外常识若明确标注为书外，不算幻觉。
只输出 JSON：{"correct":1,"hallucination":false,"reason":"一句话理由"}`;

async function judge(c, answerText) {
  const gold = c.gold.map((id) => `[${agent.label(id)}] ${agent.BY_ID.get(id)?.text || ''}`).join('\n') || '（无，书中没有相关内容）';
  const r = await chat([
    { role: 'system', content: JUDGE },
    { role: 'user', content: `题目类型：${c.type}\n用户问题：${c.q}\n参考答案：${c.ref}\n原文依据：\n${gold}\n\n被评回答：${answerText}` },
  ], { json: true, temperature: 0, maxTokens: 300 });
  return r.data;
}

function answerText(r) {
  let t = r.answer || '';
  if (r.premise_issue) t = `【前提提示】${r.premise_issue}\n${t}`;
  if (r.outside) t += `\n【书外补充（已标注）】${r.outside}`;
  return t;
}

(async () => {
  const started = Date.now();
  console.log(`评测开始：${cases.length} 题，模型 ${MODEL}`);

  // 1) 当前版本 v3 全链路（路由 + 技能 + 核验）跑全部题目
  const v3all = await pool(cases, async (c) => {
    const t0 = Date.now();
    const r = await agent.ask({ question: c.q, selection: c.selection || '', chapterId: c.chapter ?? null, variant: 'v3' });
    return { ...r, ms: Date.now() - t0 };
  });
  const v2 = v3all; // 路由/技能类指标都取当前版本
  console.log('\nv3 完成');

  // 2) 问答类题目再跑历史版本：用同一份路由结果，只比较策略差异
  const qa = cases.filter((c) => QA_TYPES.has(c.type));
  const v3qa = qa.map((c) => v3all[cases.indexOf(c)]);
  const runVariant = (variant) => pool(qa, async (c, i) => {
    const t0 = Date.now();
    const pr = v3qa[i] || {};
    const r = await agent.ask({ question: c.q, variant, presetRoute: { intent: 'book_qa', keywords: pr.routeKeywords || [], chapter: pr.routeChapter || null } });
    return { ...r, ms: Date.now() - t0 + (pr.trace?.[0]?.ms || 0) };
  });
  const bare = await runVariant('bare');
  console.log('\n裸模型完成');
  const v1 = await runVariant('v1');
  console.log('\nv1 完成');
  const v2qa = await runVariant('v2');
  console.log('\nv2 完成');

  // 3) LLM-as-Judge
  const judgeAll = (runs) => pool(qa, (c, i) => (runs[i]?.error ? Promise.resolve({ correct: 0, hallucination: false, reason: '运行出错' }) : judge(c, answerText(runs[i]))));
  const [jBare, jV1, jV2, jV3] = [await judgeAll(bare), await judgeAll(v1), await judgeAll(v2qa), await judgeAll(v3qa)];
  console.log('\n评分完成');

  // 4) 汇总
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const byType = (judges, type) => mean(qa.map((c, i) => [c, judges[i]]).filter(([c]) => c.type === type).map(([, j]) => +j.correct || 0));
  const halluc = (judges) => mean(judges.map((j) => (j.hallucination ? 1 : 0)));
  const lat = (runs) => mean(runs.filter((r) => r && !r.error).map((r) => r.ms));

  const cites = v2.flatMap((r) => (r && r.verification ? [r.verification] : []));
  const citeTotal = cites.reduce((a, v) => a + v.total, 0);
  const citeOk = cites.reduce((a, v) => a + v.verified + v.relocated, 0);
  const citeRel = cites.reduce((a, v) => a + v.relocated, 0);
  const citeDrop = cites.reduce((a, v) => a + v.dropped, 0);
  const factCases = qa.filter((c) => c.type === 'fact');
  const goldHit = mean(factCases.map((c) => {
    const r = v2[cases.indexOf(c)];
    const ids = (r.citations || []).map((x) => x.para);
    return ids.some((id) => c.gold.includes(id)) ? 1 : 0;
  }));
  const routeRows = cases.map((c, i) => {
    const r = v2[i] || {};
    const okIntent = r.intent === c.expect || (c.alt || []).includes(r.intent);
    const okChapter = c.expectChapter ? r.usedChapter === c.expectChapter : true;
    return { id: c.id, expect: c.expect, got: r.intent, okIntent, okChapter, ok: okIntent && okChapter };
  });

  const configs = [
    { key: 'bare', name: '裸模型', desc: '不给原文，直接问大模型（模拟通用 AI 问答）', judges: jBare, runs: bare },
    { key: 'v1', name: 'Prompt v1', desc: '给检索到的原文，但没有引用/拒答/前提校验约束', judges: jV1, runs: v1 },
    { key: 'v2', name: '书伴 v2', desc: '加引用约束、拒答、前提校验、逐字核验（检索仍是全书 top-8）', judges: jV2, runs: v2qa },
    { key: 'v3', name: '书伴 v3', desc: 'v2 + 章节全文上下文 + 拒答前扩大范围复查', judges: jV3, runs: v3qa },
  ].map((x) => ({
    key: x.key, name: x.name, desc: x.desc,
    metrics: {
      fact: byType(x.judges, 'fact'),
      absent: byType(x.judges, 'absent'),
      premise: byType(x.judges, 'premise'),
      overall: mean(x.judges.map((j) => +j.correct || 0)),
      hallucination: halluc(x.judges),
      latencyMs: lat(x.runs),
    },
  }));

  const details = qa.map((c, i) => ({
    id: c.id, type: c.type, q: c.q, ref: c.ref,
    runs: {
      bare: { answer: bare[i]?.answer, ...jBare[i] },
      v1: { answer: v1[i]?.answer, ...jV1[i] },
      v2: { answer: v2qa[i]?.answer, premise_issue: v2qa[i]?.premise_issue, ...jV2[i] },
      v3: { answer: v3qa[i]?.answer, premise_issue: v3qa[i]?.premise_issue, citations: (v3qa[i]?.citations || []).map((x) => ({ label: x.label, quote: x.quote, status: x.status })), recheck: (v3qa[i]?.trace || []).some((t) => t.step === '拒答前复查'), ...jV3[i] },
    },
  }));
  const skillRows = cases.filter((c) => !QA_TYPES.has(c.type)).map((c) => {
    const r = v2[cases.indexOf(c)] || {};
    return { id: c.id, type: c.type, q: c.q || `（划线）${c.selection}`, selection: c.selection, intent: r.intent, chapter: r.chapterTitle, answer: r.answer, points: (r.points || []).map((p) => p.text), quiz: (r.quiz || []).map((q) => q.q), outside: r.outside, verification: r.verification };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    judgeModel: MODEL,
    caseCount: cases.length,
    qaCount: qa.length,
    durationSec: Math.round((Date.now() - started) / 1000),
    configs,
    v2Extra: {
      routeAccuracy: mean(routeRows.map((r) => (r.ok ? 1 : 0))),
      citeTotal, citeOk, citeRel, citeDrop,
      citeVerifyRate: citeTotal ? citeOk / citeTotal : null,
      goldHitRate: goldHit,
    },
    routeRows,
    details,
    skillRows,
  };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(result, null, 1));
  console.log('\n汇总：');
  for (const c of configs) console.log(c.name, Object.entries(c.metrics).map(([k, v]) => `${k}=${v == null ? '-' : k === 'latencyMs' ? Math.round(v) : (v * 100).toFixed(0) + '%'}`).join(' '));
  console.log('路由准确率', (result.v2Extra.routeAccuracy * 100).toFixed(0) + '%', '引用核验', `${citeOk}/${citeTotal}`, '纠正', citeRel, '移除', citeDrop, '依据命中', (goldHit * 100).toFixed(0) + '%');
  routeRows.filter((r) => !r.ok).forEach((r) => console.log('路由错误', r));
  console.log(`用时 ${result.durationSec}s`);
})();
