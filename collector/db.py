"""SQLite スキーマとレコードの保存。

既存の `ボイロ劇場分析/nico_theater.db` をそのまま初期コーパスとして
使えるよう、videos / video_entry_tags / fetch_progress の3テーブルは
既存の定義を維持し、不足分だけ後方互換マイグレーションで追加する。
"""

import html
import sqlite3
from datetime import datetime, timezone


def connect(path):

    conn = sqlite3.connect(path)

    # 収集は数十分かかるものがあり、別のコマンドを並行して回したくなる。
    # 書き込み待ちを許して "database is locked" で落ちないようにする。
    conn.execute("PRAGMA busy_timeout = 30000")

    # WAL への切り替えには排他ロックが要る。
    # 既に別のプロセスが掴んでいるときは、そのままの journal_mode で続ける。
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass

    conn.execute("""
        CREATE TABLE IF NOT EXISTS videos (
            content_id TEXT PRIMARY KEY,
            title TEXT,
            start_time TEXT,
            year INTEGER,
            month TEXT,

            view_count INTEGER,
            comment_count INTEGER,
            mylist_count INTEGER,
            like_count INTEGER,

            tags TEXT,

            user_id TEXT,
            channel_id TEXT,
            genre TEXT,
            category_tags TEXT,

            first_seen_at TEXT
        )
    """)

    existing = {
        row[1] for row in conn.execute("PRAGMA table_info(videos)")
    }

    # 既存DBには存在しない列
    if "length_seconds" not in existing:
        conn.execute(
            "ALTER TABLE videos ADD COLUMN length_seconds INTEGER"
        )

    if "updated_at" not in existing:
        conn.execute("ALTER TABLE videos ADD COLUMN updated_at TEXT")

    # サムネイルURLは末尾にバージョン番号が付くことがあり、
    # 動画IDからは組み立てられない。APIが返す値をそのまま持つ。
    if "thumbnail_url" not in existing:
        conn.execute("ALTER TABLE videos ADD COLUMN thumbnail_url TEXT")

    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_videos_user_id
        ON videos (user_id)
    """)

    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_videos_start_time
        ON videos (start_time)
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS video_entry_tags (
            content_id TEXT,
            entry_tag TEXT,
            PRIMARY KEY (content_id, entry_tag)
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS fetch_progress (
            entry_tag TEXT PRIMARY KEY,
            next_offset INTEGER,
            total_count INTEGER,
            completed INTEGER
        )
    """)

    # ランキングでの観測。ジャンルの母集団と「勢い」の記録を兼ねる。
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ranking_entries (
            genre TEXT,
            term TEXT,
            observed_at TEXT,
            rank INTEGER,
            content_id TEXT,
            PRIMARY KEY (genre, term, observed_at, rank)
        )
    """)

    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_ranking_content
        ON ranking_entries (content_id)
    """)

    # その動画をどの経路で見つけたか（種まき / タグ拡張 / 投稿者拡張）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS discovery (
            content_id TEXT,
            source TEXT,
            detail TEXT,
            found_at TEXT,
            PRIMARY KEY (content_id, source, detail)
        )
    """)

    conn.commit()

    return conn


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_start_time(value):
    """"2026-09-02T04:00:00+09:00" -> (year, "2026-09")"""

    if not value:
        return None, None

    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None, None

    return dt.year, f"{dt.year:04d}-{dt.month:02d}"


def clean_text(value):
    """APIが返す文字列のHTMLエスケープを戻す。

    Snapshot API はタイトルを `&quot;` `&amp;` `&gt;` のように
    エスケープしたまま返してくる。そのまま持つと、表示側で
    もう一度エスケープされて `&quot;` が画面に出てしまう。
    保存の時点で本来の文字に戻しておく。
    """

    if not value:
        return value

    return html.unescape(value)


def normalize_tags(tags):
    """タグ文字列をリストにする。

    Snapshot API は半角スペース区切りで返すが、既存DB（ボイロ劇場分析）は
    タブ区切りで保存していた。タグ自体にはスペースを含められないので、
    空白文字ならどれでも区切りとして扱ってよい。
    """

    if not tags:
        return []

    if isinstance(tags, list):
        return [clean_text(t) for t in tags if t]

    return clean_text(tags).split()


def normalize_text_columns(conn):
    """保存済みのタイトルとタグを正規化する。

    - HTMLエスケープを戻す（APIがエスケープしたまま返してくる）
    - タグの区切りをスペースに揃える
      （既存DBを引き継いだぶんがタブ区切りのため）
    """

    rows = conn.execute(
        "SELECT content_id, title, tags FROM videos"
    ).fetchall()

    fixed = 0

    for content_id, title, tags in rows:

        new_title = clean_text(title)

        new_tags = " ".join(normalize_tags(tags)) if tags else tags

        if new_title != title or new_tags != tags:
            conn.execute(
                "UPDATE videos SET title = ?, tags = ? WHERE content_id = ?",
                (new_title, new_tags, content_id),
            )
            fixed += 1

    conn.commit()

    return fixed, len(rows)


def save_video(conn, item, source=None, detail=None):
    """Snapshot API の1件を videos に upsert する。

    カウンタ系は常に最新値で上書きし、初回発見時刻は保持する。
    """

    content_id = item.get("contentId")

    if not content_id:
        return False

    start_time = item.get("startTime")

    year, month = parse_start_time(start_time)

    tags = " ".join(normalize_tags(item.get("tags")))

    category_tags = " ".join(normalize_tags(item.get("categoryTags")))

    user_id = item.get("userId")

    channel_id = item.get("channelId")

    stamp = now()

    conn.execute(
        """
        INSERT INTO videos (
            content_id, title, start_time, year, month,
            view_count, comment_count, mylist_count, like_count,
            length_seconds, tags, user_id, channel_id, genre,
            category_tags, thumbnail_url, first_seen_at, updated_at
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(content_id) DO UPDATE SET
            title = excluded.title,
            view_count = excluded.view_count,
            comment_count = excluded.comment_count,
            mylist_count = excluded.mylist_count,
            like_count = excluded.like_count,
            length_seconds = COALESCE(
                excluded.length_seconds, videos.length_seconds
            ),
            tags = excluded.tags,
            user_id = COALESCE(excluded.user_id, videos.user_id),
            genre = COALESCE(excluded.genre, videos.genre),
            thumbnail_url = COALESCE(
                excluded.thumbnail_url, videos.thumbnail_url
            ),
            updated_at = excluded.updated_at
        """,
        (
            content_id,
            clean_text(item.get("title")),
            start_time,
            year,
            month,
            item.get("viewCounter"),
            item.get("commentCounter"),
            item.get("mylistCounter"),
            item.get("likeCounter"),
            item.get("lengthSeconds"),
            tags,
            str(user_id) if user_id is not None else None,
            str(channel_id) if channel_id is not None else None,
            item.get("genre"),
            category_tags,
            item.get("thumbnailUrl"),
            stamp,
            stamp,
        ),
    )

    if source:
        conn.execute(
            """
            INSERT OR IGNORE INTO discovery
                (content_id, source, detail, found_at)
            VALUES (?,?,?,?)
            """,
            (content_id, source, detail or "", stamp),
        )

    return True


def save_entry_tag(conn, content_id, entry_tag):

    conn.execute(
        """
        INSERT OR IGNORE INTO video_entry_tags (content_id, entry_tag)
        VALUES (?,?)
        """,
        (content_id, entry_tag),
    )


def get_progress(conn, entry_tag):

    row = conn.execute(
        """
        SELECT next_offset, total_count, completed
        FROM fetch_progress WHERE entry_tag = ?
        """,
        (entry_tag,),
    ).fetchone()

    if row is None:
        return 0, None, False

    return row[0] or 0, row[1], bool(row[2])


def save_progress(conn, entry_tag, next_offset, total_count, completed):

    conn.execute(
        """
        INSERT INTO fetch_progress
            (entry_tag, next_offset, total_count, completed)
        VALUES (?,?,?,?)
        ON CONFLICT(entry_tag) DO UPDATE SET
            next_offset = excluded.next_offset,
            total_count = excluded.total_count,
            completed = excluded.completed
        """,
        (entry_tag, next_offset, total_count, 1 if completed else 0),
    )

    conn.commit()


def save_ranking(conn, genre, term, observed_at, content_ids):

    for rank, content_id in enumerate(content_ids, start=1):

        conn.execute(
            """
            INSERT OR IGNORE INTO ranking_entries
                (genre, term, observed_at, rank, content_id)
            VALUES (?,?,?,?,?)
            """,
            (genre, term, observed_at, rank, content_id),
        )

    conn.commit()


def known_content_ids(conn, content_ids):
    """すでに length_seconds まで揃っているIDの集合を返す。"""

    known = set()

    ids = list(content_ids)

    for i in range(0, len(ids), 500):

        chunk = ids[i:i + 500]

        placeholders = ",".join("?" * len(chunk))

        rows = conn.execute(
            f"""
            SELECT content_id FROM videos
            WHERE content_id IN ({placeholders})
              AND length_seconds IS NOT NULL
              AND thumbnail_url IS NOT NULL
            """,
            chunk,
        )

        known.update(r[0] for r in rows)

    return known
