# 查询欠费来源：按产品/计费项维度汇总账单
import os
from alibabacloud_bssopenapi20171214.client import Client as BssClient
from alibabacloud_bssopenapi20171214 import models as bm
from alibabacloud_tea_openapi import models as oa

c = BssClient(oa.Config(
    access_key_id=os.environ["AK_ID"],
    access_key_secret=os.environ["AK_SECRET"],
    endpoint="business.aliyuncs.com",
))

for cycle in ("2026-09", "2026-08"):
    print("=" * 62)
    print(f"【账单 {cycle}】")
    try:
        req = bm.QueryInstanceBillRequest(billing_cycle=cycle, page_num=1,
                                          page_size=300, is_hide_zero_charge=False)
        r = c.query_instance_bill(req)
        d = r.body.data if r.body else None
        raw = (d.items if d is not None else None)
        # SDK 返回包装对象，真正的列表在 .item 字段
        items = (getattr(raw, "item", None) if raw is not None else None) or \
                (raw if isinstance(raw, list) else []) or []
        if not items:
            print("   无账单记录")
            continue
        by_prod, by_item = {}, {}
        total = 0.0
        for it in items:
            pn = getattr(it, "product_name", None) or getattr(it, "product_code", "?")
            bi = getattr(it, "billing_item", None) or "?"
            amt = float(getattr(it, "pretax_amount", 0) or 0)
            total += amt
            by_prod[pn] = by_prod.get(pn, 0) + amt
            by_item[(pn, bi)] = by_item.get((pn, bi), 0) + amt
        print(f"   明细条数 {len(items)}  合计(税前) {total:.4f} 元")
        print("   -- 按产品 --")
        for pn, amt in sorted(by_prod.items(), key=lambda x: -x[1]):
            print(f"      {pn}: {amt:.4f} 元")
        print("   -- 按计费项 --")
        for (pn, bi), amt in sorted(by_item.items(), key=lambda x: -x[1]):
            print(f"      {pn} / {bi}: {amt:.4f} 元")
    except Exception as e:
        print("   查询失败:", str(e)[:250])
    print()
