/**
 * 好みのモデル。
 *
 * 疎なロジスティック回帰をオンライン（SGD）で更新する。
 * 評価するたびに重みが動き、その重みをそのまま画面に出せることを
 * 重視して、あえて解釈可能な線形モデルにしてある。
 */

import type { Features } from './data';

export interface ModelState {
  /** 特徴キー -> 重み */
  weights: Record<string, number>;
  /** 特徴キー -> その特徴を含む動画を評価した回数（探索の不確実性に使う） */
  counts: Record<string, number>;
  /** 学習率 */
  lr: number;
  /** L2正則化の強さ */
  l2: number;
  /** これまでの更新回数 */
  steps: number;
}

export function emptyModel(): ModelState {
  return {
    weights: { bias: 0 },
    counts: {},
    lr: 0.35,
    l2: 0.002,
    steps: 0,
  };
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** 線形和。これが「その動画の点数」の素。 */
export function rawScore(model: ModelState, features: Features): number {
  let sum = 0;
  for (const [key, value] of features) {
    sum += (model.weights[key] ?? 0) * value;
  }
  return sum;
}

export function probability(model: ModelState, features: Features): number {
  return sigmoid(rawScore(model, features));
}

/**
 * 1件の評価でモデルを更新する。
 *
 * @param target 0〜1 に正規化した評価（★1 -> 0, ★5 -> 1）
 * @param weight サンプルの重み。スキップは弱い負例として扱う。
 */
export function update(
  model: ModelState,
  features: Features,
  target: number,
  weight = 1,
): void {
  const error = probability(model, features) - target;

  // 更新が進むほど学習率を下げる（後半で重みが暴れないように）
  const lr = model.lr / (1 + model.steps / 60);

  for (const [key, value] of features) {
    const current = model.weights[key] ?? 0;
    const penalty = key === 'bias' ? 0 : model.l2 * current;
    model.weights[key] = current - lr * weight * (error * value + penalty);
    model.counts[key] = (model.counts[key] ?? 0) + 1;
  }

  model.steps += 1;
}

/**
 * 特定の特徴の重みに下限を設ける。
 *
 * 好きなジャンルのタグでも、たまたま合わない動画が続けば
 * そのタグの重みは下がっていく。「このタグ自体は好き」という判断は
 * 個々の動画の評価より上位にあるので、床を敷いて守る。
 * 下限に張り付いている間も、他の特徴（投稿者・長さなど）は
 * 通常どおり動くので、嫌いな動画の理由はそちらに寄っていく。
 */
export function applyFloors(
  model: ModelState,
  floors: Record<string, number>,
): void {
  for (const [key, floor] of Object.entries(floors)) {
    if ((model.weights[key] ?? 0) < floor) {
      model.weights[key] = floor;
    }
  }
}

/**
 * 未知の特徴に対する不確実性ボーナス。
 *
 * まだ評価していない特徴ほど大きくなる。これがないと
 * 数周で同じ傾向の動画しか出てこなくなる。
 */
export function novelty(model: ModelState, features: Features): number {
  let bonus = 0;
  let terms = 0;

  for (const key of features.keys()) {
    if (key === 'bias' || key.startsWith('num:')) continue;
    const seen = model.counts[key] ?? 0;
    bonus += 1 / Math.sqrt(1 + seen);
    terms += 1;
  }

  return terms > 0 ? bonus / terms : 1;
}

export interface RankedItem<T> {
  item: T;
  features: Features;
  score: number;
  explore: number;
  total: number;
}

/**
 * 探索込みの並べ替え。
 *
 * total = 予測スコア + 探索係数 x (未知度 + ゆらぎ)
 * 探索係数を 0 にすると純粋な「好みが強い順」になる。
 */
export function rank<T>(
  model: ModelState,
  entries: { item: T; features: Features }[],
  exploration: number,
  random: () => number = Math.random,
): RankedItem<T>[] {
  return entries
    .map(({ item, features }) => {
      const score = rawScore(model, features);
      const explore =
        novelty(model, features) * 0.8 + (random() - 0.5) * 0.6;
      return {
        item,
        features,
        score,
        explore,
        total: score + exploration * explore,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** その動画のスコアに効いた特徴の内訳（絶対値の大きい順）。 */
export function contributions(
  model: ModelState,
  features: Features,
  limit = 6,
): { key: string; value: number }[] {
  const parts: { key: string; value: number }[] = [];

  for (const [key, value] of features) {
    if (key === 'bias') continue;
    const contribution = (model.weights[key] ?? 0) * value;
    if (Math.abs(contribution) > 1e-4) {
      parts.push({ key, value: contribution });
    }
  }

  parts.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return parts.slice(0, limit);
}

/** 画面に出す「今の好み」。十分な観測数がある特徴だけを見せる。 */
export function topWeights(
  model: ModelState,
  minCount = 2,
  limit = 12,
): { key: string; weight: number; count: number }[] {
  return Object.entries(model.weights)
    .filter(([key]) => key !== 'bias')
    .map(([key, weight]) => ({
      key,
      weight,
      count: model.counts[key] ?? 0,
    }))
    .filter((entry) => entry.count >= minCount && Math.abs(entry.weight) > 0.01)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, limit);
}
