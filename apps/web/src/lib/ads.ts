/**
 * A8.netの広告素材一覧。
 *
 * 以前は画面下部に固定したiframeで1枚だけ出していたが、
 * 地図とストリートビューを広く使うため、パネル（設定・順位・ヒント・記録）を
 * 開いたときだけ本文の下に出す方式へ変更した。
 * 素材はすべてここに登録し、AdSlot が順番に切り替えて全部を露出させる。
 *
 * href   … クリック先（計測用リダイレクト）
 * img    … バナー画像。テキスト広告のときは持たない
 * text   … テキスト広告の文言。画像広告のときは持たない
 * beacon … 表示計測用の1x1画像。素材ごとに必ず対で読み込む
 */
export interface AdCreative {
  id: string;
  sponsor: string;
  w: number;
  h: number;
  href: string;
  img?: string;
  text?: string;
  beacon: string;
}

/** パネル本文の下に出す大きめの枠（300x250） */
export const RECT_ADS: AdCreative[] = [
  {
    id: "kobe-003",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+5YZ75",
    img: "https://www22.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001003000&mc=1",
    beacon: "https://www14.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+5YZ75",
  },
  {
    id: "kobe-067",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+6CP0X",
    img: "https://www22.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001067000&mc=1",
    beacon: "https://www18.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+6CP0X",
  },
  {
    id: "kobe-011",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+60OXD",
    img: "https://www27.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001011000&mc=1",
    beacon: "https://www10.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+60OXD",
  },
  {
    id: "kobe-014",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+61C2P",
    img: "https://www22.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001014000&mc=1",
    beacon: "https://www15.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+61C2P",
  },
  {
    id: "kobe-020",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+62MDD",
    img: "https://www22.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001020000&mc=1",
    beacon: "https://www11.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+62MDD",
  },
  {
    id: "kobe-026",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+63WO1",
    img: "https://www27.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001026000&mc=1",
    beacon: "https://www18.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+63WO1",
  },
  {
    id: "kobe-062",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+6BMG1",
    img: "https://www28.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001062000&mc=1",
    beacon: "https://www19.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+6BMG1",
  },
  {
    id: "kobe-072",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+6DRLT",
    img: "https://www26.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001072000&mc=1",
    beacon: "https://www15.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+6DRLT",
  },
  {
    id: "kobe-077",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+6EU6P",
    img: "https://www20.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001077000&mc=1",
    beacon: "https://www19.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+6EU6P",
  },
  {
    id: "kobe-082",
    sponsor: "コンチェルト＆ルミナス神戸2",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+E4G7EA+59HO+6FWRL",
    img: "https://www29.a8.net/svt/bgt?aid=260731176854&wid=001&eno=01&mid=s00000024558001082000&mc=1",
    beacon: "https://www11.a8.net/0.gif?a8mat=4B8DGO+E4G7EA+59HO+6FWRL",
  },
  {
    id: "oku-004",
    sponsor: "おくりものマルシェ",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+BSI33M+5Q4K+5Z6WX",
    img: "https://www21.a8.net/svt/bgt?aid=260731176713&wid=001&eno=01&mid=s00000026714001004000&mc=1",
    beacon: "https://www11.a8.net/0.gif?a8mat=4B8DGO+BSI33M+5Q4K+5Z6WX",
  },
  {
    id: "niku-029",
    sponsor: "廣岡精肉店",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+64JTD",
    img: "https://www25.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001029000&mc=1",
    beacon: "https://www17.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+64JTD",
  },
  {
    id: "niku-006",
    sponsor: "廣岡精肉店",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+5ZMCH",
    img: "https://www29.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001006000&mc=1",
    beacon: "https://www15.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+5ZMCH",
  },
  {
    id: "niku-030",
    sponsor: "廣岡精肉店",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+64RJ5",
    img: "https://www22.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001030000&mc=1",
    beacon: "https://www17.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+64RJ5",
  },
  {
    id: "niku-031",
    sponsor: "廣岡精肉店",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+64Z8X",
    img: "https://www29.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001031000&mc=1",
    beacon: "https://www12.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+64Z8X",
  },
  {
    id: "niku-035",
    sponsor: "廣岡精肉店",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+65U41",
    img: "https://www20.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001035000&mc=1",
    beacon: "https://www16.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+65U41",
  },
  {
    id: "case-006",
    sponsor: "COVERARY",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+5ZMCH",
    img: "https://www28.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001006000&mc=1",
    beacon: "https://www13.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+5ZMCH",
  },
  {
    id: "case-010",
    sponsor: "COVERARY",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+60H7L",
    img: "https://www24.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001010000&mc=1",
    beacon: "https://www19.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+60H7L",
  },
  {
    id: "case-014",
    sponsor: "COVERARY",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+61C2P",
    img: "https://www27.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001014000&mc=1",
    beacon: "https://www18.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+61C2P",
  },
  {
    id: "oripa-003",
    sponsor: "どっかん！トレカ",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5AIQCY+5PLE+5YZ75",
    img: "https://www20.a8.net/svt/bgt?aid=260731177320&wid=001&eno=01&mid=s00000026645001003000&mc=1",
    beacon: "https://www10.a8.net/0.gif?a8mat=4B8DGP+5AIQCY+5PLE+5YZ75",
  },
  {
    id: "pixio-017",
    sponsor: "Pixio",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+HV0XE+XTI+15RZIP",
    img: "https://www26.a8.net/svt/bgt?aid=260731177030&wid=001&eno=01&mid=s00000004383007017000&mc=1",
    beacon: "https://www16.a8.net/0.gif?a8mat=4B8DGP+HV0XE+XTI+15RZIP",
  },
  {
    id: "pixio-016",
    sponsor: "Pixio",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+HV0XE+XTI+15RRSX",
    img: "https://www27.a8.net/svt/bgt?aid=260731177030&wid=001&eno=01&mid=s00000004383007016000&mc=1",
    beacon: "https://www15.a8.net/0.gif?a8mat=4B8DGP+HV0XE+XTI+15RRSX",
  },
  {
    id: "pixio-035",
    sponsor: "Pixio",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+HV0XE+XTI+15VUEP",
    img: "https://www24.a8.net/svt/bgt?aid=260731177030&wid=001&eno=01&mid=s00000004383007035000&mc=1",
    beacon: "https://www17.a8.net/0.gif?a8mat=4B8DGP+HV0XE+XTI+15VUEP",
  },
  {
    id: "gyu-006",
    sponsor: "やまなか家",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+58QFJM+5MTE+5ZMCH",
    img: "https://www23.a8.net/svt/bgt?aid=260731177317&wid=001&eno=01&mid=s00000026285001006000&mc=1",
    beacon: "https://www11.a8.net/0.gif?a8mat=4B8DGP+58QFJM+5MTE+5ZMCH",
  },
  {
    id: "gyu-011",
    sponsor: "やまなか家",
    w: 300,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+58QFJM+5MTE+60OXD",
    img: "https://www24.a8.net/svt/bgt?aid=260731177317&wid=001&eno=01&mid=s00000026285001011000&mc=1",
    beacon: "https://www14.a8.net/0.gif?a8mat=4B8DGP+58QFJM+5MTE+60OXD",
  },
  {
    id: "gyu-010",
    sponsor: "やまなか家",
    w: 250,
    h: 250,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+58QFJM+5MTE+60H7L",
    img: "https://www20.a8.net/svt/bgt?aid=260731177317&wid=001&eno=01&mid=s00000026285001010000&mc=1",
    beacon: "https://www13.a8.net/0.gif?a8mat=4B8DGP+58QFJM+5MTE+60H7L",
  },
];

/** ヒントなど、プレイ中に開くパネル用の小さい枠（320x50・120x60・100x60） */
export const BANNER_ADS: AdCreative[] = [
  {
    id: "niku-b005",
    sponsor: "廣岡精肉店",
    w: 320,
    h: 50,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+5ZEMP",
    img: "https://www25.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001005000&mc=1",
    beacon: "https://www15.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+5ZEMP",
  },
  {
    id: "niku-b014",
    sponsor: "廣岡精肉店",
    w: 320,
    h: 50,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+61C2P",
    img: "https://www26.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001014000&mc=1",
    beacon: "https://www12.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+61C2P",
  },
  {
    id: "niku-b015",
    sponsor: "廣岡精肉店",
    w: 320,
    h: 50,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+61JSH",
    img: "https://www23.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001015000&mc=1",
    beacon: "https://www13.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+61JSH",
  },
  {
    id: "niku-b019",
    sponsor: "廣岡精肉店",
    w: 320,
    h: 50,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+62ENL",
    img: "https://www26.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001019000&mc=1",
    beacon: "https://www11.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+62ENL",
  },
  {
    id: "niku-b037",
    sponsor: "廣岡精肉店",
    w: 320,
    h: 50,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+EVUWI+4WJK+669JL",
    img: "https://www28.a8.net/svt/bgt?aid=260731177025&wid=001&eno=01&mid=s00000022880001037000&mc=1",
    beacon: "https://www10.a8.net/0.gif?a8mat=4B8DGP+EVUWI+4WJK+669JL",
  },
  {
    id: "pixio-b018",
    sponsor: "Pixio",
    w: 320,
    h: 50,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+HV0XE+XTI+15S78H",
    img: "https://www27.a8.net/svt/bgt?aid=260731177030&wid=001&eno=01&mid=s00000004383007018000&mc=1",
    beacon: "https://www18.a8.net/0.gif?a8mat=4B8DGP+HV0XE+XTI+15S78H",
  },
  {
    id: "pixio-b019",
    sponsor: "Pixio",
    w: 320,
    h: 50,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+HV0XE+XTI+15SEY9",
    img: "https://www27.a8.net/svt/bgt?aid=260731177030&wid=001&eno=01&mid=s00000004383007019000&mc=1",
    beacon: "https://www18.a8.net/0.gif?a8mat=4B8DGP+HV0XE+XTI+15SEY9",
  },
  {
    id: "oku-t008",
    sponsor: "おくりものマルシェ",
    w: 120,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+BSI33M+5Q4K+601S1",
    img: "https://www24.a8.net/svt/bgt?aid=260731176713&wid=001&eno=01&mid=s00000026714001008000&mc=1",
    beacon: "https://www19.a8.net/0.gif?a8mat=4B8DGO+BSI33M+5Q4K+601S1",
  },
  {
    id: "oku-t006",
    sponsor: "おくりものマルシェ",
    w: 120,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGO+BSI33M+5Q4K+5ZMCH",
    img: "https://www29.a8.net/svt/bgt?aid=260731176713&wid=001&eno=01&mid=s00000026714001006000&mc=1",
    beacon: "https://www16.a8.net/0.gif?a8mat=4B8DGO+BSI33M+5Q4K+5ZMCH",
  },
  {
    id: "case-t003",
    sponsor: "COVERARY",
    w: 100,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+5YZ75",
    img: "https://www24.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001003000&mc=1",
    beacon: "https://www10.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+5YZ75",
  },
  {
    id: "case-t007",
    sponsor: "COVERARY",
    w: 100,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+5ZU29",
    img: "https://www26.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001007000&mc=1",
    beacon: "https://www14.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+5ZU29",
  },
  {
    id: "case-t011",
    sponsor: "COVERARY",
    w: 100,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+60OXD",
    img: "https://www26.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001011000&mc=1",
    beacon: "https://www15.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+60OXD",
  },
  {
    id: "gyu-t003",
    sponsor: "やまなか家",
    w: 100,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+58QFJM+5MTE+5YZ75",
    img: "https://www27.a8.net/svt/bgt?aid=260731177317&wid=001&eno=01&mid=s00000026285001003000&mc=1",
    beacon: "https://www18.a8.net/0.gif?a8mat=4B8DGP+58QFJM+5MTE+5YZ75",
  },
  {
    id: "gyu-t014",
    sponsor: "やまなか家",
    w: 100,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+58QFJM+5MTE+61C2P",
    img: "https://www26.a8.net/svt/bgt?aid=260731177317&wid=001&eno=01&mid=s00000026285001014000&mc=1",
    beacon: "https://www14.a8.net/0.gif?a8mat=4B8DGP+58QFJM+5MTE+61C2P",
  },
  {
    id: "gyu-t004",
    sponsor: "やまなか家",
    w: 120,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+58QFJM+5MTE+5Z6WX",
    img: "https://www21.a8.net/svt/bgt?aid=260731177317&wid=001&eno=01&mid=s00000026285001004000&mc=1",
    beacon: "https://www17.a8.net/0.gif?a8mat=4B8DGP+58QFJM+5MTE+5Z6WX",
  },
  {
    id: "gyu-text",
    sponsor: "やまなか家",
    w: 0,
    h: 0,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+58QFJM+5MTE+5YRHE",
    text: "本格的なお肉をご自宅で【やまなか家】",
    beacon: "https://www15.a8.net/0.gif?a8mat=4B8DGP+58QFJM+5MTE+5YRHE",
  },
  {
    id: "pixio-t011",
    sponsor: "Pixio",
    w: 120,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+HV0XE+XTI+15QP81",
    img: "https://www22.a8.net/svt/bgt?aid=260731177030&wid=001&eno=01&mid=s00000004383007011000&mc=1",
    beacon: "https://www17.a8.net/0.gif?a8mat=4B8DGP+HV0XE+XTI+15QP81",
  },
  {
    id: "case-t005",
    sponsor: "COVERARY",
    w: 120,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+5ZEMP",
    img: "https://www23.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001005000&mc=1",
    beacon: "https://www13.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+5ZEMP",
  },
  {
    id: "case-t009",
    sponsor: "COVERARY",
    w: 120,
    h: 60,
    href: "https://px.a8.net/svt/ejp?a8mat=4B8DGP+5EORLE+5V8G+609HT",
    img: "https://www28.a8.net/svt/bgt?aid=260731177327&wid=001&eno=01&mid=s00000027376001009000&mc=1",
    beacon: "https://www17.a8.net/0.gif?a8mat=4B8DGP+5EORLE+5V8G+609HT",
  },
];

export type AdVariant = "rect" | "banner";

/**
 * 同じ広告主が続けて出ないように並べ替える。
 * 素材が多い広告主（神戸クルーズなど）を素直に順番どおり出すと
 * 同じ店の広告が何回も続いてしまうため、残数の多い順に取りつつ
 * 直前と同じ広告主は避けて挟み込む。
 */
function interleaveBySponsor(list: AdCreative[]): AdCreative[] {
  const groups = new Map<string, AdCreative[]>();
  for (const ad of list) {
    const bucket = groups.get(ad.sponsor);
    if (bucket) bucket.push(ad);
    else groups.set(ad.sponsor, [ad]);
  }

  const queues = [...groups.entries()].map(([sponsor, items]) => ({ sponsor, items }));
  const out: AdCreative[] = [];
  let previous = "";

  while (out.length < list.length) {
    const remaining = queues
      .filter((q) => q.items.length > 0)
      .sort((a, b) => b.items.length - a.items.length);
    if (remaining.length === 0) break;
    const pick = remaining.find((q) => q.sponsor !== previous) ?? remaining[0];
    const next = pick.items.shift();
    if (!next) break;
    out.push(next);
    previous = pick.sponsor;
  }

  return out;
}

const ROTATION: Record<AdVariant, AdCreative[]> = {
  rect: interleaveBySponsor(RECT_ADS),
  banner: interleaveBySponsor(BANNER_ADS),
};

export function adsFor(variant: AdVariant): AdCreative[] {
  return ROTATION[variant];
}
