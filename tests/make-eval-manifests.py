# -*- coding: utf-8 -*-
"""
tests/make-eval-manifests.py — recall近似(案X)とprecision(案Y)の評価データ生成

案X（合成不備でrecall近似）:
  正解事例PDFの「作成日」テキストをピンポイントで白塗り(redact)し、記載漏れの合成不備を作る。
  → 期待: creation_date(相当) が fail。ツールが「作成日なし」を捕まえられるか＝見逃し率の近似。
  作成日は表題欄にのみ出る情報なので、除去＝その項目が確実に不備になる（クリーンな合成）。

案Y（precision）:
  正解事例(無改変)で、承認図面なら確実にpassすべき表題欄コア項目を expect=pass にラベル。
  → ツールがそれを fail にしたら過剰指摘（落としすぎ）。

出力（すべて .gitignore 対象。実案件由来のため非公開）:
  tests/_synthetic/*.pdf            … 作成日を消した合成不備PDF
  tests/manifest.synthetic.json     … 案X用マニフェスト（expect fail）
  tests/manifest.precision.json     … 案Y用マニフェスト（expect pass）

使い方: python tests/make-eval-manifests.py [--per-type N]
"""
import os, re, sys, json, glob

try:
    import fitz  # PyMuPDF
except ImportError:
    print("PyMuPDF(fitz)が必要です: pip install pymupdf"); sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
INTEG_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
TOOL_DIR = {
    "mitori": "【設置場所見取図】_要件判定チェックツール",
    "heimen": "【平面図】_要件判定チェックツール",
    "haisen": "【配線ルート図】_要件判定チェックツール",
    "keitou": "【電気系統図】_要件判定チェックツール",
}
# 作成日チェックの項目ID（図面種別ごと）
DATE_ID = {"mitori": "creation_date", "heimen": "creation_date", "haisen": "creation_date", "keitou": "nev_date"}
# 図面名称の削除で不備化する（固有名称で検証可能な種別のみ。平面図は"平面図"が短く本文誤除去リスクのため除外）
TITLE_TEXT = {"mitori": "設置場所見取図", "haisen": "配線ルート図", "keitou": "電気系統図"}
TITLE_ID = {"mitori": "drawing_name", "haisen": "drawing_name", "keitou": "nev_title"}
# precision用: 承認図面で確実にpassすべきコア項目
CORE_PASS = {
    "mitori": ["setting_place", "drawing_name", "creator", "creation_date"],
    "heimen": ["setting_place", "drawing_name", "creator", "creation_date"],
    "haisen": ["setting_place", "drawing_name", "creator", "creation_date"],
    "keitou": ["nev_location", "nev_title", "nev_author", "nev_date"],
}
# 日付らしいテキストの検出（令和/西暦/R表記）
DATE_RE = re.compile(r"(令和|平成|R|Ｒ)\s*[0-9０-９]{1,2}\s*[年\.]|[12][0-9]{3}\s*年|[0-9]{4}[/／\.][0-9]{1,2}[/／\.][0-9]{1,2}")

OUT_DIR = os.path.join(HERE, "_synthetic")
os.makedirs(OUT_DIR, exist_ok=True)


def find_case_pdfs(dtype, per_type):
    tool = os.path.join(INTEG_ROOT, TOOL_DIR[dtype])
    hits = []
    for root, _, files in os.walk(tool):
        norm = root.replace("\\", "/")
        biz = "kiso" if "基礎_正解事例" in norm else ("mokutekichi" if "目的地_正解事例" in norm else None)
        if biz != "kiso":  # 合成はまず基礎で作る
            continue
        for f in files:
            if f.lower().endswith(".pdf"):
                hits.append((os.path.join(root, f), biz))
    return hits[:per_type]


def _date_present(doc):
    return any(DATE_RE.search(p.get_text("text") or "") for p in doc)


def redact_dates(src_path, dst_path):
    """作成日らしいテキストを redaction で実削除（テキスト層ごと除去）。
    削除後に日付テキストが残っていなければ (dst保存, 消せた矩形数) を返す。残存/未検出なら (None, 0)。"""
    doc = fitz.open(src_path)
    rects = 0
    for page in doc:
        found = []
        text = page.get_text("text") or ""
        for m in DATE_RE.finditer(text):
            found += page.search_for(m.group(0))
        for w in page.get_text("words"):
            if DATE_RE.search(w[4]):
                found.append(fitz.Rect(w[0], w[1], w[2], w[3]))
        for r in found:
            # 少し広げて確実に除去（近傍の年/月/日トークンも巻き込む）
            page.add_redact_annot(r + (-2, -1, 2, 1), fill=(1, 1, 1))
        if found:
            page.apply_redactions()
            rects += len(found)
    if rects == 0:
        doc.close(); return None, 0
    # 実削除の検証: まだ日付が読めるなら失敗扱い（クリーンな合成のみ採用）
    if _date_present(doc):
        doc.close(); return None, 0
    doc.save(dst_path)
    doc.close()
    return dst_path, rects


def redact_title(src_path, dst_path, title):
    """図面名称の文字列を redaction で実削除。削除検証を通れば (dst, 件数)、不可なら (None,0)。"""
    doc = fitz.open(src_path)
    rects = 0
    for page in doc:
        for r in page.search_for(title):
            page.add_redact_annot(r + (-2, -1, 2, 1), fill=(1, 1, 1))
            rects += 1
        if rects:
            page.apply_redactions()
    if rects == 0:
        doc.close(); return None, 0
    # 検証: 図面名称がもう見つからないこと
    still = any(title in (p.get_text("text") or "") for p in doc)
    if still:
        doc.close(); return None, 0
    doc.save(dst_path); doc.close()
    return dst_path, rects


def main():
    per_type = 2
    if "--per-type" in sys.argv:
        per_type = int(sys.argv[sys.argv.index("--per-type") + 1])

    synthetic, precision = [], []
    synthetic.append({"_guide": "案X: 作成日を消した合成不備。expect.items の項目がfail/warnで捕捉できれば見逃しなし。"})
    precision.append({"_guide": "案Y: 正解事例(無改変)。コア項目がfailなら過剰指摘。"})

    for dtype in TOOL_DIR:
        for src, biz in find_case_pdfs(dtype, per_type):
            name = os.path.splitext(os.path.basename(src))[0]
            # 案Y: 原本 → expect pass
            precision.append({
                "file": src.replace("\\", "/"), "type": dtype, "biz": biz,
                "expect": {"items": {cid: "pass" for cid in CORE_PASS[dtype]}},
            })
            # 案X: 作成日redact（テキスト実削除、削除検証を通過したものだけ採用）
            dst = os.path.join(OUT_DIR, f"{dtype}_{biz}_{name}_nodate.pdf")
            saved, n = redact_dates(src, dst)
            if saved:
                synthetic.append({
                    "file": dst.replace("\\", "/"), "type": dtype, "biz": biz,
                    "_masked": f"作成日テキスト {n} 箇所を実削除(redaction)",
                    "expect": {"items": {DATE_ID[dtype]: "fail"}},
                })
            else:
                print(f"  [skip] 作成日を実削除できず（画像埋込/分割等）: {name}")
            # 案X-2: 図面名称redact（固有名称の種別のみ）
            if dtype in TITLE_TEXT:
                dst2 = os.path.join(OUT_DIR, f"{dtype}_{biz}_{name}_notitle.pdf")
                saved2, n2 = redact_title(src, dst2, TITLE_TEXT[dtype])
                if saved2:
                    synthetic.append({
                        "file": dst2.replace("\\", "/"), "type": dtype, "biz": biz,
                        "_masked": f"図面名称「{TITLE_TEXT[dtype]}」を実削除(redaction) {n2}箇所",
                        "expect": {"items": {TITLE_ID[dtype]: "fail"}},
                    })
                else:
                    print(f"  [skip] 図面名称を実削除できず: {name}")

    with open(os.path.join(HERE, "manifest.synthetic.json"), "w", encoding="utf-8") as f:
        json.dump(synthetic, f, ensure_ascii=False, indent=2)
    with open(os.path.join(HERE, "manifest.precision.json"), "w", encoding="utf-8") as f:
        json.dump(precision, f, ensure_ascii=False, indent=2)
    print(f"生成: 合成不備 {len(synthetic)-1}件 / precision {len(precision)-1}件")
    print("  tests/manifest.synthetic.json, tests/manifest.precision.json, tests/_synthetic/*.pdf")


if __name__ == "__main__":
    main()
