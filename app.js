'use strict';

const CATALOG = [
  { id: 'tv55',     name: '55" 4K Smart TV',    price: 49999, cost: 32000, stock: 180, dailySell: 4,  elasticity: -1.8, competitorPrice: 47500, subGroup: 'tv',      complement: 'soundbar' },
  { id: 'soundbar', name: 'Premium Soundbar',    price: 14999, cost: 7500,  stock: 220, dailySell: 3,  elasticity: -1.4, competitorPrice: 15500, subGroup: 'audio',   complement: null },
  { id: 'laptop15', name: '15" Laptop (i5)',     price: 64999, cost: 42000, stock: 90,  dailySell: 2,  elasticity: -1.2, competitorPrice: 61999, subGroup: 'laptop',  complement: 'bag' },
  { id: 'bag',      name: 'Laptop Bag (15")',    price: 1999,  cost: 700,   stock: 450, dailySell: 8,  elasticity: -0.9, competitorPrice: 1799,  subGroup: 'bags',    complement: null },
  { id: 'wh1000',   name: 'WH-1000 Headphones', price: 24999, cost: 13000, stock: 130, dailySell: 5,  elasticity: -1.6, competitorPrice: 26999, subGroup: 'audio',   complement: null },
  { id: 'micro4k',  name: 'Mirrorless 4K Cam',  price: 89999, cost: 61000, stock: 40,  dailySell: 1,  elasticity: -1.1, competitorPrice: 92000, subGroup: 'camera',  complement: null },
  { id: 'ipad11',   name: '11" Tablet Pro',      price: 79999, cost: 52000, stock: 75,  dailySell: 3,  elasticity: -1.3, competitorPrice: 81999, subGroup: 'tablet',  complement: null },
  { id: 'kindle',   name: 'E-Reader Oasis',      price: 12999, cost: 7200,  stock: 310, dailySell: 9,  elasticity: -1.5, competitorPrice: 11999, subGroup: 'ereader', complement: null },
];

const REGIONS = [
  { name: 'North', intensity: 1.10 },
  { name: 'South', intensity: 0.90 },
  { name: 'West',  intensity: 1.05 },
  { name: 'East',  intensity: 0.95 },
];

const DISCOUNT_DEPTHS    = [5, 10, 15, 20, 25, 30, 35, 40];
const DURATIONS          = [3, 7, 14];
const CANNIB_RATE        = 0.18;
const HALO_RATE          = 0.08;
const CLEARANCE_BONUS    = 0.25;
const STOCK_COVER_THRESH = 45;
const MC_ITERATIONS      = 300;

let currentPlan   = null;
let agentTrace    = [];
let plannerTrace  = [];

const fmt = {
  inr:  v => '₹' + Math.round(v).toLocaleString('en-IN'),
  pct:  v => v.toFixed(1) + '%',
  num:  v => Math.round(v).toLocaleString('en-IN'),
  dec:  v => v.toFixed(2),
};

function rand(min, max) { return Math.random() * (max - min) + min; }

function runPlanningAgent(catalog, constraints) {
  plannerTrace = [];
  const log = msg => plannerTrace.push(msg);

  const { marginFloor, budget, seasonMult, competitorOverrides } = constraints;
  log(`▶ Planning Agent started`);
  log(`  margin floor: ${marginFloor}%  |  budget: ${fmt.inr(budget)}  |  season: ×${seasonMult}`);

  const effectiveCatalog = catalog.map(p => {
    const override = competitorOverrides && competitorOverrides[p.id];
    return override ? { ...p, competitorPrice: override } : p;
  });

  log(`\n── Step 1: Scoring discount×duration candidates`);
  const candidates = [];

  for (const product of effectiveCatalog) {
    const baselineMargin = (product.price - product.cost) / product.price * 100;
    const stockCoverDays  = product.stock / product.dailySell;
    const isOverstocked   = stockCoverDays >= STOCK_COVER_THRESH;

    for (const depth of DISCOUNT_DEPTHS) {
      for (const dur of DURATIONS) {
        const discountedPrice = product.price * (1 - depth / 100);
        const promoMargin     = (discountedPrice - product.cost) / discountedPrice * 100;

        if (promoMargin < marginFloor) continue;

        const compFactor = Math.min(1.5, Math.max(0.7,
          product.competitorPrice / discountedPrice));

        const upliftFactor = Math.pow(1 - depth / 100, product.elasticity) * compFactor * seasonMult - 1;
        const extraUnits   = product.dailySell * dur * Math.max(0, upliftFactor);
        const promoProfit  = extraUnits * (discountedPrice - product.cost);

        const cannibCost = promoProfit * CANNIB_RATE;

        let haloProfit = 0;
        if (product.complement) {
          const comp = effectiveCatalog.find(p => p.id === product.complement);
          if (comp) haloProfit = comp.dailySell * dur * (comp.price - comp.cost) * HALO_RATE;
        }

        const clearanceBonus = isOverstocked ? promoProfit * CLEARANCE_BONUS : 0;

        const netProfit   = promoProfit - cannibCost + haloProfit + clearanceBonus;
        const spendNeeded = extraUnits * product.price * (depth / 100);
        const score       = spendNeeded > 0 ? netProfit / spendNeeded : 0;

        candidates.push({
          product, depth, dur,
          discountedPrice, promoMargin, extraUnits,
          promoProfit, cannibCost, haloProfit, clearanceBonus,
          netProfit, spendNeeded, score, stockCoverDays,
          isOverstocked, compFactor, upliftFactor
        });
      }
    }

    log(`  ${product.name}: baseline margin ${baselineMargin.toFixed(1)}%, stock cover ${stockCoverDays.toFixed(0)}d`);
  }
  log(`  → ${candidates.length} valid candidates generated`);

  log(`\n── Step 2: Best candidate per product`);
  const bestPerProduct = {};
  for (const c of candidates) {
    const key = c.product.id;
    if (!bestPerProduct[key] || c.score > bestPerProduct[key].score) {
      bestPerProduct[key] = c;
    }
  }

  log(`\n── Step 3: Budget fill (greedy + repair)`);
  let ranked = Object.values(bestPerProduct).sort((a, b) => b.score - a.score);
  let remaining = budget;
  const selected = [];

  for (const c of ranked) {
    if (c.spendNeeded <= remaining) {
      selected.push({ ...c });
      remaining -= c.spendNeeded;
      log(`  ✓ ${c.product.name}: ${c.depth}% × ${c.dur}d  spend ${fmt.inr(c.spendNeeded)}`);
    } else {
      const steps = DISCOUNT_DEPTHS.filter(d => d < c.depth).reverse();
      let repaired = false;
      for (const d of steps) {
        const discountedPrice = c.product.price * (1 - d / 100);
        const promoMargin     = (discountedPrice - c.product.cost) / discountedPrice * 100;
        if (promoMargin < marginFloor) continue;
        const upliftFactor = Math.pow(1 - d / 100, c.product.elasticity) * c.compFactor * seasonMult - 1;
        const extraUnits   = c.product.dailySell * c.dur * Math.max(0, upliftFactor);
        const spend        = extraUnits * c.product.price * (d / 100);
        if (spend <= remaining) {
          const promoProfit   = extraUnits * (discountedPrice - c.product.cost);
          const netProfit     = promoProfit - promoProfit * CANNIB_RATE;
          selected.push({ ...c, depth: d, discountedPrice, promoMargin, extraUnits, spendNeeded: spend, netProfit });
          remaining -= spend;
          log(`  ↓ ${c.product.name}: repaired to ${d}%  spend ${fmt.inr(spend)}`);
          repaired = true;
          break;
        }
      }
      if (!repaired) log(`  ✗ ${c.product.name}: skipped (cannot fit even at min discount)`);
    }
  }
  log(`  Budget used: ${fmt.inr(budget - remaining)} / ${fmt.inr(budget)}`);

  log(`\n── Step 4: Assign mechanism & audience`);
  for (const s of selected) {
    s.mechanism = assignMechanism(s);
    s.audience  = assignAudience(s);
    s.whyText   = buildWhyText(s);
    log(`  ${s.product.name}: ${s.mechanism} → ${s.audience}`);
  }

  log(`\n── Step 5: Regional discount deltas`);
  for (const s of selected) {
    s.regional = REGIONS.map(r => {
      const delta = Math.round((r.intensity - 1) * s.depth);
      return { region: r.name, discount: Math.max(0, s.depth + delta), delta };
    });
  }

  log(`\n── Step 6: Monte Carlo (${MC_ITERATIONS} iterations)`);
  const sim = runMonteCarlo(selected, budget, marginFloor, seasonMult);
  log(`  Margin pass rate: ${fmt.pct(sim.marginPassRate * 100)}`);
  log(`  Budget pass rate: ${fmt.pct(sim.budgetPassRate * 100)}`);
  log(`  P10 profit: ${fmt.inr(sim.p10)}, P50: ${fmt.inr(sim.p50)}, P90: ${fmt.inr(sim.p90)}`);

  const plan = { items: selected, simulation: sim, budgetUsed: budget - remaining, budget };
  log(`\n✅ Planning Agent complete — ${selected.length} products in plan`);
  return plan;
}

function assignMechanism(c) {
  if (c.isOverstocked && c.depth >= 20)        return 'clearance';
  if (c.product.complement && c.haloProfit > 0) return 'bundle';
  if (c.compFactor > 1.15)                      return 'price-match';
  if (c.dur === 3)                               return 'flash-sale';
  return 'tiered';
}

function assignAudience(c) {
  if (c.depth >= 25)                    return 'deal-seekers';
  if (c.mechanism === 'flash-sale')     return 'loyal-members';
  return 'new-and-lapsed';
}

function buildWhyText(c) {
  const parts = [];
  if (c.compFactor > 1.05)
    parts.push(`Undercuts competitor by ${fmt.inr(c.product.competitorPrice - c.discountedPrice)}.`);
  if (c.cannibCost > 0)
    parts.push(`Cannibalises ~${fmt.inr(c.cannibCost)} from siblings.`);
  if (c.haloProfit > 0)
    parts.push(`+${fmt.inr(c.haloProfit)} halo on ${c.product.complement}.`);
  if (c.isOverstocked)
    parts.push(`Overstocked (${c.stockCoverDays.toFixed(0)}d cover). Clearance bonus active.`);
  return parts.join(' ') || 'Positive net value at margin floor.';
}

function runMonteCarlo(selected, budget, marginFloor, seasonMult) {
  const profits = [], marginPasses = [], budgetPasses = [];

  for (let i = 0; i < MC_ITERATIONS; i++) {
    let totalProfit = 0, totalSpend = 0, allMarginOk = true;

    for (const s of selected) {
      const demandMult    = rand(0.85, 1.15);
      const elasticityRnd = s.product.elasticity * rand(0.90, 1.10);
      const uplift        = Math.pow(1 - s.depth / 100, elasticityRnd) * s.compFactor * seasonMult - 1;
      const extraUnits    = s.product.dailySell * s.dur * Math.max(0, uplift) * demandMult;
      const discPrice     = s.discountedPrice;
      const margin        = (discPrice - s.product.cost) / discPrice * 100;

      if (margin < marginFloor) allMarginOk = false;
      totalProfit += extraUnits * (discPrice - s.product.cost);
      totalSpend  += extraUnits * s.product.price * (s.depth / 100);
    }

    profits.push(totalProfit);
    marginPasses.push(allMarginOk ? 1 : 0);
    budgetPasses.push(totalSpend <= budget ? 1 : 0);
  }

  profits.sort((a, b) => a - b);
  return {
    p10: profits[Math.floor(MC_ITERATIONS * 0.10)],
    p50: profits[Math.floor(MC_ITERATIONS * 0.50)],
    p90: profits[Math.floor(MC_ITERATIONS * 0.90)],
    marginPassRate: marginPasses.reduce((a, b) => a + b, 0) / MC_ITERATIONS,
    budgetPassRate: budgetPasses.reduce((a, b) => a + b, 0) / MC_ITERATIONS,
  };
}

async function runConstraintsAgent(plan, stakeholderNote) {
  agentTrace = [];
  const log = msg => agentTrace.push(msg);
  log(`▶ Business-Constraints Agent started`);
  log(`  Stakeholder note: "${stakeholderNote}"`);

  const planJSON = plan.items.map(s => ({
    product:        s.product.name,
    discount_pct:   s.depth,
    duration_days:  s.dur,
    mechanism:      s.mechanism,
    audience:       s.audience,
    net_profit_est: Math.round(s.netProfit),
  }));

  const prompt = `You are a business-constraints review agent for a retail promotion plan.
Proposed plan (JSON): ${JSON.stringify(planJSON, null, 2)}
Business context from a stakeholder: "${stakeholderNote}"

Decide, per product in the plan, whether to KEEP, ADJUST (lower the discount, say to what %) or VETO (cancel) the promotion based on this context.

Respond ONLY with JSON:
{"decisions":[{"product":"","action":"keep|adjust|veto","new_discount_pct":null,"reason":""}],"summary":""}
No markdown, no prose outside the JSON.`;

  log(`  Sending prompt to LLM (${planJSON.length} products)`);

  let rawResponse = '';
  try {
    if (typeof window.agy !== 'undefined' && window.agy.sample) {
      rawResponse = await window.agy.sample(prompt, { modelTier: 'default' });
    } else if (typeof anthropic !== 'undefined') {
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      });
      rawResponse = res.content[0].text;
    } else {
      rawResponse = buildMockLLMResponse(planJSON, stakeholderNote);
      log(`  [DEMO MODE] Using rule-based mock instead of live LLM`);
    }

    log(`  Raw response received (${rawResponse.length} chars)`);

    let jsonText = rawResponse.trim();
    if (!jsonText.startsWith('{')) {
      const match = jsonText.match(/\{[\s\S]*\}/);
      if (match) { jsonText = match[0]; log(`  ⚠ Extracted JSON block from prose`); }
      else throw new Error('No JSON found in LLM response');
    }

    const parsed = JSON.parse(jsonText);
    log(`\n  Decisions:`);
    for (const d of parsed.decisions) {
      log(`    ${d.product}: ${d.action.toUpperCase()}${d.action === 'adjust' ? ' → ' + d.new_discount_pct + '%' : ''} — ${d.reason}`);
    }
    log(`\n  Summary: ${parsed.summary}`);
    log(`\n✅ Business-Constraints Agent complete`);
    return parsed;
  } catch (err) {
    log(`\n❌ Agent error: ${err.message}`);
    throw err;
  }
}

function buildMockLLMResponse(planJSON, note) {
  const noteLower = note.toLowerCase();
  const decisions = planJSON.map(item => {
    const nameLower = item.product.toLowerCase();

    if ((noteLower.includes('recall') || noteLower.includes('safety')) &&
        (nameLower.includes('camera') || nameLower.includes('laptop'))) {
      return { product: item.product, action: 'veto', new_discount_pct: null,
               reason: 'Potential safety recall mentioned — promotion paused pending confirmation.' };
    }
    if (noteLower.includes('brand') && noteLower.includes('premium') && item.discount_pct >= 30) {
      return { product: item.product, action: 'adjust', new_discount_pct: 20,
               reason: 'Brand premium-positioning policy prevents deep discounts above 25%.' };
    }
    if ((noteLower.includes('competitor') || noteLower.includes('sale')) && item.mechanism === 'price-match') {
      return { product: item.product, action: 'adjust', new_discount_pct: Math.max(5, item.discount_pct - 5),
               reason: 'Competitor sale confirmed — partial price match sufficient, no need to go lower.' };
    }
    if (noteLower.includes('legal') && nameLower.includes('headphone')) {
      return { product: item.product, action: 'veto', new_discount_pct: null,
               reason: 'Legal team flagged pending regulatory review on audio accessories in this region.' };
    }
    return { product: item.product, action: 'keep', new_discount_pct: null,
             reason: 'No conflict with stated business context.' };
  });
  const vetoes  = decisions.filter(d => d.action === 'veto').length;
  const adjusts = decisions.filter(d => d.action === 'adjust').length;
  const summary = `Reviewed ${decisions.length} promotions: ${decisions.length - vetoes - adjusts} kept, ${adjusts} adjusted, ${vetoes} vetoed. Constraint: "${note.slice(0, 80)}".`;
  return JSON.stringify({ decisions, summary });
}

function renderKPIs(plan) {
  const totalSpend  = plan.budgetUsed;
  const totalProfit = plan.items.reduce((s, i) => s + i.netProfit, 0);
  const totalUnits  = plan.items.reduce((s, i) => s + i.extraUnits, 0);
  const roi         = totalSpend > 0 ? totalProfit / totalSpend : 0;

  document.getElementById('kpi-profit').textContent   = fmt.inr(totalProfit);
  document.getElementById('kpi-spend').textContent    = fmt.inr(totalSpend);
  document.getElementById('kpi-roi').textContent      = fmt.dec(roi) + 'x';
  document.getElementById('kpi-units').textContent    = fmt.num(totalUnits);
  document.getElementById('kpi-products').textContent = plan.items.length;

  document.getElementById('kpi-strip').style.display = 'grid';
}

function mechanismIcon(m) {
  return { clearance: '🧹', bundle: '📦', 'price-match': '⚡', tiered: '🎯', 'flash-sale': '🔥' }[m] || '📌';
}

function renderPlanTable(plan, agentDecisions) {
  const tbody = document.getElementById('plan-tbody');
  tbody.innerHTML = '';

  const decMap = {};
  if (agentDecisions) {
    for (const d of agentDecisions.decisions) {
      const match = plan.items.find(i => i.product.name === d.product);
      if (match) decMap[match.product.id] = d;
    }
  }

  for (const item of plan.items) {
    const dec    = decMap[item.product.id];
    const action = dec ? dec.action : null;
    const effectiveDiscount = (action === 'adjust' && dec.new_discount_pct != null)
      ? dec.new_discount_pct : item.depth;

    const tr = document.createElement('tr');
    if (action) tr.className = `state-${action}`;

    let actionCell = '';
    if (action === 'veto')        actionCell = `<span class="tag tag-veto">Veto</span>`;
    else if (action === 'adjust') actionCell = `<span class="tag tag-adjust">Adj→${effectiveDiscount}%</span>`;
    else if (action === 'keep')   actionCell = `<span class="tag tag-keep">Keep</span>`;

    tr.innerHTML = `
      <td><strong>${item.product.name}</strong></td>
      <td><span class="tag tag-discount">${item.depth}%</span></td>
      <td>${item.dur}d</td>
      <td>${fmt.inr(item.discountedPrice)}</td>
      <td>${fmt.pct(item.promoMargin)}</td>
      <td>${fmt.num(Math.round(item.extraUnits))} u</td>
      <td>${fmt.inr(item.netProfit)}</td>
      <td>${fmt.inr(item.spendNeeded)}</td>
      <td>${mechanismIcon(item.mechanism)} <span class="tag tag-mech">${item.mechanism}</span></td>
      <td><span class="tag tag-seg">${item.audience}</span></td>
      <td class="wrap" style="color:var(--muted);font-size:12px">${item.whyText}</td>
      <td>${actionCell}</td>
      <td class="wrap" style="font-size:12px;color:var(--muted)">${dec ? dec.reason : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderRegional(plan) {
  const container = document.getElementById('regional-grid');
  container.innerHTML = '';

  for (const region of REGIONS) {
    const card = document.createElement('div');
    card.className = 'region-card';
    const rows = plan.items.map(item => {
      const rData = item.regional.find(r => r.region === region.name);
      const delta = rData ? rData.delta : 0;
      const sign  = delta > 0 ? '+' : '';
      const cls   = delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
      return `<div class="region-product">
        <span>${item.product.name.split(' ').slice(0, 2).join(' ')}</span>
        <span class="region-delta ${cls}">${rData ? rData.discount : item.depth}% (${sign}${delta}pp)</span>
      </div>`;
    }).join('');
    card.innerHTML = `<div class="region-name">${region.name}</div>${rows}`;
    container.appendChild(card);
  }
}

function renderSimulation(sim) {
  const maxVal = sim.p90 * 1.1 || 1;
  const pct = v => Math.max(0, Math.min(100, (v / maxVal) * 100)).toFixed(1) + '%';

  document.getElementById('sim-p10-fill').style.width  = pct(sim.p10);
  document.getElementById('sim-p50-fill').style.width  = pct(sim.p50);
  document.getElementById('sim-p90-fill').style.width  = pct(sim.p90);
  document.getElementById('sim-p10-label').textContent = `P10: ${fmt.inr(sim.p10)}`;
  document.getElementById('sim-p50-label').textContent = `P50: ${fmt.inr(sim.p50)}`;
  document.getElementById('sim-p90-label').textContent = `P90: ${fmt.inr(sim.p90)}`;

  const mpr = document.getElementById('sim-margin-rate');
  const bpr = document.getElementById('sim-budget-rate');
  mpr.textContent = fmt.pct(sim.marginPassRate * 100);
  bpr.textContent = fmt.pct(sim.budgetPassRate * 100);
  mpr.className = 'sim-pass-rate ' + (sim.marginPassRate > 0.8 ? 'good' : sim.marginPassRate > 0.6 ? 'warn' : 'bad');
  bpr.className = 'sim-pass-rate ' + (sim.budgetPassRate > 0.8 ? 'good' : sim.budgetPassRate > 0.6 ? 'warn' : 'bad');

  document.getElementById('sim-section').style.display = 'block';
}

function renderTrace(traceId, lines) {
  const el = document.getElementById(traceId);
  el.textContent = lines.join('\n');
}

function getConstraints() {
  const marginFloor = parseFloat(document.getElementById('c-margin').value) || 12;
  const budget      = parseFloat(document.getElementById('c-budget').value) * 1000 || 5000000;
  const seasonMult  = parseFloat(document.getElementById('c-season').value) || 1.0;
  return { marginFloor, budget, seasonMult };
}

function onPlan() {
  const constraints = getConstraints();

  document.getElementById('plan-btn').disabled = true;
  document.getElementById('plan-spinner').classList.add('active');
  document.getElementById('results-area').style.display = 'block';
  document.getElementById('agent2-section').style.display = 'none';

  setTimeout(() => {
    try {
      currentPlan = runPlanningAgent(CATALOG, constraints);
      renderKPIs(currentPlan);
      renderPlanTable(currentPlan, null);
      renderRegional(currentPlan);
      renderSimulation(currentPlan.simulation);
      renderTrace('planner-trace', plannerTrace);
      document.getElementById('agent2-section').style.display = 'block';
      document.getElementById('empty-state').style.display = 'none';
    } catch (e) {
      console.error(e);
      alert('Planning failed: ' + e.message);
    } finally {
      document.getElementById('plan-btn').disabled = false;
      document.getElementById('plan-spinner').classList.remove('active');
    }
  }, 30);
}

async function onReviewConstraints() {
  if (!currentPlan) return;
  const note = document.getElementById('stakeholder-note').value.trim();
  if (!note) { alert('Please enter a business constraint note.'); return; }

  const btn     = document.getElementById('review-btn');
  const spinner = document.getElementById('review-spinner');
  btn.disabled  = true;
  spinner.classList.add('active');
  document.getElementById('agent-summary-wrap').style.display = 'none';

  try {
    const decisions = await runConstraintsAgent(currentPlan, note);
    renderPlanTable(currentPlan, decisions);
    renderTrace('agent-trace', agentTrace);

    const summaryEl = document.getElementById('agent-summary');
    summaryEl.textContent = decisions.summary;
    summaryEl.className   = 'agent-summary';
    document.getElementById('agent-summary-wrap').style.display = 'block';
    document.getElementById('agent-trace-toggle').style.display = 'flex';
  } catch (e) {
    const summaryEl = document.getElementById('agent-summary');
    summaryEl.textContent = 'Agent error: ' + e.message;
    summaryEl.className   = 'agent-summary error';
    document.getElementById('agent-summary-wrap').style.display = 'block';
  } finally {
    btn.disabled = false;
    spinner.classList.remove('active');
  }
}

function onCompetitorCut() {
  if (!currentPlan) return;
  const product  = document.getElementById('comp-product').value;
  const newPrice = parseFloat(document.getElementById('comp-price').value);
  if (!product || !newPrice) { alert('Select a product and enter the new competitor price.'); return; }

  const constraints = getConstraints();
  constraints.competitorOverrides = { [product]: newPrice };

  document.getElementById('replan-btn').disabled = true;
  const spinner = document.getElementById('replan-spinner');
  spinner.classList.add('active');

  setTimeout(() => {
    currentPlan = runPlanningAgent(CATALOG, constraints);
    renderKPIs(currentPlan);
    renderPlanTable(currentPlan, null);
    renderRegional(currentPlan);
    renderSimulation(currentPlan.simulation);
    renderTrace('planner-trace', plannerTrace);
    document.getElementById('agent2-section').style.display = 'block';
    document.getElementById('replan-btn').disabled = false;
    spinner.classList.remove('active');
    document.getElementById('kpi-strip').animate(
      [{ opacity: 0.4 }, { opacity: 1 }], { duration: 600 }
    );
  }, 30);
}

function toggleTrace(panelId, btn) {
  const panel = document.getElementById(panelId);
  const open  = panel.classList.toggle('open');
  btn.querySelector('.toggle-label').textContent = open ? 'Hide agent trace ▲' : 'Show agent trace ▼';
}

document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('comp-product');
  for (const p of CATALOG) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }

  document.getElementById('plan-btn').addEventListener('click', onPlan);
  document.getElementById('review-btn').addEventListener('click', onReviewConstraints);
  document.getElementById('replan-btn').addEventListener('click', onCompetitorCut);

  document.getElementById('planner-trace-toggle').addEventListener('click', function() {
    toggleTrace('planner-trace', this);
  });
  document.getElementById('agent-trace-toggle').addEventListener('click', function() {
    toggleTrace('agent-trace', this);
  });
});
