"""候補プールの収集CLI。

サブコマンド:
  ranking   ランキングから母集団を種まきする
  tags      タグ完全一致で深掘りする（過去へレジューム付きで拡張）
  expand    高評価動画の主要タグから「類似動画」を探索する
            （公開用プールを作る間は使わない。母集団が偏る）
  prune     誰かの好みから辿って集めた動画を落とす（公開用プールの中立化）
  backfill  既存レコードの欠損（lengthSeconds など）を埋める
  stats     DBの現状を表示する

使用例:
  python collector/collect.py ranking --terms 24h week month
  python collector/collect.py tags --tag ゆっくり実況 --max 2000
  python collector/collect.py expand --liked sm44943000,sm46753898
  python collector/collect.py stats
"""

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db as dbm
import nico_api as api


DEFAULT_DB = str(
    Path(__file__).resolve().parent.parent / "data" / "nico.db"
)


# 「音声合成実況・解説・劇場」ジャンルの入口タグ。
# 劇場系は既存DB（ボイロ劇場分析）で取得済みなので、
# 実況・解説側を足していくのが範囲拡大の主軸になる。
ENTRY_TAGS = [
    "ゆっくり実況",
    "ゆっくり解説",
    "VOICEROID実況プレイ",
    "VOICEROID解説",
    "ソフトウェアトーク実況プレイ",
    "ソフトウェアトーク解説",
    "VOICEVOX実況",
    "CeVIO実況プレイ",
    "A.I.VOICE実況プレイ",
    "音声合成実況",
    "VOICEROID劇場",
    "ソフトウェアトーク劇場",
]


# 拡張の対象にすると発散するだけの、内容を表さないタグ。
# このジャンルではキャラ名タグがほぼ全動画に付くため、
# 残しておくと「同じ声のソフトを使っただけの動画」に広がってしまう。
STOP_TAGS = {
    # 枠組みを表すタグ
    "ゆっくり実況", "ゆっくり実況プレイ", "ゆっくり解説", "ゆっくり劇場",
    "VOICEROID", "VOICEROID実況プレイ", "VOICEROID解説", "VOICEROID劇場",
    "ソフトウェアトーク", "ソフトウェアトーク実況プレイ",
    "ソフトウェアトーク解説", "ソフトウェアトーク劇場",
    "VOICEVOX", "VOICEVOX劇場", "CeVIO", "CeVIO劇場", "A.I.VOICE",
    "A.I.VOICE劇場", "VOICEPEAK", "COEIROINK", "CoeFont",
    "実況プレイ動画", "実況プレイpart1リンク", "解説", "音声合成",
    "例のアレ", "ニコニコ動画", "投稿者コメント", "字幕プレイ動画",

    # キャラクター名（声の選択であって、内容の傾向ではない）
    "結月ゆかり", "民安ともえ", "琴葉茜", "琴葉葵", "琴葉茜・葵",
    "東北きりたん", "東北ずん子", "東北イタコ", "紲星あかり",
    "弦巻マキ", "京町セイカ", "月読アイ", "月読ショウタ", "水奈瀬コウ",
    "桜乃そら", "ついなちゃん", "つくよみちゃん", "ずんだもん",
    "四国めたん", "春日部つむぎ", "雨晴はう", "波音リツ", "玄野武宏",
    "白上虎太郎", "青山龍星", "冥鳴ひまり", "九州そら", "もち子さん",
    "剣崎雌雄", "中国うさぎ", "麒ヶ島宗麟", "春歌ナナ", "猫使アル",
    "猫使ビィ", "小夜", "ナースロボ_タイプT", "後鬼", "No.7",
    "ちび式じい", "櫻歌ミコ", "小春六花", "夏色花梨", "花隈千冬",
    "IA", "ONE", "flower", "さとうささら", "すずきつづみ",
    "タカハシ", "ROSA", "夢前黎", "紅莉栖",
}


def log(*args):
    print(*args, flush=True)


# ============================================================
# ランキング種まき
# ============================================================

def cmd_ranking(conn, args):
    """ランキングページから母集団を取り、メタデータを埋める。"""

    observed_at = datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    )

    all_ids = []

    for term in args.terms:

        log(f"[ranking] genre={args.genre} term={term}")

        try:
            ids = api.fetch_ranking(genre=args.genre, term=term)
        except Exception as e:
            log(f"  取得失敗: {e}")
            continue

        log(f"  {len(ids)}件")

        dbm.save_ranking(conn, args.genre, term, observed_at, ids)

        all_ids.extend(ids)

        time.sleep(api.REQUEST_INTERVAL)

    unique = list(dict.fromkeys(all_ids))

    log(f"[ranking] 重複除去後 {len(unique)}件")

    hydrate(conn, unique, source="ranking", detail=args.genre)


def hydrate(conn, content_ids, source, detail="", skip_known=False):
    """動画IDのリストにメタデータを付けて保存する。"""

    targets = list(dict.fromkeys(content_ids))

    if skip_known:

        known = dbm.known_content_ids(conn, targets)

        targets = [c for c in targets if c not in known]

        log(f"  取得済みを除外して {len(targets)}件")

    if not targets:
        return 0

    saved = 0

    for i in range(0, len(targets), api.CONTENT_ID_CHUNK):

        chunk = targets[i:i + api.CONTENT_ID_CHUNK]

        data = api.search_by_json_filter(
            {
                "type": "or",
                "filters": [
                    {
                        "type": "equal",
                        "field": "contentId",
                        "value": cid,
                    }
                    for cid in chunk
                ],
            },
            limit=api.LIMIT,
        )

        for item in data.get("data", []):

            if dbm.save_video(conn, item, source=source, detail=detail):
                saved += 1

        conn.commit()

        log(f"  hydrate {i + len(chunk)}/{len(targets)} (保存 {saved})")

        time.sleep(api.REQUEST_INTERVAL)

    return saved


# ============================================================
# タグ深掘り
# ============================================================

def cmd_tags(conn, args):
    """タグ完全一致で新しい順に取得する。中断しても再開できる。"""

    tags = args.tag or ENTRY_TAGS

    for tag in tags:

        offset, total, completed = dbm.get_progress(conn, tag)

        if completed and not args.restart:
            log(f"[tags] {tag}: 取得済み（--restart で再取得）")
            continue

        if args.restart:
            offset, total, completed = 0, None, False

        log(f"[tags] {tag}: offset={offset} から開始")

        start_offset = offset

        saved = 0

        while True:

            if args.max and offset - start_offset >= args.max:
                log("  指定した上限に到達")
                break

            if offset >= api.MAX_OFFSET:
                log("  _offset の上限に到達（期間を区切って再取得が必要）")
                completed = True
                break

            data = api.search_by_tag(tag, offset=offset)

            meta = data.get("meta", {})

            batch = data.get("data", [])

            if total is None:
                total = meta.get("totalCount")
                log(f"  総件数 {total}")

            if not batch:
                completed = True
                break

            for item in batch:

                if dbm.save_video(conn, item, source="tag", detail=tag):
                    saved += 1

                dbm.save_entry_tag(conn, item.get("contentId"), tag)

            conn.commit()

            offset += len(batch)

            dbm.save_progress(conn, tag, offset, total, False)

            log(f"  {offset}/{total} (保存 {saved})")

            if total is not None and offset >= total:
                completed = True
                break

            time.sleep(api.REQUEST_INTERVAL)

        dbm.save_progress(conn, tag, offset, total, completed)


# ============================================================
# 類似動画の探索拡張
# ============================================================

def cmd_expand(conn, args):
    """高評価動画の主要タグから、過去へ探索を広げる。

    公開用のプールを作る間は使わないこと。誰かの好みが母集団に混ざる。
    使ってしまった場合は `prune` で落とせる。
    """

    liked = load_liked(args)

    if not liked:
        log("起点となる動画がありません。--liked か --profile を指定してください。")
        return

    log(f"[expand] 起点 {len(liked)}件: {', '.join(liked[:5])}"
        + (" ..." if len(liked) > 5 else ""))

    rows = fetch_local(conn, liked)

    missing = [c for c in liked if c not in rows]

    if missing:
        log(f"[expand] DB未収録 {len(missing)}件を先に取得")
        hydrate(conn, missing, source="seed", detail="liked")
        rows.update(fetch_local(conn, missing))

    expand_by_tags(conn, rows, args)


def load_liked(args):

    liked = []

    if args.liked:
        liked.extend(
            c.strip() for c in args.liked.split(",") if c.strip()
        )

    if args.profile:

        payload = json.loads(
            Path(args.profile).read_text(encoding="utf-8")
        )

        # web 側がエクスポートするプロファイル形式
        for content_id, entry in (payload.get("ratings") or {}).items():

            score = entry if isinstance(entry, (int, float)) \
                else entry.get("score", 0)

            if score >= args.min_score:
                liked.append(content_id)

    return list(dict.fromkeys(liked))


def fetch_local(conn, content_ids):

    result = {}

    ids = list(content_ids)

    for i in range(0, len(ids), 500):

        chunk = ids[i:i + 500]

        placeholders = ",".join("?" * len(chunk))

        for row in conn.execute(
            f"""
            SELECT content_id, title, tags, user_id, start_time
            FROM videos WHERE content_id IN ({placeholders})
            """,
            chunk,
        ):
            result[row[0]] = {
                "content_id": row[0],
                "title": row[1],
                "tags": dbm.normalize_tags(row[2]),
                "user_id": row[3],
                "start_time": row[4],
            }

    return result


def expand_by_tags(conn, rows, args):
    """高評価動画に共通する特徴的なタグの組み合わせで過去を探す。"""

    counter = Counter()

    for row in rows.values():
        for tag in row["tags"]:
            if tag and tag not in STOP_TAGS:
                counter[tag] += 1

    top = [tag for tag, _ in counter.most_common(args.tag_slots)]

    if not top:
        log("[expand/tags] 拡張に使えるタグがありません")
        return

    log(f"[expand/tags] 主要タグ: {', '.join(top)}")

    for tag in top:

        # 単独タグ + 期間指定で、古い側へ掘る
        json_filter = api.tag_and_filter(
            [tag],
            start_to=args.before,
        )

        found = []

        offset = 0

        while offset < args.per_tag:

            data = api.search_by_json_filter(
                json_filter,
                offset=offset,
                limit=min(api.LIMIT, args.per_tag - offset),
                sort=args.sort,
            )

            batch = data.get("data", [])

            if not batch:
                break

            for item in batch:

                if dbm.save_video(
                    conn, item, source="expand_tag", detail=tag
                ):
                    found.append(item.get("contentId"))

            conn.commit()

            offset += len(batch)

            time.sleep(api.REQUEST_INTERVAL)

        log(f"  {tag}: {len(found)}件")


def cmd_prune(conn, args):
    """特定の人の好みから辿って集めた動画を落とす。

    公開用のプールは全員に同じものが配られるので、
    `expand` や `uploader`（誰かの高評価を起点にする探索）で
    入ってきただけの動画は、母集団を偏らせる。

    ランキング掲載歴があるもの、タグ検索で入ってきたもの、
    既存コーパスのものは残す。
    """

    where = """
        WHERE EXISTS (
            SELECT 1 FROM discovery d
            WHERE d.content_id = v.content_id
              AND d.source IN ('expand_tag','expand_user','uploader','seed')
        )
        AND NOT EXISTS (
            SELECT 1 FROM video_entry_tags t
            WHERE t.content_id = v.content_id
        )
        AND NOT EXISTS (
            SELECT 1 FROM ranking_entries r
            WHERE r.content_id = v.content_id
        )
    """

    ids = [
        row[0]
        for row in conn.execute(f"SELECT v.content_id FROM videos v {where}")
    ]

    log(f"[prune] 削除対象 {len(ids):,}件")

    if args.dry_run:
        log("  --dry-run のため削除しません")
        return

    for i in range(0, len(ids), 500):

        chunk = ids[i:i + 500]

        placeholders = ",".join("?" * len(chunk))

        conn.execute(
            f"DELETE FROM videos WHERE content_id IN ({placeholders})",
            chunk,
        )
        conn.execute(
            f"DELETE FROM discovery WHERE content_id IN ({placeholders})",
            chunk,
        )

    conn.commit()

    log(f"[prune] {len(ids):,}件を削除")


def cmd_fix_text(conn, args):
    """保存済みのタイトルとタグを整える。

    - Snapshot API はタイトルをHTMLエスケープしたまま返すので戻す
    - タグの区切りをスペースに揃える（既存DBはタブ区切りだった）
    """

    fixed, total = dbm.normalize_text_columns(conn)

    log(f"[fix-text] {fixed:,}/{total:,}件を修正")


# ============================================================
# 欠損の埋め戻し
# ============================================================

def cmd_backfill(conn, args):
    """length_seconds が欠けているレコードを埋める。

    既存DBを流用しているため、初回はここで動画長を補う。
    """

    rows = conn.execute(
        """
        SELECT content_id FROM videos
        WHERE length_seconds IS NULL
        ORDER BY start_time DESC
        LIMIT ?
        """,
        (args.max,),
    ).fetchall()

    ids = [r[0] for r in rows]

    log(f"[backfill] 対象 {len(ids)}件")

    if ids:
        hydrate(conn, ids, source="backfill", detail="length")


# ============================================================
# 状況表示
# ============================================================

def cmd_stats(conn, args):

    total = conn.execute("SELECT COUNT(*) FROM videos").fetchone()[0]

    with_len = conn.execute(
        "SELECT COUNT(*) FROM videos WHERE length_seconds IS NOT NULL"
    ).fetchone()[0]

    span = conn.execute(
        "SELECT MIN(start_time), MAX(start_time) FROM videos"
    ).fetchone()

    log(f"動画          : {total:,}件")
    log(f"動画長あり    : {with_len:,}件")
    log(f"投稿日の範囲  : {span[0]} 〜 {span[1]}")

    log("\n年別:")
    for year, count in conn.execute(
        """
        SELECT year, COUNT(*) FROM videos
        WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 8
        """
    ):
        log(f"  {year}: {count:,}")

    log("\n発見経路:")
    for source, count in conn.execute(
        "SELECT source, COUNT(*) FROM discovery GROUP BY source"
        " ORDER BY COUNT(*) DESC"
    ):
        log(f"  {source}: {count:,}")

    log("\nランキング観測:")
    for genre, term, count in conn.execute(
        """
        SELECT genre, term, COUNT(DISTINCT content_id)
        FROM ranking_entries GROUP BY genre, term
        """
    ):
        log(f"  {genre}/{term}: {count:,}")


# ============================================================

def main():

    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument("--db", default=DEFAULT_DB)

    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("ranking", help="ランキングから種まき")
    p.add_argument("--genre", default=api.GENRE_VOICE_SYNTH)
    p.add_argument(
        "--terms", nargs="+", default=["24h", "week", "month"],
        choices=api.RANKING_TERMS,
    )
    p.set_defaults(func=cmd_ranking)

    p = sub.add_parser("tags", help="タグ完全一致で深掘り")
    p.add_argument("--tag", nargs="+")
    p.add_argument("--max", type=int, default=0, help="1タグあたりの上限")
    p.add_argument("--restart", action="store_true")
    p.set_defaults(func=cmd_tags)

    p = sub.add_parser("expand", help="高評価動画から類似探索")
    p.add_argument("--liked", help="動画IDのカンマ区切り")
    p.add_argument("--profile", help="web側からエクスポートしたJSON")
    p.add_argument("--min-score", type=float, default=4.0)
    p.add_argument("--tag-slots", type=int, default=6)
    p.add_argument("--per-tag", type=int, default=300)
    p.add_argument("--before", help="この日時より前を探す (ISO8601)")
    p.add_argument("--sort", default="-viewCounter")
    p.set_defaults(func=cmd_expand)

    p = sub.add_parser(
        "prune", help="誰かの好みから辿って集めた動画を落とす"
    )
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_prune)

    p = sub.add_parser(
        "fix-text", help="保存済みのタイトル・タグを正規化する"
    )
    p.set_defaults(func=cmd_fix_text)

    p = sub.add_parser("backfill", help="欠損項目の埋め戻し")
    p.add_argument("--max", type=int, default=2000)
    p.set_defaults(func=cmd_backfill)

    p = sub.add_parser("stats", help="DBの状況")
    p.set_defaults(func=cmd_stats)

    args = parser.parse_args()

    conn = dbm.connect(args.db)

    try:
        args.func(conn, args)
    finally:
        conn.commit()
        conn.close()


if __name__ == "__main__":
    main()
