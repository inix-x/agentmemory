#!/usr/bin/env python3
"""Offline rewrite of the graph row scopes. KTD3: parse offline, let the engine
write.

Reads a scope .bin, replaces each record's observation-id provenance with a
bounded backfill batch reference, and emits three JSON streams for the verbatim
row importer to load. Which records survive is the --mode choice: keep (the
default) emits every row, drop also discards the ones the live snapshot no
longer reaches. See KTD-R1.

    rows.json        the rewritten mem:graph:nodes / mem:graph:edges records
    batches.json     the mem:graph:batches rows those records point at
    obs-index.json   the mem:graph:obs-index entries U3's readers need
    summary.json     counts, the mode, and resetAt; the loader refuses without it

It never writes a .bin. Nothing outside the engine writes the engine's format,
which is the risk class KTD3 removes rather than tests against.

File layout, from the plan's appendix and verified on both production scopes:
the engine writes `rkyv::to_bytes(&KeyStorage(serde_json::to_string(scope_map)))`,
so the file is the scope's JSON object from offset 0 followed by a short rkyv
trailer, and the JSON body is data[0 : data.rfind(b"}") + 1]. A whole-file
json.loads is not available at 1 GB, so the top level is walked with a byte-state
machine and each record is parsed on its own.

Usage:
    rewrite.py --scope nodes --bin <path>.bin --snapshot <snapshot>.bin --out <dir>
               [--mode keep|drop] [--expect-reset-at <iso>] [--batch-chunk N]
               [--max-obs-pairs N]

The summary names the mode it ran in, and the loader reads that to decide
whether to carry resetAt forward (KTD-R8).
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

# One backfill batch row per this many distinct observation ids. 200,000 ids at
# 28 bytes is about 5.3 MiB, comfortably under the 15 MiB SAFE_PAYLOAD_BYTES the
# importer's guarded write checks. Production stays under the chunk: the larger
# scope cites 102,813 distinct ids and emits one row of about 2.8 MiB. The chunk
# bounds the shape for a corpus that would exceed it, since a single unbounded
# array under one key is what U1 exists to prevent.
BATCH_CHUNK_DEFAULT = 200_000

# Ceiling on (observation, row) pairs written to obs-index. Transposing the
# reachable corpus in full is 33,767,235 pairs, about 902 MiB, which is the size
# KTD2 rejects. The counter below is global and records are walked in .bin
# order, so the ceiling cuts on a row-position prefix: an id first seen past it
# gets no entry at all, an id already holding one stops collecting, and no
# reader can tell a short list from a complete one.
#
# The read path already landed. cascade.ts:42 reads obs-index to flag rows
# stale, so this is a live shortfall rather than a deferred one. On production's
# keep-mode emit the ceiling reaches 7,335 of 151,374 node rows and 31,695 of
# 282,724 edge rows; every row past the cut can never be flagged. A bounded
# backfill that KTD2 accepts is owed before graph retrieval is restored. The
# remedy cascade.ts names, mem::graph-index-backfill, rebuilds the full 902 MiB
# transpose and is itself over that budget.
MAX_OBS_PAIRS_DEFAULT = 2_000_000


def parse_records(path):
    """Yield (key, record) for every top-level entry of a scope file."""
    with open(path, "rb") as fh:
        data = fh.read()
    end = data.rfind(b"}")
    if end < 0:
        raise ValueError(f"{path}: no JSON body")
    body = data[: end + 1]
    yield from parse_body(body)


def parse_body(body):
    """Walk the top level of a JSON object, parsing one record at a time.

    Tracks string, escape, and brace depth. A key is the string that precedes a
    colon at depth 1; its value runs to the matching close.
    """
    i = 0
    n = len(body)
    while i < n and body[i : i + 1] != b"{":
        i += 1
    i += 1  # past the opening brace of the scope map

    while i < n:
        while i < n and body[i : i + 1] in (b" ", b",", b"\n", b"\r", b"\t"):
            i += 1
        if i >= n or body[i : i + 1] == b"}":
            return
        if body[i : i + 1] != b'"':
            i += 1
            continue
        # key
        j = i + 1
        esc = False
        while j < n:
            c = body[j : j + 1]
            if esc:
                esc = False
            elif c == b"\\":
                esc = True
            elif c == b'"':
                break
            j += 1
        key = json.loads(body[i : j + 1].decode("utf-8"))
        j += 1
        while j < n and body[j : j + 1] != b":":
            j += 1
        j += 1
        while j < n and body[j : j + 1] in (b" ", b"\n", b"\r", b"\t"):
            j += 1
        # value
        start = j
        depth = 0
        in_str = False
        esc = False
        while j < n:
            c = body[j : j + 1]
            if in_str:
                if esc:
                    esc = False
                elif c == b"\\":
                    esc = True
                elif c == b'"':
                    in_str = False
            elif c == b'"':
                in_str = True
            elif c in (b"{", b"["):
                depth += 1
            elif c in (b"}", b"]"):
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            elif depth == 0 and c == b",":
                break
            j += 1
        yield key, json.loads(body[start:j].decode("utf-8"))
        i = j


def read_reset_at(snapshot_path):
    for _key, record in parse_records(snapshot_path):
        if isinstance(record, dict) and "resetAt" in record:
            return record["resetAt"]
    return None


def rewrite(args):
    reset_at = read_reset_at(args.snapshot)
    if reset_at is None:
        raise SystemExit("refusing: the snapshot carries no resetAt to split on")

    # D2. A second reset between the census and the rewrite silently converts
    # every reachable row into an orphan, so a rewrite computed against the old
    # stamp would drop rows it should keep. Refuse rather than emit.
    if args.expect_reset_at and args.expect_reset_at != reset_at:
        raise SystemExit(
            "refusing: resetAt changed since it was recorded "
            f"(recorded {args.expect_reset_at}, snapshot now {reset_at}). "
            "Re-run the census against the current snapshot."
        )

    kind = "node" if args.scope == "nodes" else "edge"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    kept = []
    dropped = 0
    obs_seen = []
    obs_seen_set = set()
    obs_index = {}
    pairs = 0
    pair_ceiling_hit = False
    drop_orphans = args.mode == "drop"

    for key, record in parse_records(args.bin):
        # The predicate the writer uses at graph.ts:1149-1156 for nodes and
        # graph.ts:1205-1212 for edges, string-compared.
        # KTD-R1: keep mode caps provenance on these rows rather than discarding
        # them, because on production the predicate covers 149,732 of 151,374
        # nodes -- a month of real graph -- while capping alone is 93% of the
        # memory win. Drop stays reachable because it is still correct after a
        # real reset.
        if drop_orphans and record.get("createdAt", "") < reset_at:
            dropped += 1
            continue
        row_obs = record.get("sourceObservationIds") or []
        for obs_id in row_obs:
            if obs_id not in obs_seen_set:
                obs_seen_set.add(obs_id)
                obs_seen.append(obs_id)
            # No entry for an id first seen past the ceiling. readObsIndex
            # (graph-store.ts:227-236) returns an empty entry for a miss, so a
            # caller cannot tell "this observation touched no rows" from "the
            # ceiling cut before this id", and on a populated store those are
            # different answers. On the U2 emit 81,580 of the 106,025 cited ids
            # get no entry at all.
            if pairs < args.max_obs_pairs:
                entry = obs_index.setdefault(obs_id, {"nodes": [], "edges": []})
                entry["nodes" if kind == "node" else "edges"].append(record["id"])
                pairs += 1
            else:
                pair_ceiling_hit = True
        kept.append((key, record, row_obs))

    # Chunk the distinct observation ids into bounded backfill batch rows.
    batches = []
    obs_to_batch = {}
    for start in range(0, len(obs_seen), args.batch_chunk):
        chunk = obs_seen[start : start + args.batch_chunk]
        batch_id = f"gb_backfill_{args.scope}_{stamp}_{start // args.batch_chunk}"
        batches.append(
            {
                "id": batch_id,
                "observationIds": chunk,
                "createdAt": datetime.now(timezone.utc).isoformat().replace(
                    "+00:00", "Z"
                ),
            }
        )
        for obs_id in chunk:
            obs_to_batch[obs_id] = batch_id

    rows = []
    for key, record, row_obs in kept:
        batch_ids = []
        for obs_id in row_obs:
            b = obs_to_batch.get(obs_id)
            if b and b not in batch_ids:
                batch_ids.append(b)
        # Most recent last, capped the same way mergeNode caps.
        if len(batch_ids) > args.row_batch_cap:
            batch_ids = batch_ids[-args.row_batch_cap :]
        record["sourceObservationIds"] = []
        if batch_ids:
            record["sourceBatchIds"] = batch_ids
        else:
            record.pop("sourceBatchIds", None)
        rows.append({"key": key, "value": record})

    os.makedirs(args.out, exist_ok=True)
    write_json(os.path.join(args.out, f"{args.scope}.rows.json"), rows)
    write_json(os.path.join(args.out, f"{args.scope}.batches.json"), batches)
    write_json(
        os.path.join(args.out, f"{args.scope}.obs-index.json"),
        [{"key": k, "value": v} for k, v in obs_index.items()],
    )

    summary = {
        "scope": args.scope,
        "mode": args.mode,
        "resetAt": reset_at,
        "kept": len(rows),
        "dropped": dropped,
        "batches": len(batches),
        "observationIds": len(obs_seen),
        "obsIndexEntries": len(obs_index),
        "obsIndexPairs": pairs,
        "pairCeilingHit": pair_ceiling_hit,
    }
    write_json(os.path.join(args.out, f"{args.scope}.summary.json"), summary)
    json.dump(summary, sys.stdout)
    sys.stdout.write("\n")


def write_json(path, value):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scope", required=True, choices=["nodes", "edges"])
    ap.add_argument("--bin", required=True, help="the scope .bin to read")
    ap.add_argument("--snapshot", required=True, help="the mem:graph:snapshot scope file")
    ap.add_argument("--out", required=True, help="directory for the JSON streams")
    ap.add_argument(
        "--mode",
        choices=["keep", "drop"],
        default="keep",
        help="keep (default): cap provenance on every row. drop: also discard "
        "rows created before the snapshot's resetAt, the pre-U1 behavior.",
    )
    ap.add_argument("--expect-reset-at", default=None)
    ap.add_argument("--batch-chunk", type=int, default=BATCH_CHUNK_DEFAULT)
    ap.add_argument("--max-obs-pairs", type=int, default=MAX_OBS_PAIRS_DEFAULT)
    ap.add_argument("--row-batch-cap", type=int, default=32)
    rewrite(ap.parse_args(argv))


if __name__ == "__main__":
    main()
