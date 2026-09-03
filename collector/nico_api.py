"""ニコニコ動画の各APIへのアクセス層。

- Snapshot 検索API v2 : 動画メタデータの一括取得（公式に提供されているAPI）
- ランキングページ     : ジャンルの母集団を順位付きで取得（HTMLから動画IDを抽出）

投稿者名・アイコン・投稿者の動画一覧を返す nvapi は使わない。
非公式の内部APIであることに加え、Snapshot API の利用規約 第4条(19)
「個人に関する情報の収集、蓄積行為」に触れうるため。
投稿者は Snapshot API が返す `userId` だけで扱う。

Snapshot API のリトライ／レート制御の方針は、既存の
`ボイロ劇場分析/nico_theater_collector.py` の実装を踏襲している。
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request


SNAPSHOT_URL = (
    "https://snapshot.search.nicovideo.jp/"
    "api/v2/snapshot/video/contents/search"
)

RANKING_URL = "https://www.nicovideo.jp/ranking/genre/{genre}"

APP_NAME = "NicoReco"

# Snapshot API の 1 リクエストあたり最大件数
LIMIT = 100

# contentId の OR フィルタはURL長の制約を受ける。
# 100件だと HTTP 414 (URI Too Long) になるため小さく刻む。
CONTENT_ID_CHUNK = 30

# _offset の上限（これを超えるページングは不可）
MAX_OFFSET = 100000

REQUEST_INTERVAL = 1.0

MAX_RETRIES = 5


# 取得するフィールド。
# 既存の収集では lengthSeconds を取っていなかったが、
# 動画長は嗜好の分岐に効くので追加している。
FIELDS = ",".join([
    "contentId",
    "title",
    "startTime",
    "viewCounter",
    "commentCounter",
    "mylistCounter",
    "likeCounter",
    "lengthSeconds",
    "tags",
    "userId",
    "channelId",
    "genre",
    "categoryTags",
    "thumbnailUrl",
])


# ============================================================
# 共通のHTTP
# ============================================================

def _get(url, headers=None, timeout=60):

    merged = {
        "User-Agent": f"{APP_NAME}/1.0"
    }

    if headers:
        merged.update(headers)

    request = urllib.request.Request(url, headers=merged)

    with urllib.request.urlopen(request, timeout=timeout) as response:

        return response.read().decode("utf-8", errors="replace")


# ============================================================
# Snapshot 検索API v2
# ============================================================

def snapshot_search(params, verbose=True):
    """Snapshot API を1回叩く。429/5xx は指数バックオフで再試行する。"""

    params = dict(params)

    params["_context"] = APP_NAME

    url = SNAPSHOT_URL + "?" + urllib.parse.urlencode(params)

    for attempt in range(MAX_RETRIES):

        try:

            return json.loads(_get(url))

        except urllib.error.HTTPError as e:

            code = e.code

            detail = e.read().decode("utf-8", errors="replace")

            if verbose:
                print(f"  HTTP {code}: {detail[:300]}")

            # 403 は待っても解決しない
            if code == 403:

                raise RuntimeError(
                    "HTTP 403 Forbidden。APIへのアクセスが拒否されました。"
                )

            # 400番台（429以外）はリクエストの作り方が悪いので即中断
            if 400 <= code < 500 and code != 429:

                raise RuntimeError(f"HTTP {code}: {detail[:300]}")

            wait = min(60, 5 * (2 ** attempt))

            if verbose:
                print(f"  {wait}秒待って再試行します...")

            time.sleep(wait)

        except Exception as e:

            if verbose:
                print(f"  通信エラー: {e}")

            time.sleep(min(60, 5 * (2 ** attempt)))

    raise RuntimeError("Snapshot APIへのアクセスに失敗しました。")


def search_by_tag(tag, offset=0, limit=LIMIT, sort="-startTime"):
    """タグ完全一致で検索する。"""

    return snapshot_search({
        "q": tag,
        "targets": "tagsExact",
        "fields": FIELDS,
        "_sort": sort,
        "_offset": offset,
        "_limit": limit,
    })


def search_by_json_filter(json_filter, offset=0, limit=LIMIT,
                          sort="-startTime"):
    """jsonFilter による検索。

    `_sort` は省略できない（省略すると QUERY_PARSE_ERROR になる）。
    フィルタに使えるフィールドは限られており、**userId は使えない**。
    """

    return snapshot_search({
        "q": "",
        "targets": "tagsExact",
        "fields": FIELDS,
        "jsonFilter": json.dumps(json_filter, ensure_ascii=False),
        "_sort": sort,
        "_offset": offset,
        "_limit": limit,
    })


def fetch_by_content_ids(content_ids):
    """動画IDのリストからメタデータをまとめて取得する。

    contentId の OR フィルタで、1リクエストあたり最大100件。
    """

    results = []

    ids = list(content_ids)

    for i in range(0, len(ids), CONTENT_ID_CHUNK):

        chunk = ids[i:i + CONTENT_ID_CHUNK]

        data = search_by_json_filter(
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
            limit=LIMIT,
        )

        results.extend(data.get("data", []))

        time.sleep(REQUEST_INTERVAL)

    return results


def tag_and_filter(tags, start_from=None, start_to=None):
    """複数タグのAND条件（＋任意で投稿日の範囲）を組み立てる。"""

    filters = [
        {
            "type": "equal",
            "field": "tagsExact",
            "value": tag,
        }
        for tag in tags
    ]

    if start_from or start_to:

        period = {
            "type": "range",
            "field": "startTime",
        }

        if start_from:
            period["from"] = start_from
            period["include_lower"] = True

        if start_to:
            period["to"] = start_to
            period["include_upper"] = True

        filters.append(period)

    if len(filters) == 1:
        return filters[0]

    return {
        "type": "and",
        "filters": filters,
    }


# ============================================================
# ランキング
# ============================================================

# 2025年のランキング改変で新設されたジャンル「音声合成実況・解説・劇場」。
# Snapshot API の genre フィールドは旧ジャンル体系のままなので、
# このジャンルの母集団はランキングページ側からしか辿れない。
GENRE_VOICE_SYNTH = "wnm2mhv0"

RANKING_TERMS = ["hour", "24h", "week", "month", "total"]

_VIDEO_ID_RE = re.compile(r"\b((?:sm|so|nm)\d{3,10})\b")


def fetch_ranking(genre=GENRE_VOICE_SYNTH, term="24h", page=1):
    """ランキングページから動画IDを順位順に取り出す。

    現在の ?rss=2.0 はHTMLを返すため使えない。
    サーバーサイドレンダリング済みのHTMLから動画IDを抽出している。
    戻り値は動画IDのリスト（重複除去済み・順位順）。
    """

    url = (
        RANKING_URL.format(genre=genre)
        + "?"
        + urllib.parse.urlencode({"term": term, "page": page})
    )

    html = _get(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; NicoReco/1.0)"
        },
    )

    found = _VIDEO_ID_RE.findall(html)

    # 出現順を保ったまま重複を除く
    return list(dict.fromkeys(found))
