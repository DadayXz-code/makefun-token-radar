// Token launch radar: a fitted comps model over the sealed DefiLlama snapshot.
//
// What the board claims, in one line:
//   implied_value = fitted_launch_value x growth_tilt x token_odds
// where fitted_launch_value is an OLS fit of log10(market cap) on log10(TVL) with
// shrunk category offsets, fitted on the snapshot's own traded protocols; growth_tilt
// is a bounded tilt from the protocol's 7-day TVL change; and token_odds is the
// smoothed share of protocols that record a token, among peers of the same age and
// size. Every term is computed from the snapshot at run time: no coefficient, no
// multiple and no protocol name is hardcoded. The fit is validated held-out inside
// this file (5-fold CV, leave-one-out, and a time split), and the numbers it measures
// are printed into the dashboard so a reader can see how much the model is worth.
//
// Honest limits, stated where the dashboard states the model: the traded comps are
// only 128 protocols, the fit's residual spread is about 0.9 in log10 (a typical
// error near 8x on the value itself), and the fitted 7-day-growth coefficient came
// out negative and unstable, so growth enters as a capped tilt instead of a fitted
// driver. Age enters through token_odds, not through the value fit: the comps show
// no age effect on the value multiple at all (correlation -0.003).

/** One protocol of the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, at least 0; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records any token for the protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker (V2, v2, 2.0 and the like) is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A name that begins with an exchange's name. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether the board may rank the protocol: it records no token, and it is not a
 * versioned pool, an exchange, or a wrapped / staked / bridged product of a token
 * that already trades. The snapshot's watchlist is the floor; this rule is the
 * same hygiene applied to the protocols below it.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !WRAPPED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

// ------------------------------------------------------------------ fitting

/** Spearman rank correlation between two equal-length arrays. */
export function spearman(actual: number[], predicted: number[]): number {
  const rank = (arr: number[]): number[] => {
    const order = arr.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(arr.length);
    order.forEach(([, i], pos) => {
      r[i] = pos;
    });
    return r;
  };
  const ra = rank(actual);
  const rb = rank(predicted);
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length;
  const mb = rb.reduce((s, v) => s + v, 0) / rb.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let j = 0; j < ra.length; j++) {
    num += (ra[j]! - ma) * (rb[j]! - mb);
    da += (ra[j]! - ma) ** 2;
    db += (rb[j]! - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Closed-form least squares for y = a + b*x. */
function linfit(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
}

/** The fitted comps model: intercept, slope, shrunk category offsets, and its held-out report. */
export interface CompsFit {
  n: number;
  intercept: number;
  slope: number;
  offsets: Record<string, number>;
  shrink_k: number;
  residual_sd_log10: number;
  median_multiple: number;
  cv_spearman: number;
  cv_folds: number[];
  loo_spearman: number;
  time_split_spearman: number | null;
  time_split_n_train: number;
  time_split_n_test: number;
}

const SHRINK_K = 8;

/** Fit log10(mcap) on log10(TVL) plus shrunk category offsets, on the given comps. */
function fitOn(comps: SnapshotProtocol[]): { intercept: number; slope: number; offsets: Record<string, number> } {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const { a, b } = linfit(xs, ys);
  const byCat = new Map<string, number[]>();
  comps.forEach((p, i) => {
    const c = p.category ?? 'Other';
    const list = byCat.get(c) ?? [];
    list.push(ys[i]! - (a + b * xs[i]!));
    byCat.set(c, list);
  });
  const offsets: Record<string, number> = {};
  for (const [c, rs] of [...byCat.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    offsets[c] = mean * (rs.length / (rs.length + SHRINK_K));
  }
  return { intercept: a, slope: b, offsets };
}

/** The fitted log10 market cap of one protocol under a fit. */
function predictLog10(p: SnapshotProtocol, fit: { intercept: number; slope: number; offsets: Record<string, number> }): number {
  return fit.intercept + fit.slope * Math.log10(p.tvl_usd) + (fit.offsets[p.category ?? 'Other'] ?? 0);
}

/** Fit the comps model on the snapshot's traded protocols and validate it held-out. */
export function fitComps(snapshot: Snapshot): CompsFit {
  const comps = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const full = fitOn(comps);
  const resid = comps.map((p, i) => ys[i]! - predictLog10(p, full));
  const residualSd = Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / Math.max(1, resid.length));
  const multiples = comps.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const medianMultiple = multiples[Math.floor(multiples.length / 2)]!;

  // 5-fold cross-validation, folds by position (deterministic; comps are slug-sorted).
  const folds: number[] = [];
  for (let f = 0; f < 5; f++) {
    const test = comps.map((_, i) => i).filter((i) => i % 5 === f);
    const train = comps.map((_, i) => i).filter((i) => i % 5 !== f);
    const fit = fitOn(train.map((i) => comps[i]!));
    folds.push(spearman(test.map((i) => ys[i]!), test.map((i) => predictLog10(comps[i]!, fit))));
  }
  const cvSpearman = folds.reduce((s, v) => s + v, 0) / folds.length;

  // Leave-one-out: one refit per comp.
  const looPred = comps.map((_, i) => {
    const train = comps.filter((__, j) => j !== i);
    return predictLog10(comps[i]!, fitOn(train));
  });
  const looSpearman = spearman(ys, looPred);

  // Time split: train on protocols listed before 2024-06-01, test on those listed after.
  const cut = Date.parse('2024-06-01T00:00:00Z');
  const trainIdx = comps.map((_, i) => i).filter((i) => {
    const p = comps[i]!;
    return p.listed_at !== null && Date.parse(`${p.listed_at}T00:00:00Z`) < cut;
  });
  const testIdx = comps.map((_, i) => i).filter((i) => {
    const p = comps[i]!;
    return p.listed_at !== null && Date.parse(`${p.listed_at}T00:00:00Z`) >= cut;
  });
  let timeSplit: number | null = null;
  if (trainIdx.length >= 10 && testIdx.length >= 10) {
    const fit = fitOn(trainIdx.map((i) => comps[i]!));
    timeSplit = spearman(testIdx.map((i) => ys[i]!), testIdx.map((i) => predictLog10(comps[i]!, fit)));
  }

  return {
    n: comps.length,
    intercept: full.intercept,
    slope: full.slope,
    offsets: full.offsets,
    shrink_k: SHRINK_K,
    residual_sd_log10: residualSd,
    median_multiple: medianMultiple,
    cv_spearman: cvSpearman,
    cv_folds: folds,
    loo_spearman: looSpearman,
    time_split_spearman: timeSplit,
    time_split_n_train: trainIdx.length,
    time_split_n_test: testIdx.length,
  };
}

// ------------------------------------------------------------------ token odds

/** Age bucket of a protocol, by days since DefiLlama began tracking it. */
function ageBucket(age: number | null): string {
  if (age === null) return 'unknown';
  if (age < 365) return '<1y';
  if (age < 730) return '1-2y';
  if (age < 1460) return '2-4y';
  return '4y+';
}

/** Size bucket of a protocol, by TVL. */
function tvlBucket(tvl: number): string {
  if (tvl < 50_000_000) return '<50M';
  if (tvl < 200_000_000) return '50-200M';
  if (tvl < 1_000_000_000) return '200M-1B';
  return '1B+';
}

/** The smoothed token-odds table: P(a protocol records a token) by age x size. */
export interface OddsTable {
  cells: Record<string, { n: number; with_token: number; odds: number }>;
  age_prior: Record<string, number>;
  smooth_m: number;
}

/**
 * Token odds from the snapshot itself: among all 758 protocols, the share that
 * record a token (a CoinGecko id or a symbol), in the protocol's age-by-size cell,
 * shrunk toward its age bucket's own rate with m = 10 pseudo-observations, so a
 * cell of four protocols does not claim a precise probability.
 */
export function tokenOdds(snapshot: Snapshot): OddsTable {
  const cells = new Map<string, { n: number; tok: number }>();
  const ageAgg = new Map<string, { n: number; tok: number }>();
  for (const p of snapshot.protocols) {
    const has = p.gecko_id !== null || p.symbol !== null;
    const a = ageBucket(ageDays(snapshot.as_of, p.listed_at));
    const key = `${a}|${tvlBucket(p.tvl_usd)}`;
    const cell = cells.get(key) ?? { n: 0, tok: 0 };
    cell.n++;
    if (has) cell.tok++;
    cells.set(key, cell);
    const agg = ageAgg.get(a) ?? { n: 0, tok: 0 };
    agg.n++;
    if (has) agg.tok++;
    ageAgg.set(a, agg);
  }
  const agePrior: Record<string, number> = {};
  for (const [a, v] of [...ageAgg.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    agePrior[a] = v.n === 0 ? 0.5 : v.tok / v.n;
  }
  const out: Record<string, { n: number; with_token: number; odds: number }> = {};
  for (const [key, v] of [...cells.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const a = key.split('|')[0]!;
    const prior = agePrior[a] ?? 0.5;
    out[key] = { n: v.n, with_token: v.tok, odds: (v.tok + 10 * prior) / (v.n + 10) };
  }
  return { cells: out, age_prior: agePrior, smooth_m: 10 };
}

/** One protocol's smoothed token odds under the table. */
export function oddsOf(p: SnapshotProtocol, snapshot: Snapshot, table: OddsTable): number {
  const key = `${ageBucket(ageDays(snapshot.as_of, p.listed_at))}|${tvlBucket(p.tvl_usd)}`;
  const cell = table.cells[key];
  if (cell !== undefined) return cell.odds;
  return table.age_prior[ageBucket(ageDays(snapshot.as_of, p.listed_at))] ?? 0.5;
}

// ------------------------------------------------------------------ implied value

/** Growth tilt: a bounded ± tilt from the 7-day TVL change, never a fitted driver. */
export const GROWTH_WEIGHT = 0.25;
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 120;

/** The model's terms for one protocol, and the implied value they give. */
export function impliedValue(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  fit: CompsFit,
  table: OddsTable,
): { fitted_usd: number; growth_pct: number; growth_mult: number; odds: number; implied: number; age: number | null } {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const fitted = 10 ** predictLog10(p, fit);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const odds = oddsOf(p, snapshot, table);
  const implied = Math.max(1, Math.round(fitted * growthMult * odds));
  return { fitted_usd: fitted, growth_pct: growthPct, growth_mult: growthMult, odds, implied, age };
}

// ------------------------------------------------------------------ farm plans

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: action, then cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Rough gas per transaction on a chain, in whole US dollars (an estimate, stated as one). */
function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 12;
  if (c === 'solana') return 1;
  if (c === 'bitcoin') return 3;
  if (['arbitrum', 'optimism', 'base', 'blast', 'zksync', 'linea', 'scroll', 'mode', 'fraxtal'].includes(c)) return 1;
  if (['bsc', 'binance', 'avalanche', 'polygon', 'fantom', 'gnosis', 'celo'].includes(c)) return 1;
  return 2;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} as a lender and keep the deposit open.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager')) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  }
  if (c.includes('stak') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged trade.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and place one market position on ${name} on ${chain}.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('stable') || c.includes('rwa')) {
    return `Mint or hold $${capital} of the asset ${name} issues on ${chain}.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('launchpad')) {
    return `Stake $${capital} of the launch asset on ${name} on ${chain} and join one sale.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan
 * is derived from the protocol's own record (category, chains, TVL, age), never from
 * a hand-written list of names. Gas figures are rough estimates for the chain named.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(chain);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `about $${gas} of gas for the first transaction on ${chain}`,
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about $${gas} of gas a week on ${chain}`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    fitted_value_usd: number;
    category_offset_log10: number;
    growth_pct: number;
    growth_multiplier: number;
    token_odds: number;
    age_days: number | null;
  };
  /** The farm's economics, from the same inputs as the steps: capital, gas, hold. */
  farm_econ: { capital_usd: number; gas_per_tx_usd: number; hold_days: number; weekly_gas_usd: number };
  /** Farm when the expected launch value is large, Watch when it is material, else Early. */
  signal: 'Farm' | 'Watch' | 'Early';
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: CompsFit;
  odds: OddsTable;
  watchlist_size: number;
  watchlist_slugs: string[];
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'comps-ols-shrunk-v1';

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: CompsFit, table: OddsTable): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, in full.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, whatever its TVL.
  // A chosen protocol stays chosen; nothing here replaces a watchlist row.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot, fit, table);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const econ = {
      capital_usd: capitalFor(s.p),
      gas_per_tx_usd: gasPerTx(chainOf(s.p)),
      hold_days: holdDaysFor(s.v.age),
      weekly_gas_usd: gasPerTx(chainOf(s.p)),
    };
    const signal: 'Farm' | 'Watch' | 'Early' = s.v.implied >= 15_000_000 ? 'Farm' : s.v.implied >= 4_000_000 ? 'Watch' : 'Early';
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      token_status: 'pre-token',
      age_days: s.v.age,
      implied_value_usd: s.v.implied,
      model: {
        fitted_value_usd: Math.round(s.v.fitted_usd),
        category_offset_log10: round4(fit.offsets[s.p.category ?? 'Other'] ?? 0),
        growth_pct: s.v.growth_pct,
        growth_multiplier: round4(s.v.growth_mult),
        token_odds: round4(s.v.odds),
        age_days: s.v.age,
      },
      farm_econ: econ,
      signal,
      farm_steps: farmSteps(s.p, s.v.age).map(stepText),
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.tvl_usd > 0 ? p.mcap_usd! / p.tvl_usd : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; fit: CompsFit; odds: OddsTable } {
  const fit = fitComps(snapshot);
  const table = tokenOdds(snapshot);
  const board = buildBoard(snapshot, fit, table);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit,
    odds: table,
    watchlist_size: snapshot.watchlist.length,
    watchlist_slugs: [...snapshot.watchlist].sort(),
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar, fit, odds: table };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, under the gate's 100`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
