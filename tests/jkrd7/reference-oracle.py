#!/usr/bin/env python3
"""Read-only JKRD7 oracle for ModelShow's targeted JavaScript conformance tests.

Models, validation fixtures, and expected execution records come from the
canonical sibling JK project. No copy of its interpreter or rules lives here.
Only the selected JKRD7 cases below run; this is not the JK full regression.
"""

import copy
import hashlib
import json
import random
import sys
from pathlib import Path

JK = Path(__file__).resolve().parents[3] / "JK"
sys.path.insert(0, str(JK / "scripts"))
from jk_model import Model, PUBLISH  # noqa: E402
from jk_reference import (Reference, ASCII_MODEL, doc_models, doc_fragment, doc_block,
                          jkm, jks, inputs, random_model, random_script, shuffled)  # noqa: E402
from validate_jkrd7 import POSITIVE, NEGATIVE  # noqa: E402


CASES = []


def add(name, model, batches, watch=(), read=(), cut=3):
    model = copy.deepcopy(model)
    ref = Reference(Model(model, name), watch, read)
    checkpoint = None
    for batch_index, batch in enumerate(batches):
        for entry in batch:
            ref.inject(entry)
        if batch_index == 0:
            for _ in range(cut):
                if not ref.step():
                    break
            checkpoint = {"snapshot": ref.snapshot("checkpoint"), "recordCut": len(ref.record())}
        ref.run()
    record = ref.record()
    if checkpoint:
        checkpoint["remainingRecord"] = record[checkpoint.pop("recordCut"):]
    CASES.append({"name": name, "model": model, "batches": batches,
                  "observe": {"watch": list(watch), "read": list(read)},
                  "record": record, "snapshot": ref.snapshot("final"),
                  "checkpoint": checkpoint})


models = doc_models()
for name, batches in [
    ("M_FLOW", [["G1.Q1", "G1.Q3"]]),
    ("M_PATH", [["G1.Q1"]]),
    ("M_SYNC", [["G1.Q1", "G1.Q1", "G1.Q2"], ["G1.Q2"]]),
    ("M_TX", [["G1.Q10", "G1.Q10"]]),
    ("M_NEST", [["G1.Q10"]]),
    ("M_REG", [[f"G1.Q{i}"] for i in (2, 2, 1, 1, 2, 1)]),
]:
    all_paths = [".".join(p) for p in Model(models[name]).jki]
    add(name, models[name], batches, all_paths, all_paths, cut=4)
    add(name + " shuffled", shuffled(models[name], 7), batches, all_paths, all_paths, cut=2)

all_node = jkm("ALL", jks("G1", inputs("Q1", "Q2", "Q3") + [doc_fragment("Q8")],
                          {"any": ["Q1", "Q2", "Q3"]}))
add("JKI all A,A,B,B", all_node, [["G1.Q1", "G1.Q1", "G1.Q3", "G1.Q3"]], cut=2)

members = inputs("Q1", "Q2") + [
    {"id": "Q3", "q": 0, "trigger": {"any": ["Q1"]}, "sources": {"s": ["Q1"], "ex": ["K"]}},
    {"id": "Q4", "q": 0, "trigger": {"any": ["Q2"]}, "sources": {"s": ["Q2"], "ex": ["K"]}},
]
add("transaction A,A,B,B", jkm("ROUND", jks("G1", members, {"transaction": ["Q1", "Q2"]})),
    [["G1.Q1", "G1.Q1", "G1.Q2", "G1.Q2"]], cut=3)

# Exact seven publish modes, both empty EX and computation, including seed
# differing from q_before and same-valued q writes.
for mode, allowed in PUBLISH.items():
    for empty in (False, True):
        n = {"id": "Q2", "q": 1, "trigger": {"any": ["Q1"]},
             "sources": {"seed": 0, "s": ["Q1", "Q2", "Q2"], "ex": [] if empty else ["K", "K", "K"]},
             "publish": {mode: allowed}}
        add(f"publish {mode} {'empty' if empty else 'computed'}",
            jkm("PUBLISH", jks("G1", inputs("Q1") + [n], {"any": ["Q1"]})),
            [["G1.Q1", "G1.Q1"]], ["G1.Q2"], ["G1.Q2"], cut=1)

sort_model = jkm("SORT", jks("G1", inputs("Q1") + [
    jks("G10", [{"id": "Q1", "q": 1, "trigger": {"any": ["G1.Q1"]}}], {}),
    jks("G2", [{"id": "Q1", "q": 1, "trigger": {"any": ["G1.Q1"]}}], {}),
    {"id": "Q2", "q": 1, "trigger": {"any": ["Q1"]}},
], {"any": ["Q1"]}))
add("numeric hierarchical path ordering", sort_model, [["G1.Q1"]], cut=1)

for wait in (False, True):
    q3 = {"id": "Q3", "q": 0, "trigger": {"all": ["Q1", "G2.Q1"]} if wait else {"any": ["Q1"]},
          "sources": {"seed": 0, "s": ["G2.Q1"], "ex": ["K"]}}
    if wait:
        q3["runtime"] = {"trigger_all": [None, None]}
    g1 = jks("G1", inputs("Q1", "Q2") + [q3,
        {"id": "Q4", "q": 0, "trigger": {"any": ["Q2"]}, "sources": {"seed": 0, "s": ["Q2"], "ex": ["K"]}}],
        {"all": ["Q1", "Q2"]})
    g2 = jks("G2", [{"id": "Q1", "q": 0, "trigger": {"any": ["G1.Q2"]},
          "sources": {"seed": 0, "s": ["G1.Q2"], "ex": ["K"]}}], {})
    add("integration first, " + ("wait for fresh source" if wait else "read old source"),
        jkm("ORDER", g1, g2), [["G1.Q1", "G1.Q2"]], cut=2)

blocked = copy.deepcopy(models["M_TX"])
blocked["roots"][0]["members"][0]["q"] = 0
next(m for m in blocked["roots"][1]["members"] if m["id"] == "Q101")["publish"] = {"one": [1]}
add("transaction publish stops propagation", blocked, [["G1.Q10"]], ["G2.Q101"], ["G2.Q102"])

mixed = jks("G1", inputs("Q1", "Q2") + [
    {"id": "Q3", "q": 0, "trigger": {"any": ["Q1", "Q2"]}, "sources": {"seed": 0, "s": ["Q1"], "ex": ["K"]}},
], {"transaction": ["Q1"], "any": ["Q2"]})
add("transaction range entered through any", jkm("MIX", mixed), [["G1.Q2"]])

digits = json.loads(ASCII_MODEL.read_text(encoding="utf-8"))
watch, read = ["G1.Q24"], [f"G1.Q{i}" for i in (11, 12, 13, 14, 25, 26, 27, 28)]
add("ASCII sequential 0–9", digits, [[f"G1.Q{i}"] for i in range(1, 11)], watch, read)
add("ASCII overlapping 0–9", digits, [[f"G1.Q{i}" for i in range(1, 11)]], watch, read)
script = doc_block("run")
add("canonical §9.4 run script", digits, script["batches"], watch, read)
plain = copy.deepcopy(digits)
plain["roots"][0]["trigger"] = {"any": [f"Q{i}" for i in range(1, 11)]}
add("ASCII without transaction exposes overlap", plain, [["G1.Q1", "G1.Q2"]], watch, read)

rng = random.Random(700017)
for index in range(30):
    model = random_model(rng)
    paths = [".".join(p) for p in Model(model).jki]
    add(f"random model {index + 1:02}", model, random_script(rng), paths, paths, cut=index % 12)

sources = ["JKRD7.md", "scripts/jk_model.py", "scripts/jk_reference.py", "scripts/validate_jkrd7.py",
           "assets/ascii-bit-design/digits.jkm.json"]
print(json.dumps({
    "provenance": {str(JK / p): hashlib.sha256((JK / p).read_bytes()).hexdigest() for p in sources},
    "valid": [{"name": name, "model": factory()} for name, factory in POSITIVE],
    "invalid": [{"name": name, "model": factory()} for name, factory, _ in NEGATIVE],
    "cases": CASES, "script": script, "scriptModel": digits,
    "snapshot": doc_block("snapshot"), "snapshotModel": models["M_TX"],
}, ensure_ascii=False))
