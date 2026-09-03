/**
 * 好みプロファイルの保存。
 *
 * サーバーを持たず、ユーザーごとの状態は全部この端末の localStorage に置く。
 * 同じ静的サイトを開いた人それぞれが自分のモデルを育てる、という構成。
 */

import { emptyModel, type ModelState } from './model';

const KEY = 'nicoreco.profile.v1';

export interface Rating {
  /** 1〜5 */
  score: number;
  at: string;
}

/** 投稿者に付けた印（除外・お気に入り）。 */
export interface UserNote {
  /** どの動画から付けたか。あとで思い出すための手がかり。 */
  sample: string;
  at: string;
}

/**
 * 保留した動画が再登場するまでの行動数。
 *
 * 「行動」は評価と保留の合計。実時間ではなく行動数を時計にすることで、
 * 再び出てきたときにはモデルが更新済み＝順位が変わっている状態になる。
 *
 * 復帰は BASE 以降 SPREAD の幅にばらけさせる。一度にまとめて保留した分が
 * 揃って戻ってくると、同じ顔ぶれのバッチが再現してしまうため。
 * 何度も保留した動画ほど、次に出てくるまでを長くする。
 */
export const DEFER_BASE = 14;
export const DEFER_SPREAD = 40;

/** お気に入りタグの重みの下限。これより下には落ちない。 */
export const PIN_FLOOR = 0.3;

export interface DeferEntry {
  /** この行動数に達したら候補へ戻す */
  wake: number;
  /** これまでに保留した回数 */
  times: number;
}

export interface Settings {
  /** 探索の強さ 0〜1 */
  exploration: number;
  /** 対象にする最古の年 */
  fromYear: number;
  /** 1バッチの件数 */
  batchSize: number;
  theme: 'auto' | 'light' | 'dark';
}

/**
 * 表示中のバッチ。
 *
 * 動画を開いて戻ってきたときに、同じ10本が同じ状態で並んでいてほしい。
 * 提示は探索のゆらぎを含むので、作り直すと別の並びになってしまう。
 */
export interface SessionState {
  batchNo: number;
  ids: string[];
  /** 動画ID -> カードに出す判定（★3 / 保留 / 除外） */
  marks: Record<string, { verdict: string; mark: string }>;
}

export interface Profile {
  version: 2;
  ratings: Record<string, Rating>;
  model: ModelState;
  settings: Settings;
  /** 直近の予測と実評価のずれ（学習が効いているかの目安） */
  errorLog: number[];
  /** 評価と保留の総数。保留の解除判定に使う時計。 */
  actions: number;
  /** 動画ID -> 保留の記録。復帰後も残すので「一度見送った」判定に使える。 */
  deferred: Record<string, DeferEntry>;
  /** タグ -> お気に入りに入れた日時。重みが PIN_FLOOR より下がらなくなる。 */
  pinnedTags: Record<string, string>;
  /** タグ -> 除外した日時。このタグが付いた動画は候補から丸ごと外れる。 */
  blockedTags: Record<string, string>;
  /** 投稿者ID -> 除外した記録。この投稿者の動画は候補から常に外れる。 */
  blockedUsers: Record<string, UserNote>;
  /** 投稿者ID -> お気に入り。候補の出方は変えない、あとで見に行くための控え。 */
  favoriteUsers: Record<string, UserNote>;
  /** 表示中のバッチ。再訪時にそのまま復元する。 */
  session: SessionState;
}

export function defaultSettings(): Settings {
  return {
    exploration: 0.55,
    fromYear: new Date().getFullYear() - 2,
    batchSize: 10,
    theme: 'auto',
  };
}

export function emptyProfile(): Profile {
  return {
    version: 2,
    ratings: {},
    model: emptyModel(),
    settings: defaultSettings(),
    errorLog: [],
    actions: 0,
    deferred: {},
    blockedUsers: {},
    favoriteUsers: {},
    pinnedTags: {},
    blockedTags: {},
    session: { batchNo: 0, ids: [], marks: {} },
  };
}

export function load(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyProfile();
    return migrate(JSON.parse(raw) as Profile);
  } catch {
    // 壊れていたら作り直す。学習し直せば済む種類のデータなので。
    return emptyProfile();
  }
}

/**
 * 古い形式のプロファイルを現行に合わせる。
 *
 * v1 ではスキップを score:0 の評価として記録していたため、
 * その動画が二度と候補に出てこなかった。保留として扱い直せるよう捨てる。
 */
function migrate(parsed: Profile): Profile {
  const profile: Profile = {
    ...emptyProfile(),
    ...parsed,
    version: 2,
    settings: { ...defaultSettings(), ...(parsed.settings ?? {}) },
    model: { ...emptyModel(), ...(parsed.model ?? {}) },
    session: {
      batchNo: parsed.session?.batchNo ?? 0,
      ids: parsed.session?.ids ?? [],
      marks: parsed.session?.marks ?? {},
    },
  };

  profile.ratings = Object.fromEntries(
    Object.entries(profile.ratings ?? {}).filter(
      ([, rating]) => rating && rating.score > 0,
    ),
  );

  if (!profile.actions) {
    profile.actions = Object.keys(profile.ratings).length;
  }

  // 旧データではタグの区切りが混在しており、複数のタグが繋がったまま
  // ひとつの特徴として学習されていた。もう一致しないので捨てる。
  for (const key of Object.keys(profile.model.weights)) {
    if (key.startsWith('tag:') && /\s/.test(key)) {
      delete profile.model.weights[key];
      delete profile.model.counts[key];
    }
  }

  // 保留の記録は当初「復帰する行動数」だけの数値だった
  profile.deferred = Object.fromEntries(
    Object.entries(profile.deferred ?? {}).map(([id, entry]) => [
      id,
      typeof entry === 'number' ? { wake: entry, times: 1 } : entry,
    ]),
  );

  return profile;
}

/**
 * 保留の期限を決める。
 *
 * 同じタイミングで保留した動画が揃って戻ってこないよう、
 * 復帰までの行動数をばらけさせる。繰り返し保留したものほど遠ざける。
 */
export function scheduleDefer(profile: Profile, id: string): void {
  const times = (profile.deferred[id]?.times ?? 0) + 1;

  const wait =
    DEFER_BASE * times + Math.floor(Math.random() * DEFER_SPREAD);

  profile.deferred[id] = { wake: profile.actions + wait, times };
}

/**
 * 候補だけを最初に戻す。
 *
 * 学習した好み・お気に入り・除外はそのまま残し、
 * 「もう見た」「今は保留」の記録だけを消す。
 * 重みが育った状態で、同じ母集団をもう一周できる。
 */
export function resetCandidates(profile: Profile): void {
  profile.ratings = {};
  profile.deferred = {};
  profile.session = { batchNo: 0, ids: [], marks: {} };
}

export function save(profile: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // 容量超過などは黙って諦める（画面は動き続ける）
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

export function toJSON(profile: Profile): string {
  return JSON.stringify(profile, null, 2);
}

export function fromJSON(text: string): Profile {
  const parsed = JSON.parse(text) as Profile;
  if (!parsed || typeof parsed !== 'object' || !parsed.ratings) {
    throw new Error('プロファイルの形式が違います');
  }
  return migrate(parsed);
}
