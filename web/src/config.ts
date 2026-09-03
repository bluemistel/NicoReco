/**
 * サイトの表示情報。
 *
 * 公開前にここを自分の情報に書き換えてください。
 * フッターの「このサイトについて」に出ます。
 */
export const SITE = {
  /** サイト名 */
  name: 'NicoReco',

  /** 制作・運営者の名前やハンドル */
  author: 'あおもや',

  /** 連絡先。掲載除外の申し出もここで受けます */
  contact: {
    /** 表示ラベル */
    label: '@bluemist_im (X)',
    /** リンク先（mailto: や GitHub Issues のURL など） */
    url: 'https://x.com/bluemist_im',
  },

  /** ソースコードの置き場所。無ければ空文字にしてください */
  repository: '',
} as const;
