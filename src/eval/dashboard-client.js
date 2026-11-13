const byId = (id) => document.getElementById(id);
const { runs, skipped, reportBase } = JSON.parse(byId("evaluation-data").textContent);
const baseline = byId("baseline"), candidate = byId("candidate"), attempt = byId("attempt"), suiteFilter = byId("suite-filter"), trendMetric = byId("trend-metric");
const names = { improved: "改善", regressed: "退化", mixed: "有得有失", same: "持平", unavailable: "暂不判定" };
const statusNames = { passed: "通过", quality_failed: "质量未过", generation_failed: "生成失败", evaluation_failed: "评测失败", blocked: "受阻", interrupted: "中断", running: "运行中", pending: "待运行" };
const statusLabel = (sample) => sample.attempt?.stage === "environment" ? "环境缺口"
  : sample.attempt?.stage === "provider" ? "模型服务失败" : statusNames[statusOf(sample)] ?? statusOf(sample);
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const unknown = "—";
const metric = (key) => performanceMetrics.find((definition) => definition.key === key);
let selectedCase;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function option(select, value, label) {
  const item = element("option", label); item.value = value; select.append(item);
}

function number(value) { return value === undefined ? unknown : integer.format(value); }
function display(value, unit) {
  if (value === undefined) return unknown;
  if (unit === "yuan") return `¥${value.toFixed(4)}`;
  if (unit === "seconds") return `${number(value)} 秒`;
  return `${number(value)}${unit === "percent" ? "%" : ""}`;
}
function reading(value, unit) {
  if (!value) return unknown;
  return `${display(value.value, unit)}${value.total === undefined ? "" : `（${value.n}/${value.total}）`}`;
}
function difference(definition, left, right, enabled) {
  if (!enabled || !left || !right) return element("span", unknown, "small muted");
  const value = right.value - left.value;
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  const good = definition.direction === "up" ? value > 0 : value < 0;
  const unit = definition.unit;
  const label = unit === "percent" ? `${number(Math.abs(value))} 个百分点` : display(Math.abs(value), unit);
  return element("span", prefix + label, `small delta ${Math.abs(value) < 1e-9 ? "muted" : good ? "up" : "down"}`);
}
function reportLink(run, label = "查看报告") {
  const link = element("a", label);
  link.href = `${reportBase || "."}/${encodeURIComponent(run.id)}/report.md`;
  return link;
}
function tag(text, kind) { return element("span", text, `tag ${kind}`); }
function summary(run) {
  const versions = run.sourceVersions.filter(Boolean).map((hash) => hash.slice(0, 10));
  const detail = element("div", undefined, "small muted");
  detail.append(element("span", `${run.suite}@${run.suiteVersion} · ${run.model} · ${run.environment}`, "small"));
  const source = versions.length ? `${versions.join(" / ")}${run.sourceVersions.includes("") ? " / 未记录" : ""}` : "未记录";
  detail.append(element("span", `${run.prompt} · 源码 ${source} · ${run.cases.length}/${run.suiteSize} 个套件案例`, "small"), reportLink(run));
  return detail;
}
function pickBaseline(current) {
  const prior = runs.slice(runs.indexOf(current) + 1);
  const matches = prior.map((run) => ({ run, pair: pairCases(run, current, attempt.value) }))
    .filter(({ pair }) => !pair.reasons.length && pair.eligible.length);
  return matches.find(({ run, pair }) => pair.eligible.length === current.cases.length && run.cases.length === current.cases.length && !pair.rubricChanged)?.run
    ?? matches.find(({ pair }) => !pair.rubricChanged)?.run ?? matches[0]?.run
    ?? prior.find((run) => run.environmentKey === current.environmentKey && run.suite === current.suite) ?? current;
}
function pickCandidate(run) {
  candidate.value = run.id;
  baseline.value = pickBaseline(run).id;
  selectedCase = undefined;
  render();
}

function caseRow(left, right, verdict, note) {
  const task = (right ?? left).task;
  const tr = element("tr"), first = element("td", undefined, "name");
  const button = element("button", task.title, "plain");
  button.onclick = () => { selectedCase = { left, right }; renderCaseDetail(); };
  first.append(button, element("span", task.id, "hint")); tr.append(first);
  const series = (render) => `${left ? render(left) : unknown} → ${right ? render(right) : unknown}`;
  const cells = [series(statusLabel),
    series((s) => `${number(timedDays(s))}/${s.task.expectedDays}`),
    series((s) => { const v = s.attempt?.delivery?.requiredVisits; return s.task.requiredVisits ? `${number(v?.scheduled ?? (timedDays(s) === 0 ? 0 : undefined))}/${s.task.requiredVisits}` : unknown; }),
    series((s) => s.attempt?.issues ? `${s.attempt.issues.P0} / ${s.attempt.issues.P1}` : unknown),
    series((s) => number(s.attempt?.calls))];
  for (const cell of cells) tr.append(element("td", cell, "num"));
  const last = element("td"); last.append(tag(note ?? names[verdict], verdict)); tr.append(last);
  return tr;
}
function renderCaseDetail() {
  const box = byId("case-detail");
  box.hidden = !selectedCase;
  box.replaceChildren();
  if (!selectedCase) return;
  const { left, right } = selectedCase;
  box.append(element("h3", (right ?? left).task.title));
  const columns = element("div");
  for (const [label, sample] of [["参照", left], ["待评", right]]) {
    const column = element("article");
    column.append(element("strong", `${label}${sample?.attempt ? ` · attempt ${sample.attempt.number}` : ""}`));
    if (sample?.attempt) {
      const a = sample.attempt;
      column.append(element("p", `保存日程 ${number(a.savedDays)} 天 · 粗排 ${number(a.basicDays)} 天 · 可行性已查 ${number(a.checkedDays)} 天 · 日内达标 ${number(a.readyDays)} 天`, "muted"));
      if (a.reason) column.append(element("p", a.reason));
      if (a.issueCodes?.length) column.append(element("p", a.issueCodes.join("、"), "muted"));
      if (a.checks?.failed.length) column.append(element("p", a.checks.failed.join("；")));
    } else column.append(element("p", "本批次无该案例结果", "muted"));
    columns.append(column);
  }
  box.append(columns);
}

function renderMetrics(before, after, comparison, sameRun) {
  const disabled = comparison.reasons.length > 0 || sameRun;
  const values = (definition) => {
    if (sameRun || comparison.eligible.length === 0 || disabled) {
      return { before: definition.read(selectSamples(before, attempt.value)), after: definition.read(selectSamples(after, attempt.value)), paired: 0 };
    }
    return readPair(definition, comparison.eligible);
  };
  const cards = byId("cards"); cards.replaceChildren();
  for (const key of ["strict", "days", "must", "calls"]) {
    const definition = metric(key), v = values(definition), card = element("article", undefined, "panel card");
    card.append(element("h3", definition.label), element("div", reading(v.after, definition.unit), "value"));
    const label = element("p", undefined, "muted");
    label.append(document.createTextNode(`参照 ${reading(v.before, definition.unit)}　`), difference(definition, v.before, v.after, !disabled && v.paired > 0));
    card.append(label); cards.append(card);
  }
  const panels = byId("metrics"); panels.replaceChildren();
  for (const group of ["交付", "质量与证据", "效率"]) {
    const panel = element("article", undefined, "panel metric-group"), list = element("div", undefined, "metric-list");
    panel.append(element("h3", group), list); panels.append(panel);
    for (const definition of performanceMetrics.filter((d) => d.group === group)) {
      const v = values(definition), row = element("div", undefined, "metric-row");
      const title = element("span", definition.label, "metric-title"); title.title = definition.description;
      row.append(title, difference(definition, v.before, v.after, !disabled && v.paired > 0 && (!definition.price || before.pricing === after.pricing)));
      const nums = element("div", undefined, "metric-numbers num");
      nums.append(element("span", undefined, "mark"), element("span", reading(v.before, definition.unit)), element("span", undefined, "mark after"), element("span", reading(v.after, definition.unit)));
      if (v.paired > 0) nums.append(element("span", `${v.paired} 对`, "small muted"));
      else if (!disabled && comparison.eligible.length) nums.append(element("span", "缺共同数据或评分口径不同", "small muted"));
      row.append(nums);
      const max = definition.unit === "percent" ? 100 : Math.max(v.before?.value ?? 0, v.after?.value ?? 0, 1);
      const bars = element("div", undefined, "metric-bars"); bars.setAttribute("aria-hidden", "true");
      for (const [reading, cls] of [[v.before, "bar"], [v.after, "bar after"]]) {
        const track = element("div", undefined, cls), fill = element("span");
        fill.style.width = `${Math.min(100, (reading?.value ?? 0) / max * 100)}%`; track.append(fill); bars.append(track);
      }
      row.append(bars); list.append(row);
    }
  }
}

function renderHistory() {
  const table = byId("history"); table.replaceChildren();
  for (const run of runs.filter((r) => !suiteFilter.value || r.suite === suiteFilter.value)) {
    const samples = selectSamples(run, attempt.value), tr = element("tr"), name = element("td");
    const button = element("button", run.id, "plain"); button.onclick = () => pickCandidate(run);
    name.append(button, element("span", Number.isFinite(Date.parse(run.created)) ? shortDate.format(new Date(run.created)) : run.created, "hint"));
    const costs = run.cases.flatMap((c) => c.attempts.map((a) => a.cost)).filter((v) => Number.isFinite(v));
    const cells = [run.prompt + " · " + run.environment, `${run.cases.length}/${run.suiteSize}`,
      reading(metric("strict").read(samples), "percent"), reading(metric("days").read(samples), "percent"),
      display(costs.length ? costs.reduce((sum, v) => sum + v, 0) : undefined, "yuan")];
    tr.append(name);
    for (const value of cells) tr.append(element("td", value, "num"));
    const link = element("td"); link.append(reportLink(run)); tr.append(link); table.append(tr);
  }
}

function renderTrend(current) {
  if (!current) return;
  const definition = metric(trendMetric.value), box = byId("trend");
  box.replaceChildren();
  const measured = runs.slice(runs.indexOf(current)).flatMap((run) => {
    const paired = pairCases(run, current, attempt.value);
    if (paired.reasons.length || paired.eligible.length !== current.cases.length || definition.price && run.pricing !== current.pricing) return [];
    const values = readPair(definition, paired.eligible);
    return values.before && values.paired === current.cases.length ? [{ run, value: values.before }] : [];
  }).reverse();
  box.append(element("p", `${current.cases.length} 个相同案例 · ${measured.length} 个批次 · 点击批次设为参照`, "small muted"));
  if (measured.length < 2) box.append(element("p", "尚无第二个同条件且有完整指标的批次。", "small muted"));
  const max = definition.unit === "percent" ? 100 : Math.max(1, ...measured.map(({ value }) => value.value));
  for (const { run, value } of measured) {
    const row = element("div", undefined, `trend-row${run.id === current.id ? " current" : ""}`);
    const button = element("button", run.id, "plain"); button.onclick = () => { baseline.value = run.id; selectedCase = undefined; render(); };
    const bar = element("div", undefined, `bar${run.id === current.id ? " after" : ""}`), fill = element("span");
    fill.style.width = `${Math.min(100, value.value / max * 100)}%`; bar.append(fill); bar.setAttribute("aria-hidden", "true");
    row.append(button, bar, element("span", reading(value, definition.unit), "num")); box.append(row);
  }
}

function render() {
  const before = runs.find((r) => r.id === baseline.value), after = runs.find((r) => r.id === candidate.value);
  if (!before || !after) return;
  const sameRun = before.id === after.id, comparison = pairCases(before, after, attempt.value);
  const verdicts = comparison.eligible.map(caseVerdict), veto = sameRun || comparison.reasons.length > 0;
  const gains = verdicts.filter((v) => v === "improved").length, losses = verdicts.filter((v) => v === "regressed").length, mixed = verdicts.filter((v) => v === "mixed").length;
  const unknowns = verdicts.filter((v) => v === "unavailable").length;
  const kind = veto || !verdicts.length || unknowns === verdicts.length ? "unavailable" : mixed || gains && losses ? "mixed" : gains ? "improved" : losses ? "regressed" : "same";
  byId("metadata").replaceChildren(summary(before), summary(after));
  const message = sameRun ? "选择另一批次查看版本变化。" : `${comparison.eligible.length} 个同条件案例，${comparison.onlyBefore.length} 个仅参照有，${comparison.onlyAfter.length} 个仅待评有。`;
  const notes = [message, ...comparison.reasons];
  if (!veto && verdicts.length) notes.push(`${gains} 改善 · ${losses} 退化 · ${mixed} 有得有失 · ${unknowns} 暂不判定`);
  if (comparison.rubricChanged) notes.push("部分案例评分口径不同，相关指标不计算差值。");
  if (before.pricing !== after.pricing) notes.push("价格配置不同，成本只展示读数。");
  if (!sameRun && after.environmentKey === "online") notes.push("在线数据和模型结果可能波动。");
  byId("verdict").replaceChildren(tag(names[kind], kind), element("span", notes.join(" "), "small"));
  renderMetrics(before, after, comparison, sameRun);
  const table = byId("case-rows"); table.replaceChildren();
  for (const pair of comparison.pairs) table.append(caseRow(pair.before, pair.after, veto ? "unavailable" : caseVerdict(pair), pair.reason));
  for (const sample of comparison.onlyBefore) table.append(caseRow(sample, undefined, "unavailable", "仅参照批次"));
  for (const sample of comparison.onlyAfter) table.append(caseRow(undefined, sample, "unavailable", "仅待评批次"));
  byId("case-hint").textContent = "点击案例查看失败原因和独立需求检查";
  renderCaseDetail(); renderTrend(after); renderHistory();
}

byId("inventory").textContent = `${runs.length} 个批次${skipped.length ? ` · ${skipped.length} 个旧格式或不可读批次` : ""}`;
if (skipped.length) byId("inventory").title = skipped.join("、");
if (!runs.length) byId("empty").hidden = false;
else {
  byId("dashboard").hidden = false;
  for (const run of runs) for (const select of [baseline, candidate]) option(select, run.id, `${run.id} · ${run.prompt} · ${run.cases.length} 案例`);
  option(suiteFilter, "", "全部套件");
  for (const name of [...new Set(runs.map((r) => r.suite))].sort()) option(suiteFilter, name, name);
  for (const key of ["days", "strict", "must", "calls", "time0.5", "cost"]) option(trendMetric, key, metric(key).label);
  candidate.onchange = () => pickCandidate(runs.find((r) => r.id === candidate.value));
  baseline.onchange = attempt.onchange = () => { selectedCase = undefined; render(); };
  suiteFilter.onchange = renderHistory;
  trendMetric.onchange = () => renderTrend(runs.find((r) => r.id === candidate.value));
  pickCandidate(runs.find((r) => r.environmentKey === "online") ?? runs[0]);
}
