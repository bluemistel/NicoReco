"""候補プールを静的JSONとして書き出す。

Snapshot API は CORS ヘッダを返さないため、ブラウザから直接叩けない。
取得はここ（GitHub Actions / 手元）で済ませ、Webアプリには
静的JSONだけを配る、という分担にしている。

出力:
  web/public/data/index.json     シャードの一覧とタグ語彙
  web/public/data/pool-YYYY.json 年ごとの候補（配列の配列で軽量化）

使用例:
  python collector/export_pool.py --size 8000
  python collector/export_pool.py --size 8000 --no-backfill
"""

import argparse
import json
import math
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import collect
import db as dbm
import nico_api as api

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_DB = str(ROOT / "data" / "nico.db")

DEFAULT_OUT = str(ROOT / "web" / "public" / "data")


# シャード1件のカラム定義。Webアプリ側と共有する。
COLUMNS = [
    "id",       # contentId
    "t",        # title
    "g",        # tags（半角スペース区切り）
    "u",        # userId
    "d",        # startTime（YYYY-MM-DD）
    "v",        # 再生数
    "c",        # コメント数
    "m",        # マイリスト数
    "l",        # いいね数
    "s",        # 長さ（秒）
    "r",        # ランキング最高位（未掲載なら0）
    "th",       # サムネイルのファイル名部分（プレフィックスは共通）
]

# サムネイルURLの共通部分。JSON側では末尾だけを持つ。
THUMB_PREFIX = "https://nicovideo.cdn.nimg.jp/thumbnails/"

OPTOUT_PATH = Path(__file__).resolve().parent / "optout.txt"


def load_optout():
    """掲載除外リストを読む。

    掲載を望まない方の申し出をここで受ける。
    動画IDと `user:投稿者ID` の2種類を書ける。
    """

    videos, users = set(), set()

    if not OPTOUT_PATH.exists():
        return videos, users

    for line in OPTOUT_PATH.read_text(encoding="utf-8").splitlines():

        entry = line.split("#", 1)[0].strip()

        if not entry:
            continue

        if entry.startswith("user:"):
            users.add(entry[5:].strip())
        else:
            videos.add(entry)

    return videos, users


def is_theater(tags):
    """劇場形式の動画かどうか。

    このサイトは「ソフトウェアトーク劇場 / VOICEROID劇場」系の
    建て付けなので、候補はそれに絞る。ランキング掲載歴があっても、
    実況・車載・料理などは対象にしない。

    判定は「劇場」を含むタグが1つでもあるか。列挙にしないのは、
    DB内に劇場を含むタグが648種類あり、大文字小文字の揺れ
    （VOICEROID劇場 / voiceroid劇場）や派生
    （ボイロ一人称劇場・ホラーボイロ劇場・ゆかきり劇場）を
    追いきれないため。「劇場版」は映画の話なので除く。
    """

    for tag in (tags or "").split():
        if "劇場" in tag and "劇場版" not in tag:
            return True

    return False


def verify_alive(conn, content_ids):
    """まだ公開されている動画かどうかを確かめる。

    投稿者が消した動画・非公開にした動画は Snapshot API が返さなくなる。
    返ってこなかったものはDBから削除して、配信物からも消す。
    ついでに再生数などのカウンタも最新に入れ替わる。
    """

    targets = list(content_ids)

    alive = set()

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
            # 発見経路は増やさない（確認のたびに discovery が膨らむため）
            dbm.save_video(conn, item)
            alive.add(item.get("contentId"))

        conn.commit()

        if (i // api.CONTENT_ID_CHUNK) % 20 == 0:
            print(f"  確認 {i + len(chunk)}/{len(targets)}", flush=True)

        time.sleep(api.REQUEST_INTERVAL)

    gone = [cid for cid in targets if cid not in alive]

    # APIの一時的な不調で大量に消してしまわないための安全弁。
    # 実際の削除・非公開が1日で1割に達することはまず無い。
    limit = max(50, len(targets) // 10)

    if len(gone) > limit:
        raise RuntimeError(
            f"取得できなかった動画が {len(gone):,}件 と多すぎます"
            f"（上限 {limit:,}件）。APIの不調が疑われるため中断します。"
        )

    for i in range(0, len(gone), 500):

        chunk = gone[i:i + 500]

        placeholders = ",".join("?" * len(chunk))

        conn.execute(
            f"DELETE FROM videos WHERE content_id IN ({placeholders})",
            chunk,
        )

    conn.commit()

    return alive, gone


def fill_gaps(conn, args, optout, rounds=3):
    """欠けている項目を埋めてから選び直す、を落ち着くまで繰り返す。

    埋めると再生数などが更新され、選抜の顔ぶれが少し入れ替わる。
    入れ替わりで新たに入ったレコードがまた欠けていることがあるので、
    1回では終わらない。
    """

    selected, ranked = select_pool(
        conn, args.size, args.per_user_cap, args.seed, optout
    )

    for _ in range(rounds):

        missing = [
            row[0] for row in selected
            if row[9] is None or row[10] is None
        ]

        if not missing:
            break

        print(
            f"動画長／サムネイルが欠けている {len(missing):,}件を取得",
            flush=True,
        )

        collect.hydrate(conn, missing, source="export", detail="length")

        selected, ranked = select_pool(
            conn, args.size, args.per_user_cap, args.seed, optout
        )

    return selected, ranked


def quality(view, mylist, like, comment):
    """再生数の絶対値ではなく「濃さ」で並べるための素点。

    伸びた動画ばかりが出てくるのを避けつつ、
    最低限の品質フィルタとして効かせる。
    """

    view = view or 0
    mylist = mylist or 0
    like = like or 0
    comment = comment or 0

    if view < 100:
        return 0.0

    save_rate = (mylist + like) / view

    talk_rate = comment / view

    # 再生数は対数で軽く効かせる程度に留める
    return (
        math.log10(view + 1) * 0.6
        + min(save_rate, 0.3) * 12.0
        + min(talk_rate, 0.2) * 4.0
    )


def select_pool(conn, size, per_user_cap, seed, optout=None):
    """年ごとに層化して候補を選ぶ。

    各年の枠を「品質上位」と「無作為」で半分ずつ埋める。
    上位だけだと定番しか出てこず、無作為だけだと外れが多いため。
    """

    rng = random.Random(seed)

    opt_videos, opt_users = optout or (set(), set())

    ranked = dict(
        conn.execute(
            """
            SELECT content_id, MIN(rank) FROM ranking_entries
            GROUP BY content_id
            """
        )
    )

    years = [
        row[0]
        for row in conn.execute(
            "SELECT DISTINCT year FROM videos"
            " WHERE year IS NOT NULL ORDER BY year DESC"
        )
    ]

    # 直近の年ほど厚く配分する（指数減衰）
    weights = {
        year: 0.82 ** i for i, year in enumerate(years)
    }

    total_weight = sum(weights.values())

    selected = []

    for year in years:

        quota = max(20, int(size * weights[year] / total_weight))

        rows = conn.execute(
            """
            SELECT content_id, title, tags, user_id, start_time,
                   view_count, comment_count, mylist_count, like_count,
                   length_seconds, thumbnail_url
            FROM videos
            WHERE year = ? AND view_count IS NOT NULL
            """,
            (year,),
        ).fetchall()

        rows = [
            row for row in rows
            if row[0] not in opt_videos
            and (row[3] or "") not in opt_users
            and is_theater(row[2])
        ]

        if not rows:
            continue

        scored = sorted(
            rows,
            key=lambda r: quality(r[5], r[7], r[8], r[6]),
            reverse=True,
        )

        picked = []

        used = set()

        by_user = Counter()

        def take(candidates, limit):

            for row in candidates:

                if len(picked) >= limit:
                    break

                if row[0] in used:
                    continue

                user_id = row[3] or "?"

                if by_user[user_id] >= per_user_cap:
                    continue

                used.add(row[0])
                by_user[user_id] += 1
                picked.append(row)

        # 前半は品質上位から
        take(scored, quota // 2)

        # 後半は無作為に（発掘の余地を残す）
        shuffled = list(rows)
        rng.shuffle(shuffled)
        take(shuffled, quota)

        selected.extend(picked)

    # ランキング掲載分は年の枠に関係なく必ず入れる
    if ranked:

        have = {row[0] for row in selected}

        missing = [
            cid for cid in ranked
            if cid not in have and cid not in opt_videos
        ]

        for i in range(0, len(missing), 500):

            chunk = missing[i:i + 500]

            placeholders = ",".join("?" * len(chunk))

            selected.extend(
                conn.execute(
                    f"""
                    SELECT content_id, title, tags, user_id, start_time,
                           view_count, comment_count, mylist_count,
                           like_count, length_seconds, thumbnail_url
                    FROM videos WHERE content_id IN ({placeholders})
                    """,
                    chunk,
                ).fetchall()
            )

        # ランキング掲載歴があっても、劇場系でないものは入れない
        selected = [
            row for row in selected
            if (row[3] or "") not in opt_users and is_theater(row[2])
        ]

    return selected, ranked


def to_record(row, ranked):

    (content_id, title, tags, user_id, start_time,
     view, comment, mylist, like, length, thumbnail) = row

    # 共通プレフィックスを落として "46753898/46753898.75382279" だけ持つ
    thumb = (thumbnail or "").replace(THUMB_PREFIX, "")

    # DB側の区切りがどうであれ、配信するJSONはスペース区切りに揃える
    tag_text = " ".join(dbm.normalize_tags(tags))

    return [
        content_id,
        title or "",
        tag_text,
        user_id or "",
        (start_time or "")[:10],
        view or 0,
        comment or 0,
        mylist or 0,
        like or 0,
        length or 0,
        ranked.get(content_id, 0),
        thumb,
    ]


def main():

    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--size", type=int, default=8000)
    parser.add_argument("--per-user-cap", type=int, default=3)
    parser.add_argument("--vocab", type=int, default=1200,
                        help="特徴量に使うタグ語彙の数")
    parser.add_argument("--seed", type=int, default=20260903)
    parser.add_argument("--no-backfill", action="store_true",
                        help="欠けている動画長を取りに行かない")
    parser.add_argument("--no-verify", action="store_true",
                        help="公開が続いているかの確認を省略する")
    parser.add_argument("--allow-shrink", action="store_true",
                        help="候補が大きく減っていても書き出す")

    args = parser.parse_args()

    conn = dbm.connect(args.db)

    optout = load_optout()

    if optout[0] or optout[1]:
        print(
            f"掲載除外: 動画 {len(optout[0])}件 / 投稿者 {len(optout[1])}人"
        )

    if args.no_backfill:
        selected, ranked = select_pool(
            conn, args.size, args.per_user_cap, args.seed, optout
        )
    else:
        # 既存DB由来のレコードは動画長もサムネイルも持っていない
        selected, ranked = fill_gaps(conn, args, optout)

    print(f"候補 {len(selected):,}件を選択")

    # 削除・非公開になった動画を落とす。
    # 配る前に必ず通す（消したものが残り続けないように）。
    if not args.no_verify:

        print(f"公開が続いているか {len(selected):,}件を確認", flush=True)

        alive, gone = verify_alive(conn, [row[0] for row in selected])

        print(f"  取得できなくなっていた {len(gone):,}件を削除", flush=True)

        # 消えたぶんの枠が埋め直され、そこにまた未取得のレコードが
        # 入りうるので、確認のあとにもう一度そろえる
        if args.no_backfill:
            selected, ranked = select_pool(
                conn, args.size, args.per_user_cap, args.seed, optout
            )
        else:
            selected, ranked = fill_gaps(conn, args, optout)

    # 収集用のDBを失った状態で走ると、ランキング分だけの小さなプールが
    # できあがり、それを配ってしまう。既存の書き出しより大幅に減っていたら
    # 事故とみなして中断する。
    index_path = Path(args.out) / "index.json"

    if index_path.exists() and not args.allow_shrink:

        previous = json.loads(
            index_path.read_text(encoding="utf-8")
        ).get("total", 0)

        if previous and len(selected) < previous * 0.7:
            raise RuntimeError(
                f"候補が {previous:,}件 から {len(selected):,}件 へ大きく減りました。"
                " 収集用DBが失われている可能性があります。"
                " 意図した縮小なら --allow-shrink を付けてください。"
            )

    by_year = defaultdict(list)

    tag_counter = Counter()

    for row in selected:

        record = to_record(row, ranked)

        year = record[4][:4] or "unknown"

        by_year[year].append(record)

        for tag in record[2].split(" "):
            if tag:
                tag_counter[tag] += 1

    out_dir = Path(args.out)

    out_dir.mkdir(parents=True, exist_ok=True)

    for existing in out_dir.glob("pool-*.json"):
        existing.unlink()

    shards = []

    for year in sorted(by_year, reverse=True):

        items = by_year[year]

        name = f"pool-{year}.json"

        (out_dir / name).write_text(
            json.dumps(
                {"year": year, "columns": COLUMNS, "items": items},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )

        shards.append({
            "year": year,
            "file": name,
            "count": len(items),
        })

        print(f"  {name}: {len(items):,}件")

    vocab = [
        tag for tag, count in tag_counter.most_common(args.vocab)
        if count >= 2
    ]

    (out_dir / "index.json").write_text(
        json.dumps(
            {
                "generatedAt": dbm.now(),
                "genre": "音声合成実況・解説・劇場",
                "genreKey": "wnm2mhv0",
                "total": sum(s["count"] for s in shards),
                "columns": COLUMNS,
                "shards": shards,
                "tagVocab": vocab,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    print(f"index.json: {len(shards)}シャード / タグ語彙 {len(vocab)}語")

    conn.close()


if __name__ == "__main__":
    main()
