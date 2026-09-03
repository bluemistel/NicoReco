/**
 * 候補プールの読み込みと、動画1本を特徴ベクトルに変換する処理。
 *
 * データは collector 側が書き出した静的JSON。
 * Snapshot API は CORS ヘッダを返さないので、ブラウザからは直接叩かない。
 */

export interface Video {
  id: string;
  title: string;
  tags: string[];
  user: string;
  date: string;
  year: number;
  view: number;
  comment: number;
  mylist: number;
  like: number;
  length: number;
  /** ランキング最高位。未掲載なら 0 */
  rank: number;
  /** サムネイルURL。空文字なら画像なし */
  thumb: string;
  /** 保存率 = (マイリスト + いいね) / 再生数 */
  saveRate: number;
  /** コメント率 = コメント数 / 再生数 */
  talkRate: number;
}

export interface Shard {
  year: string;
  file: string;
  count: number;
}

export interface PoolIndex {
  generatedAt: string;
  genre: string;
  genreKey: string;
  total: number;
  shards: Shard[];
  tagVocab: string[];
}

/** 疎な特徴ベクトル。キーは人間が読める文字列にしてある（重みをそのまま画面に出すため）。 */
export type Features = Map<string, number>;

const BASE = import.meta.env.BASE_URL;

/** サムネイルURLの共通部分（JSONには末尾だけを持たせている）。 */
export const THUMB_PREFIX = 'https://nicovideo.cdn.nimg.jp/thumbnails/';

function url(file: string): string {
  return `${BASE.replace(/\/$/, '')}/data/${file}`;
}

export async function loadIndex(): Promise<PoolIndex> {
  const response = await fetch(url('index.json'));
  if (!response.ok) {
    throw new Error(`index.json を読み込めません (${response.status})`);
  }
  return response.json();
}

/**
 * 投稿者ページのURL。
 *
 * 表示名とアイコンは持たない。それらを返すのは非公式の内部APIで、
 * 人に関する情報を集めて配ることにもなるため、扱わない方針にしている。
 * 公式に提供されている Snapshot API が返すのは `userId` だけで、
 * それも画面には出さない（リンク先で確かめてもらう）。
 */
export function userPageUrl(id: string): string {
  return `https://www.nicovideo.jp/user/${id}/video`;
}

export async function loadShard(shard: Shard): Promise<Video[]> {
  const response = await fetch(url(shard.file));
  if (!response.ok) {
    throw new Error(`${shard.file} を読み込めません (${response.status})`);
  }
  const payload = await response.json();
  return (payload.items as unknown[][]).map(toVideo);
}

function toVideo(row: unknown[]): Video {
  const view = (row[5] as number) || 0;
  const comment = (row[6] as number) || 0;
  const mylist = (row[7] as number) || 0;
  const like = (row[8] as number) || 0;
  const date = (row[4] as string) || '';

  return {
    id: row[0] as string,
    title: row[1] as string,
    tags: ((row[2] as string) || '').split(' ').filter(Boolean),
    user: (row[3] as string) || '',
    date,
    year: Number(date.slice(0, 4)) || 0,
    view,
    comment,
    mylist,
    like,
    length: (row[9] as number) || 0,
    rank: (row[10] as number) || 0,
    thumb: (row[11] as string) || '',
    saveRate: view > 0 ? (mylist + like) / view : 0,
    talkRate: view > 0 ? comment / view : 0,
  };
}

// ============================================================
// 特徴量
// ============================================================

/** 動画長のビン。何分の動画を好むかは嗜好がはっきり出る。 */
export function lengthBin(seconds: number): string {
  if (!seconds) return 'len:不明';
  const minutes = seconds / 60;
  if (minutes < 3) return 'len:〜3分';
  if (minutes < 6) return 'len:3〜6分';
  if (minutes < 12) return 'len:6〜12分';
  if (minutes < 25) return 'len:12〜25分';
  return 'len:25分〜';
}

export function eraBin(year: number): string {
  if (!year) return 'era:不明';
  if (year >= 2025) return 'era:2025〜';
  if (year >= 2022) return 'era:2022〜24';
  if (year >= 2019) return 'era:2019〜21';
  if (year >= 2015) return 'era:2015〜18';
  return 'era:〜2014';
}

/** プール全体の統計。連続値の標準化に使う。 */
export interface PoolStats {
  logView: { mean: number; sd: number };
  saveRate: { mean: number; sd: number };
  talkRate: { mean: number; sd: number };
  tagVocab: Set<string>;
}

export function computeStats(
  videos: Video[],
  tagVocab: string[],
): PoolStats {
  const logViews = videos.map((v) => Math.log10(v.view + 1));
  const saves = videos.map((v) => v.saveRate);
  const talks = videos.map((v) => v.talkRate);

  return {
    logView: momentsOf(logViews),
    saveRate: momentsOf(saves),
    talkRate: momentsOf(talks),
    tagVocab: new Set(tagVocab),
  };
}

function momentsOf(values: number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 1 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) || 1 };
}

function z(value: number, moments: { mean: number; sd: number }): number {
  return clamp((value - moments.mean) / moments.sd, -3, 3);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * 動画を特徴ベクトルに変換する。
 *
 * タグと投稿者は語彙内のものだけを立てる。語彙外のタグまで拾うと
 * 1本しか存在しないタグに重みが乗って、ただの丸暗記になる。
 */
export function featurize(video: Video, stats: PoolStats): Features {
  const features: Features = new Map();

  features.set('bias', 1);

  for (const tag of video.tags) {
    if (stats.tagVocab.has(tag)) {
      features.set(`tag:${tag}`, 1);
    }
  }

  if (video.user) {
    features.set(`user:${video.user}`, 1);
  }

  features.set(lengthBin(video.length), 1);
  features.set(eraBin(video.year), 1);

  features.set('num:再生数(対数)', z(Math.log10(video.view + 1), stats.logView));
  features.set('num:保存率', z(video.saveRate, stats.saveRate));
  features.set('num:コメント率', z(video.talkRate, stats.talkRate));

  return features;
}

// ============================================================
// 表示用のヘルパ
// ============================================================

export function formatCount(value: number): string {
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}億`;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return value.toLocaleString('ja-JP');
}

export function formatLength(seconds: number): string {
  if (!seconds) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function featureLabel(key: string): string {
  const separator = key.indexOf(':');
  if (separator < 0) return key;
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (kind === 'tag') return value;
  if (kind === 'user') return 'この投稿者';
  return value;
}

export function featureKind(key: string): string {
  const separator = key.indexOf(':');
  return separator < 0 ? key : key.slice(0, separator);
}
