#!/usr/bin/env python3
"""Generate small synthetic test PDFs (no third-party content) into argv[1].

Layout of the generated folder:
  中文 样例 论文.pdf      4 pages, Chinese, numbered headings, references [1]-[4], [3] crosses a page break
  english paper.pdf       2 pages, English, IEEE-style references
  sub/copy of english.pdf byte-identical duplicate of english paper.pdf
  blank.pdf               1 empty page, no references
  encrypted.pdf           password protected
  broken.pdf              not a PDF
  notes.txt               ignored (not .pdf)
Optional argv[2] == "variant": rewrite 中文 样例 论文.pdf with different content.
"""

import os
import shutil
import sys

import pymupdf

CJK = "china-s"


def put(page, y, text, size=10, font=CJK):
    page.insert_text((60, y), text, fontsize=size, fontname=font)
    return y + size * 1.6


def chinese(path, variant=False):
    doc = pymupdf.open()
    p = doc.new_page()
    y = put(p, 80, "多目标跟踪合成测试论文" + ("（修订版）" if variant else ""), 18)
    y = put(p, y + 10, "摘要", 14)
    y = put(p, y, "本文提出一种用于测试的多目标跟踪方法，结合卡尔")
    y = put(p, y, "曼滤波与外观特征进行数据关联。")
    y = put(p, y + 10, "1 引言", 14)
    y = put(p, y, "多目标跟踪是计算机视觉中的基础问题[1]。")
    p = doc.new_page()
    y = put(p, 80, "2 方法", 14)
    y = put(p, y, "状态预测采用匀速模型 x(k+1) = F x(k) + w(k)。")
    y = put(p, y, "关联代价由马氏距离与余弦距离加权得到[2,3]。")
    y = put(p, y + 10, "3 实验", 14)
    y = put(p, y, "在合成数据集上 MOTA 达到 75.6，IDF1 达到 70.1。")
    for i in range(30):
        y = put(p, y, f"合成正文第{i + 1:02d}行，用于测试分页读取与截断续读。")
    p = doc.new_page()
    y = put(p, 80, "4 结论", 14)
    y = put(p, y, "本文方法在测试集上有效。")
    y = put(p, y + 10, "参考文献", 14)
    y = put(p, y, "[1] 张三, 李四. 基于检测的多目标跟踪综述[J]. 计算机学报, 2021, 44(3): 1-20.")
    y = put(p, y, "[2] 王五, 赵六. 卡尔曼滤波在车辆跟踪中的应用[J]. 自动化学报,")
    y = put(p, y, "2020, 46(12): 2690-2700.")
    y = put(p, 780, "[3] 陈七, 周八. 一种跨页的参考文献条目用于测试页码定位")
    p = doc.new_page()
    y = put(p, 80, "[J]. 软件学报, 2019, 30(5): 100-110.")
    y = put(p, y, "[4] 吴九. 多目标跟踪评价指标研究[D]. 北京: 某大学, 2018.")
    doc.save(path)


def english(path):
    doc = pymupdf.open()
    p = doc.new_page()
    y = put(p, 80, "A Synthetic Paper About Object Tracking", 18, "helv")
    y = put(p, y + 10, "1 Introduction", 14, "helv")
    y = put(p, y, "Tracking-by-detection with a Kalman filter is a strong baseline [1].", 10, "helv")
    p = doc.new_page()
    y = put(p, 80, "References", 14, "helv")
    y = put(p, y, '[1] A. Author and B. Writer, "Simple online tracking with a synthetic', 10, "helv")
    y = put(p, y, 'baseline," in Proceedings of the Test Conference, 2016, pp. 1-5.', 10, "helv")
    y = put(p, y, '[2] C. Person, "Another synthetic reference for testing purposes," IEEE', 10, "helv")
    y = put(p, y, "Transactions on Testing, vol. 1, 2020. doi:10.1234/test.2020.01", 10, "helv")
    doc.save(path)


def main():
    out = sys.argv[1]
    os.makedirs(os.path.join(out, "sub"), exist_ok=True)
    if len(sys.argv) > 2 and sys.argv[2] == "variant":
        chinese(os.path.join(out, "中文 样例 论文.pdf"), variant=True)
        return
    chinese(os.path.join(out, "中文 样例 论文.pdf"))
    english(os.path.join(out, "english paper.pdf"))
    shutil.copyfile(os.path.join(out, "english paper.pdf"), os.path.join(out, "sub", "copy of english.pdf"))
    doc = pymupdf.open()
    doc.new_page()
    doc.save(os.path.join(out, "blank.pdf"))
    doc = pymupdf.open()
    put(doc.new_page(), 80, "secret", 12, "helv")
    doc.save(os.path.join(out, "encrypted.pdf"), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw2")
    with open(os.path.join(out, "broken.pdf"), "wb") as fh:
        fh.write(b"this is not a pdf at all\n" * 10)
    with open(os.path.join(out, "notes.txt"), "w", encoding="utf-8") as fh:
        fh.write("ignored")


if __name__ == "__main__":
    main()
