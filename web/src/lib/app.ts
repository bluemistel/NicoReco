/**
 * 画面の組み立てと、評価 -> 学習 -> 再提示のループ。
 */

import {
  computeStats,
  featureLabel,
  featureKind,
  featurize,
  formatCount,
  formatLength,
  loadIndex,
  loadShard,
  userPageUrl,
  THUMB_PREFIX,
  type Features,
  type PoolIndex,
  type PoolStats,
  type Video,
} from './data';

import {
  applyFloors,
  contributions,
  probability,
  rank,
  topWeights,
  update,
  type RankedItem,
} from './model';

import * as store from './store';

interface AppState {
  index: PoolIndex | null;
  videos: Video[];
  features: Map<string, Features>;
  stats: PoolStats | null;
  profile: store.Profile;
  batch: RankedItem<Video>[];
  batchNo: number;
  /** このバッチで処理済みの動画ID */
  handled: Set<string>;
}

const state: AppState = {
  index: null,
  videos: [],
  features: new Map(),
  stats: null,
  profile: store.emptyProfile(),
  batch: [],
  batchNo: 0,
  handled: new Set(),
};

const $ = <T extends HTMLElement>(selector: string): T =>
  document.querySelector(selector) as T;

// ============================================================
// 起動
// ============================================================

export async function boot(): Promise<void> {
  state.profile = store.load();

  applyTheme();

  const status = $('#status');

  try {
    status.textContent = '候補プールを読み込み中…';

    const index = await loadIndex();
    state.index = index;

    const shards = await Promise.all(index.shards.map(loadShard));

    state.videos = shards.flat();

    state.stats = computeStats(state.videos, index.tagVocab);

    for (const video of state.videos) {
      state.features.set(video.id, featurize(video, state.stats));
    }

    status.remove();

    $('#genre-label').textContent = index.genre;
    $('#pool-size').textContent = `${index.total.toLocaleString('ja-JP')}本`;
    $('#generated-at').textContent = index.generatedAt.slice(0, 10);

    syncControls();
    bindEvents();
    renderPanel();

    if (!restoreBatch()) nextBatch();
  } catch (error) {
    status.textContent =
      `データを読み込めませんでした: ${(error as Error).message}`;
    status.classList.add('is-error');
  }
}

// ============================================================
// バッチの生成
// ============================================================

function candidatePool(): Video[] {
  const { fromYear } = state.profile.settings;
  const { ratings, deferred, blockedUsers, blockedTags, actions } =
    state.profile;

  const hasBlockedTag = Object.keys(blockedTags).length > 0;

  return state.videos.filter((video) => {
    if (video.year < fromYear) return false;
    if (ratings[video.id]) return false;
    if (video.user && blockedUsers[video.user]) return false;
    if (hasBlockedTag && video.tags.some((tag) => blockedTags[tag])) {
      return false;
    }

    // 保留中の動画は、こちらが何度か判断を重ねてから戻ってくる
    const held = deferred[video.id];
    if (held && actions < held.wake) return false;

    return true;
  });
}

/** 除外（投稿者・タグ）が候補プールから何本消しているか。 */
function blockedCount(): number {
  const { fromYear } = state.profile.settings;
  const { blockedUsers, blockedTags } = state.profile;

  return state.videos.filter((video) => {
    if (video.year < fromYear) return false;
    if (video.user && blockedUsers[video.user]) return true;
    return video.tags.some((tag) => blockedTags[tag]);
  }).length;
}

/** そのタグが候補プールに何本あるか。 */
function poolCountByTag(): Map<string, number> {
  const counts = new Map<string, number>();

  for (const video of state.videos) {
    for (const tag of video.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return counts;
}

function nextBatch(): void {
  const { exploration, batchSize } = state.profile.settings;

  // 手を付けずに次へ進んだぶんは保留にする。
  // そのまま候補へ返すと、次のバッチでも同じ顔ぶれが上位に来てしまう。
  holdRemaining();

  const entries = candidatePool().map((video) => ({
    item: video,
    features: state.features.get(video.id)!,
  }));

  const ranked = rank(state.profile.model, entries, exploration);

  // 一度見送った動画が戻ってきたバッチを、それだけで埋めない。
  // 未出現のものと混ざるように、1バッチあたりの枠を切る。
  const revisitCap = Math.max(2, Math.round(batchSize * 0.3));
  let revisits = 0;

  // 同じ投稿者ばかりが並ぶと、好みの解像度が上がらない
  const perUser = new Map<string, number>();
  const picked: RankedItem<Video>[] = [];

  for (const entry of ranked) {
    if (picked.length >= batchSize) break;

    const user = entry.item.user || '?';
    const used = perUser.get(user) ?? 0;
    if (used >= 2) continue;

    const seenBefore = Boolean(state.profile.deferred[entry.item.id]);
    if (seenBefore && revisits >= revisitCap) continue;
    if (seenBefore) revisits += 1;

    perUser.set(user, used + 1);
    picked.push(entry);
  }

  state.batch = picked;
  state.batchNo += 1;
  state.handled = new Set();

  state.profile.session = {
    batchNo: state.batchNo,
    ids: picked.map((entry) => entry.item.id),
    marks: {},
  };

  store.save(state.profile);

  renderBatch();
  renderPanel();
}

/** お気に入りタグの重みに敷く床。 */
function tagFloors(): Record<string, number> {
  return Object.fromEntries(
    Object.keys(state.profile.pinnedTags).map((tag) => [
      `tag:${tag}`,
      store.PIN_FLOOR,
    ]),
  );
}

/**
 * タグのお気に入り。
 *
 * 好きなジャンルでも、たまたま合わない動画が続けば重みは下がる。
 * 「このタグ自体は好き」という判断を、個々の動画の評価より上に置く。
 */
function togglePinnedTag(tag: string): void {
  const pinned = state.profile.pinnedTags;

  if (pinned[tag]) {
    delete pinned[tag];
  } else {
    pinned[tag] = new Date().toISOString();
    delete state.profile.blockedTags[tag];
  }

  applyFloors(state.profile.model, tagFloors());

  store.save(state.profile);
  refreshTagChips();
  renderPanel();
}

/**
 * タグの除外。
 *
 * お気に入りの裏返しだが、こちらは重みではなく候補そのものを削る。
 * 「この企画は見ない」「この題材は苦手」を一撃で反映するための操作で、
 * 投稿者の除外と同じ位置づけ。好みの学習には影響しない。
 */
function toggleBlockedTag(tag: string): void {
  const blocked = state.profile.blockedTags;

  if (blocked[tag]) {
    delete blocked[tag];
  } else {
    blocked[tag] = new Date().toISOString();

    // お気に入りと除外は両立しない
    delete state.profile.pinnedTags[tag];

    // いま並んでいるカードのうち、そのタグを持つものは片付ける
    for (const entry of state.batch) {
      if (state.handled.has(entry.item.id)) continue;
      if (!entry.item.tags.includes(tag)) continue;

      state.handled.add(entry.item.id);
      markCard(entry.item.id, '除外', 'block');
    }
  }

  store.save(state.profile);
  refreshTagChips();
  renderPanel();
  advanceIfDone();
}

/** 表示中のカードのタグの見た目を、いまの状態に合わせる。 */
function refreshTagChips(): void {
  const { pinnedTags, blockedTags } = state.profile;

  for (const element of document.querySelectorAll<HTMLElement>('.tag')) {
    const tag = element.dataset.tag ?? '';
    element.classList.toggle('is-pinned', Boolean(pinnedTags[tag]));
    element.classList.toggle('is-blocked', Boolean(blockedTags[tag]));
  }
}

/**
 * 表示したまま手を付けなかったカードを保留にする。
 *
 * 何も押さずに次へ進むと、その動画は候補に残ったまま同じ順位に来る。
 * 「今回は見送った」という事実は保留と同じなので、そう記録する。
 */
function holdRemaining(): void {
  for (const entry of state.batch) {
    if (state.handled.has(entry.item.id)) continue;

    store.scheduleDefer(state.profile, entry.item.id);

    // 保留ボタンを押したのと同じ扱いにする。
    // ここで時計を進めないと、次へ進み続けるだけでは
    // 保留した動画がいつまでも戻ってこない。
    state.profile.actions += 1;
  }
}

/**
 * 前回表示していたバッチを復元する。
 *
 * 動画を開いて戻ってきたときに並びが変わっていると、
 * 見比べていた候補が消えてしまう。提示は探索のゆらぎを含むので、
 * 作り直さずに保存しておいたものをそのまま出す。
 */
function restoreBatch(): boolean {
  const session = state.profile.session;

  if (!session.ids.length) return false;

  const byId = new Map(state.videos.map((video) => [video.id, video]));

  const picked = session.ids
    .map((id) => byId.get(id))
    .filter((video): video is Video => Boolean(video))
    .map((video) => ({
      item: video,
      features: state.features.get(video.id)!,
      score: 0,
      explore: 0,
      total: 0,
    }));

  if (!picked.length) return false;

  // 全部さばき終わっていたなら、次のバッチから始めるほうが自然
  const marks = session.marks;
  if (picked.every((entry) => marks[entry.item.id])) return false;

  state.batch = picked;
  state.batchNo = session.batchNo;
  state.handled = new Set(Object.keys(marks));

  renderBatch();

  for (const [id, mark] of Object.entries(marks)) {
    markCard(id, mark.verdict, mark.mark);
  }

  renderPanel();

  return true;
}

// ============================================================
// 評価
// ============================================================

function rate(video: Video, score: number): void {
  const features = state.features.get(video.id)!;
  const model = state.profile.model;

  // ★1 -> 0.0 / ★5 -> 1.0
  const target = (score - 1) / 4;

  const predicted = probability(model, features);
  state.profile.errorLog.push(Math.abs(predicted - target));
  if (state.profile.errorLog.length > 40) state.profile.errorLog.shift();

  update(model, features, target);
  applyFloors(model, tagFloors());

  state.profile.ratings[video.id] = {
    score,
    at: new Date().toISOString(),
  };

  finishCard(video, `★${score}`, String(score));
}

/**
 * 保留。
 *
 * 「今は判断できない」なので、モデルには一切触れない。
 * 好みの信号として使わない代わりに、しばらくしてからまた出てくる。
 */
function defer(video: Video): void {
  store.scheduleDefer(state.profile, video.id);

  finishCard(video, '保留', 'defer');
}

/**
 * 投稿者の除外。
 *
 * 好みの重みには反映しない。候補から機械的に消すだけの操作。
 * 多作な投稿者が趣味に合わない場合、ここで一気に選択肢を減らせる。
 */
function blockUser(video: Video): void {
  if (!video.user) return;

  state.profile.blockedUsers[video.user] = {
    sample: video.title,
    at: new Date().toISOString(),
  };

  // 同じ投稿者が同じバッチに残っていても意味がないので、まとめて片付ける
  for (const entry of state.batch) {
    if (entry.item.user === video.user && !state.handled.has(entry.item.id)) {
      state.handled.add(entry.item.id);
      markCard(entry.item.id, '除外', 'block');
    }
  }

  store.save(state.profile);
  renderPanel();
  advanceIfDone();
}

/**
 * お気に入り投稿者。
 *
 * 除外の裏返しだが、候補の出方は変えない。あとでその投稿者の
 * 作品をまとめて見に行くための控えとして持つだけ。
 * 好みの重みに混ぜないのは、保留や除外と同じ理由で役割を分けるため。
 */
function toggleFavorite(video: Video): void {
  if (!video.user) return;

  const favorites = state.profile.favoriteUsers;

  if (favorites[video.user]) delete favorites[video.user];
  else favorites[video.user] = {
    sample: video.title,
    at: new Date().toISOString(),
  };

  store.save(state.profile);
  refreshFavoriteButtons();
  renderPanel();
}

/**
 * 表示中のカードの星を、いまのお気に入り状態に合わせる。
 *
 * バッチを描き直すと評価済みの表示まで戻ってしまうので、
 * 星だけを差し替える。
 */
function refreshFavoriteButtons(): void {
  const favorites = state.profile.favoriteUsers;

  for (const entry of state.batch) {
    const button = document.querySelector<HTMLElement>(
      `.card[data-id="${CSS.escape(entry.item.id)}"] .fav`,
    );
    if (!button) continue;

    const on = Boolean(entry.item.user && favorites[entry.item.user]);
    button.classList.toggle('is-on', on);
    button.textContent = on ? '★' : '☆';
  }
}

/** 1件分の操作を確定して、次へ進めるかを見る。 */
function finishCard(video: Video, verdict: string, mark: string): void {
  state.profile.actions += 1;
  state.handled.add(video.id);

  // markCard が判定をプロファイルに書くので、保存はそのあと
  markCard(video.id, verdict, mark);

  store.save(state.profile);

  renderPanel();
  advanceIfDone();
}

function advanceIfDone(): void {
  if (state.handled.size >= state.batch.length) {
    window.setTimeout(nextBatch, 420);
  }
}

// ============================================================
// 描画：候補カード
// ============================================================

/**
 * サムネイルの img タグ。
 *
 * URLの末尾にバージョン番号が付く動画では `.L` の大きい版が存在するが、
 * 古い動画には無い。まず `.L` を試し、失敗したら通常版に落とす。
 */
function thumbnail(video: Video): string {
  if (!video.thumb) return '';

  const base = `${THUMB_PREFIX}${video.thumb}`;

  return (
    `<img src="${base}.L" data-fallback="${base}" alt="" loading="lazy">`
  );
}

function renderBatch(): void {
  $('#batch-no').textContent = String(state.batchNo).padStart(2, '0');
  $('#batch-count').textContent = `${state.batch.length}本`;

  const list = $('#cards');

  if (state.batch.length === 0) {
    list.innerHTML =
      `<li class="empty">この範囲の候補は出し切りました。` +
      `対象範囲を広げるか、収集を回して候補を足してください。</li>`;
    return;
  }

  list.innerHTML = state.batch
    .map((entry, position) => card(entry, position))
    .join('');
}

/**
 * 投稿者の行。
 *
 * 同じ投稿者でも作品ごとに立ち絵や作風が違うことがあるので、
 * タイトルのすぐ下に置いて、判断の材料として最初に目に入るようにする。
 */
function uploaderRow(video: Video): string {
  if (!video.user) return '';

  const isFavorite = Boolean(state.profile.favoriteUsers[video.user]);

  return `
    <div class="card-user">
      <a class="card-uploader" href="${userPageUrl(video.user)}"
         target="_blank" rel="noopener noreferrer"
         title="この投稿者の動画一覧をニコニコ側で開く">投稿者</a>
      <button class="user-action fav ${isFavorite ? 'is-on' : ''}"
              data-action="favorite"
              title="お気に入り投稿者に入れる">${isFavorite ? '★' : '☆'}</button>
      <button class="user-action mute" data-action="block"
              title="この投稿者を候補から外す">除外</button>
    </div>`;
}

function card(entry: RankedItem<Video>, position: number): string {
  const video = entry.item;
  const fit = Math.round(probability(state.profile.model, entry.features) * 100);

  const parts = contributions(state.profile.model, entry.features, 4)
    .map(
      (part) =>
        `<span class="chip ${part.value >= 0 ? 'is-plus' : 'is-minus'}">` +
        `${escape(featureLabel(part.key))}` +
        `<b>${part.value >= 0 ? '+' : ''}${part.value.toFixed(2)}</b></span>`,
    )
    .join('');

  const pinned = state.profile.pinnedTags;
  const blockedTags = state.profile.blockedTags;

  const tags = video.tags
    .slice(0, 6)
    .map(
      (tag) =>
        `<button class="tag ${pinned[tag] ? 'is-pinned' : ''}` +
        `${blockedTags[tag] ? ' is-blocked' : ''}"` +
        ` data-tag="${escape(tag)}"` +
        ` title="左クリック: お気に入り（重みが下がりきらなくなる）／` +
        `右クリック: 除外（このタグの動画を候補から外す）"` +
        `>${escape(tag)}</button>`,
    )
    .join('');

  return `
<li class="card" data-id="${video.id}" style="--i:${position}">
  <div class="card-index">${String(position + 1).padStart(2, '0')}</div>

  <a class="card-thumb ${video.thumb ? '' : 'is-blank'}"
     href="https://www.nicovideo.jp/watch/${video.id}"
     target="_blank" rel="noopener noreferrer">
    ${thumbnail(video)}
    <span class="card-length">${formatLength(video.length)}</span>
  </a>

  <div class="card-body">
    <h3 class="card-title">
      <a href="https://www.nicovideo.jp/watch/${video.id}"
         target="_blank" rel="noopener noreferrer">${escape(video.title)}</a>
    </h3>

    ${uploaderRow(video)}

    <div class="card-meta">
      <span>${video.date}</span>
      <span class="num">再生 ${formatCount(video.view)}</span>
      <span class="num">マイリス ${formatCount(video.mylist)}</span>
      <span class="num">コメント ${formatCount(video.comment)}</span>
      ${video.rank ? `<span class="badge">ランク ${video.rank}位</span>` : ''}
    </div>

    <div class="card-tags">${tags}</div>

    <div class="card-why">
      <span class="fit">適合 <b>${fit}</b>%</span>
      ${parts || '<span class="chip is-idle">まだ判断材料がありません</span>'}
    </div>
  </div>

  <div class="card-rate" role="group" aria-label="評価">
    ${[1, 2, 3, 4, 5]
      .map(
        (score) =>
          `<button class="star" data-score="${score}" ` +
          `title="★${score}">${score}</button>`,
      )
      .join('')}
    <button class="skip" data-action="defer"
            title="今は判断できない（あとでまた出てきます）">保留</button>
  </div>
</li>`;
}

function markCard(id: string, verdict: string, mark: string): void {
  state.profile.session.marks[id] = { verdict, mark };

  const element = document.querySelector<HTMLElement>(
    `.card[data-id="${CSS.escape(id)}"]`,
  );
  if (!element) return;

  element.classList.add('is-done');
  element.dataset.mark = mark;

  const actions = element.querySelector('.card-rate');
  if (actions) {
    actions.innerHTML = `<span class="verdict">${escape(verdict)}</span>`;
  }
}

// ============================================================
// 描画：右パネル
// ============================================================

function renderPanel(): void {
  const model = state.profile.model;
  const ratings = Object.values(state.profile.ratings);
  const rated = ratings.filter((r) => r.score > 0).length;

  $('#stat-rated').textContent = String(rated);
  $('#stat-steps').textContent = String(model.steps);

  const log = state.profile.errorLog;
  const mae = log.length
    ? log.reduce((a, b) => a + b, 0) / log.length
    : null;

  $('#stat-error').textContent = mae === null ? '—' : mae.toFixed(2);

  $('#stat-remaining').textContent =
    candidatePool().length.toLocaleString('ja-JP');

  const waiting = Object.values(state.profile.deferred).filter(
    (held) => state.profile.actions < held.wake,
  ).length;

  $('#stat-deferred').textContent = String(waiting);
  $('#stat-blocked').textContent = blockedCount().toLocaleString('ja-JP');

  renderWeights();
  renderBlockedTags();
  renderFavorites();
  renderBlocked();
}

function renderWeights(): void {
  const model = state.profile.model;
  const pinned = state.profile.pinnedTags;

  // 投稿者の重みは出さない。IDを表示しない以上どの投稿者か区別できず、
  // 「投稿者」という行が並ぶだけで読めないため。モデルは使い続ける。
  const entries = topWeights(model, 2, 14).filter(
    (entry) => !entry.key.startsWith('user:'),
  );

  // お気に入りタグは、まだ観測数が少なくても必ず見せる
  for (const tag of Object.keys(pinned)) {
    const key = `tag:${tag}`;
    if (entries.some((entry) => entry.key === key)) continue;
    entries.push({
      key,
      weight: model.weights[key] ?? store.PIN_FLOOR,
      count: model.counts[key] ?? 0,
    });
  }

  entries.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  const container = $('#weights');

  if (entries.length === 0) {
    container.innerHTML =
      '<p class="hint">数本評価すると、ここに好みの重みが出てきます。</p>';
    return;
  }

  const max = Math.max(...entries.map((e) => Math.abs(e.weight)), 0.2);

  container.innerHTML = entries
    .map((entry) => {
      const ratio = (Math.abs(entry.weight) / max) * 100;
      const positive = entry.weight >= 0;
      const isPinned =
        entry.key.startsWith('tag:') && pinned[entry.key.slice(4)];
      return `
<div class="weight ${positive ? 'is-plus' : 'is-minus'}"
     data-kind="${featureKind(entry.key)}">
  <span class="weight-label ${isPinned ? 'is-pinned' : ''}">${
    isPinned ? '<i class="pin">★</i>' : ''
  }${escape(featureLabel(entry.key))}</span>
  <span class="weight-track">
    <span class="weight-bar" style="--w:${ratio}%"></span>
  </span>
  <span class="weight-value num">${positive ? '+' : ''}${entry.weight.toFixed(2)}</span>
</div>`;
    })
    .join('');
}

function poolCountByUser(): Map<string, number> {
  const counts = new Map<string, number>();

  for (const video of state.videos) {
    if (video.user) {
      counts.set(video.user, (counts.get(video.user) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * 投稿者の一覧（除外・お気に入り）。
 *
 * どちらも「何本あるか」を出す。除外なら candidates をどれだけ削ったか、
 * お気に入りなら、これから見に行ける本数の目安になる。
 */
function renderUserList(
  container: HTMLElement,
  notes: Record<string, store.UserNote>,
  action: 'unblock' | 'unfavorite',
  emptyText: string,
): void {
  const entries = Object.entries(notes);

  if (entries.length === 0) {
    container.innerHTML = `<p class="hint">${emptyText}</p>`;
    return;
  }

  const counts = poolCountByUser();

  container.innerHTML = entries
    .map(([user, note]) => {
      // 投稿者IDは出さないので、印を付けたときの動画名を手がかりにする
      return `
<div class="user-row is-tag">
  <a class="user-name" href="${userPageUrl(user)}"
     target="_blank" rel="noopener noreferrer"
     title="「${escape(note.sample)}」の投稿者">${escape(note.sample)}</a>
  <span class="user-count num">${counts.get(user) ?? 0}本</span>
  <button class="ghost-button" data-${action}="${escape(user)}">解除</button>
</div>`;
    })
    .join('');
}

function renderBlocked(): void {
  renderUserList(
    $('#blocked'),
    state.profile.blockedUsers,
    'unblock',
    'カードの「除外」で、その投稿者の動画を候補から丸ごと外せます。' +
      '好みの学習には影響しません。',
  );
}

/** 除外したタグの一覧。何本消しているかを出して、解除できるようにする。 */
function renderBlockedTags(): void {
  const blocked = Object.keys(state.profile.blockedTags);
  const container = $('#blocked-tags');

  if (blocked.length === 0) {
    container.innerHTML =
      '<p class="hint">カードのタグを右クリックすると、そのタグが付いた' +
      '動画を候補から丸ごと外せます。好みの学習には影響しません。</p>';
    return;
  }

  const counts = poolCountByTag();

  container.innerHTML = blocked
    .map(
      (tag) => `
<div class="user-row is-tag">
  <span class="user-name">${escape(tag)}</span>
  <span class="user-count num">${counts.get(tag) ?? 0}本</span>
  <button class="ghost-button" data-unblock-tag="${escape(tag)}">解除</button>
</div>`,
    )
    .join('');
}

function renderFavorites(): void {
  const favorites = state.profile.favoriteUsers;

  renderUserList(
    $('#favorites'),
    favorites,
    'unfavorite',
    'カードの「☆」で投稿者を控えておけます。候補の出方は変わりません。' +
      '名前をクリックすると、その投稿者の動画一覧をニコニコ側で開けます。',
  );
}

// ============================================================
// 操作
// ============================================================

/**
 * スライダーの値を profile に合わせ直す。
 * プロファイルを読み込み直したときにも呼ぶので、副作用は表示だけに留める。
 */
function syncControls(): void {
  const settings = state.profile.settings;

  const exploration = $<HTMLInputElement>('#exploration');
  exploration.value = String(Math.round(settings.exploration * 100));
  $('#exploration-value').textContent = exploration.value;

  const years = state.videos.map((v) => v.year).filter(Boolean);
  const oldest = Math.min(...years);
  const newest = Math.max(...years);

  const fromYear = $<HTMLInputElement>('#from-year');
  fromYear.min = String(oldest);
  fromYear.max = String(newest);
  settings.fromYear = Math.min(Math.max(settings.fromYear, oldest), newest);
  fromYear.value = String(settings.fromYear);
  $('#from-year-value').textContent = fromYear.value;
}

/** イベントの登録。起動時に一度だけ呼ぶ。 */
function bindEvents(): void {
  const exploration = $<HTMLInputElement>('#exploration');

  exploration.addEventListener('input', () => {
    state.profile.settings.exploration = Number(exploration.value) / 100;
    $('#exploration-value').textContent = exploration.value;
    store.save(state.profile);
  });

  const fromYear = $<HTMLInputElement>('#from-year');

  fromYear.addEventListener('input', () => {
    state.profile.settings.fromYear = Number(fromYear.value);
    $('#from-year-value').textContent = fromYear.value;
    store.save(state.profile);
    renderPanel();
  });

  $('#next-batch').addEventListener('click', () => nextBatch());

  $('#blocked').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-unblock]',
    );
    if (!button) return;

    delete state.profile.blockedUsers[button.dataset.unblock!];
    store.save(state.profile);
    renderPanel();
  });

  $('#blocked-tags').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-unblock-tag]',
    );
    if (!button) return;

    delete state.profile.blockedTags[button.dataset.unblockTag!];
    store.save(state.profile);
    refreshTagChips();
    renderPanel();
  });

  $('#favorites').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-unfavorite]',
    );
    if (!button) return;

    delete state.profile.favoriteUsers[button.dataset.unfavorite!];
    store.save(state.profile);
    refreshFavoriteButtons();
    renderPanel();
  });

  // タグは左クリックでお気に入り、右クリックで除外
  $('#cards').addEventListener('contextmenu', (event) => {
    const tag = (event.target as HTMLElement).closest<HTMLElement>('.tag');
    if (!tag) return;

    event.preventDefault();
    toggleBlockedTag(tag.dataset.tag ?? '');
  });

  $('#cards').addEventListener('click', (event) => {
    const tag = (event.target as HTMLElement).closest<HTMLElement>('.tag');
    if (tag) {
      togglePinnedTag(tag.dataset.tag ?? '');
      return;
    }

    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '.star, .skip, .mute, .fav',
    );
    if (!button) return;

    const card = button.closest<HTMLElement>('.card');
    if (!card || card.classList.contains('is-done')) return;

    const entry = state.batch.find((e) => e.item.id === card.dataset.id);
    if (!entry) return;

    const action = button.dataset.action;

    if (action === 'favorite') toggleFavorite(entry.item);
    else if (action === 'block') blockUser(entry.item);
    else if (action === 'defer') defer(entry.item);
    else rate(entry.item, Number(button.dataset.score));
  });

  // 1〜5 で評価、0 か s でスキップ。カーソルの下のカードが対象。
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key.toLowerCase();

    const known =
      (key >= '1' && key <= '5') ||
      key === '0' ||
      key === 's' ||
      key === 'b' ||
      key === 'f';
    if (!known) return;

    const card = document.querySelector<HTMLElement>('.card:hover');
    if (!card || card.classList.contains('is-done')) return;

    const entry = state.batch.find((e) => e.item.id === card.dataset.id);
    if (!entry) return;

    event.preventDefault();

    if (key === 'f') toggleFavorite(entry.item);
    else if (key === 'b') blockUser(entry.item);
    else if (key === '0' || key === 's') defer(entry.item);
    else rate(entry.item, Number(key));
  });

  /*
   * ニコニコ側へのリンクは必ず別ウィンドウで開く。
   *
   * アンカーには target="_blank" を付けてあるが、
   * 埋め込みブラウザなどこれを無視して同じ画面で遷移する環境がある。
   * 同じ画面で遷移すると、戻ってきたときに評価の途中経過が失われる。
   * （バッチ自体は復元するが、そもそも遷移させないほうが速い）
   */
  document.addEventListener('click', (event) => {
    // 修飾キー付きのクリックはブラウザ本来の動作に任せる
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;

    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
      'a[target="_blank"]',
    );
    if (!link || !link.href) return;

    event.preventDefault();
    window.open(link.href, '_blank', 'noopener,noreferrer');
  });

  // 大きい版のサムネイルが無い動画は通常版へ、それも無ければ枠だけ残す
  document.addEventListener(
    'error',
    (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;

      const fallback = image.dataset.fallback;

      if (fallback) {
        delete image.dataset.fallback;
        image.src = fallback;
      } else {
        image.closest('.card-thumb')?.classList.add('is-blank');
      }
    },
    true,
  );

  $('#export').addEventListener('click', exportProfile);
  $('#import').addEventListener('click', () => $('#import-file').click());
  $<HTMLInputElement>('#import-file').addEventListener('change', importProfile);

  $('#reset-candidates').addEventListener('click', () => {
    if (
      !confirm(
        '学習した好みは残したまま、評価済み・保留の記録を消して'
          + '候補を最初から出し直します。よろしいですか？',
      )
    ) {
      return;
    }

    store.resetCandidates(state.profile);

    // 表示中のバッチも捨てる。残しておくと、その10本だけが
    // リセット直後に保留へ送られてしまう。
    state.batch = [];
    state.batchNo = 0;

    store.save(state.profile);
    nextBatch();
  });

  $('#reset').addEventListener('click', () => {
    if (!confirm('学習した好みを消して最初からやり直しますか？')) return;
    store.clear();
    state.profile = store.emptyProfile();
    state.batch = [];
    state.batchNo = 0;
    syncControls();
    applyTheme();
    nextBatch();
  });

  $('#theme-toggle').addEventListener('click', () => {
    const settings = state.profile.settings;
    const order: store.Settings['theme'][] = ['auto', 'light', 'dark'];
    settings.theme =
      order[(order.indexOf(settings.theme) + 1) % order.length]!;
    store.save(state.profile);
    applyTheme();
  });
}

function applyTheme(): void {
  const theme = state.profile.settings.theme;
  document.documentElement.dataset.theme = theme;
  const label = { auto: '自動', light: '白', dark: '黒' }[theme];
  const button = document.querySelector('#theme-toggle');
  if (button) button.textContent = label;
}

function exportProfile(): void {
  const blob = new Blob([store.toJSON(state.profile)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nicoreco-profile.json';
  link.click();
  URL.revokeObjectURL(url);
}

async function importProfile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    state.profile = store.fromJSON(await file.text());
    store.save(state.profile);
    syncControls();
    applyTheme();
    nextBatch();
  } catch (error) {
    alert(`読み込めませんでした: ${(error as Error).message}`);
  }

  input.value = '';
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
