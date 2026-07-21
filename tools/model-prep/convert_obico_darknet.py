#!/usr/bin/env python3
"""Convert Obico's YOLOv2 darknet weights to ONNX (offline).

Obico only refreshes the DARKNET weights of its open failure-detection
model (ml_api/model/model-weights.darknet.url — improved 2025-12-18);
the ONNX variant they host was last built 2023-05 and is one
generation behind. This converter rebuilds the ONNX from any darknet
snapshot, emitting the exact output contract the 2023 ONNX had (and
apps/ml-worker/fnvr_ml/printmon.py + the Triton entry consume):

    boxes [1, 845, 1, 4]  — normalised x1,y1,x2,y2
    confs [1, 845, 1]     — sigmoid(objectness) (single class)

The reorg3d implementation mirrors the Reshape/Transpose sequence
found in Obico's own 2023 ONNX graph (Tianxiaomo-style), and the
converter is parity-verified against that ONNX using the matching-era
darknet weights (see --verify-against).

Pins:
  current (2025-12-18, "Improved darknet model"):
    https://tsd-pub-static.s3.us-east-1.amazonaws.com/ml-models/model-weights-ef79dacfd0051ab526f3002d5f5f9912.darknet
    sha256 3e6f7e3f166aa3a0ac08620949df71df853ac4b63af537f116be604bba54b292
  cfg: obico-server ml_api/model/model.cfg (YOLOv2-VOC shape, 1 class,
    5 anchors, unchanged by the 2025 retrain).

Usage:
  convert_obico_darknet.py --cfg model.cfg --weights new.darknet \
      --out deploy/models-cache/obico_failure.onnx \
      [--verify-against old.onnx --verify-weights old.darknet --image x.jpg]
"""
from __future__ import annotations

import argparse

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def parse_cfg(path: str) -> list[dict]:
    blocks: list[dict] = []
    cur: dict | None = None
    for raw in open(path):
        line = raw.split("#")[0].strip()
        if not line:
            continue
        if line.startswith("["):
            cur = {"type": line.strip("[]")}
            blocks.append(cur)
        elif "=" in line and cur is not None:
            k, v = line.split("=", 1)
            cur[k.strip()] = v.strip()
    return blocks


class Reorg(nn.Module):
    """Darknet reorg3d(stride) exactly as Obico's 2023 ONNX encodes it
    (view/transpose chain, NOT pixel_unshuffle)."""

    def __init__(self, stride: int):
        super().__init__()
        self.s = stride

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        s = self.s
        b, c, h, w = x.shape
        x = x.view(b, c, h // s, s, w // s, s).transpose(3, 4).contiguous()
        x = x.view(b, c, (h // s) * (w // s), s * s).transpose(2, 3).contiguous()
        x = x.view(b, c, s * s, h // s, w // s).transpose(1, 2).contiguous()
        return x.view(b, s * s * c, h // s, w // s)


class YoloV2(nn.Module):
    def __init__(self, blocks: list[dict]):
        super().__init__()
        self.blocks = blocks
        self.mods = nn.ModuleList()
        self.layer_kinds: list[dict] = []
        net = blocks[0]
        self.in_w = int(net["width"])
        self.in_h = int(net["height"])
        chans = [int(net.get("channels", 3))]
        for b in blocks[1:]:
            t = b["type"]
            if t == "convolutional":
                bn = b.get("batch_normalize", "0") == "1"
                filters = int(b["filters"])
                size = int(b["size"])
                stride = int(b["stride"])
                pad = (size - 1) // 2 if b.get("pad", "0") == "1" else 0
                conv = nn.Conv2d(chans[-1], filters, size, stride, pad, bias=not bn)
                seq: list[nn.Module] = [conv]
                if bn:
                    seq.append(nn.BatchNorm2d(filters, eps=1e-5))
                self.mods.append(nn.Sequential(*seq))
                self.layer_kinds.append({"t": "conv", "act": b.get("activation", "linear"), "bn": bn})
                chans.append(filters)
            elif t == "maxpool":
                self.mods.append(nn.MaxPool2d(int(b["size"]), int(b["stride"])))
                self.layer_kinds.append({"t": "pool"})
                chans.append(chans[-1])
            elif t == "route":
                refs = [int(x) for x in b["layers"].split(",")]
                self.mods.append(nn.Identity())
                self.layer_kinds.append({"t": "route", "refs": refs})
                total = 0
                for r in refs:
                    total += chans[r + len(chans) if r < 0 else r + 1]
                chans.append(total)
            elif t == "reorg3d":
                s = int(b["stride"])
                self.mods.append(Reorg(s))
                self.layer_kinds.append({"t": "reorg"})
                chans.append(chans[-1] * s * s)
            elif t == "region":
                self.anchors = [float(x) for x in b["anchors"].split(",")]
                self.num_anchors = int(b["num"])
                self.num_classes = int(b["classes"])
                self.mods.append(nn.Identity())
                self.layer_kinds.append({"t": "region"})
                chans.append(chans[-1])
            else:
                raise ValueError(f"unsupported block {t}")

    def forward(self, x: torch.Tensor):
        outs: list[torch.Tensor] = []
        for mod, kind in zip(self.mods, self.layer_kinds):
            if kind["t"] == "conv":
                x = mod(x)
                if kind["act"] == "leaky":
                    x = F.leaky_relu(x, 0.1)
                outs.append(x)
            elif kind["t"] in ("pool", "reorg"):
                x = mod(x)
                outs.append(x)
            elif kind["t"] == "route":
                parts = [outs[r if r >= 0 else len(outs) + r] for r in kind["refs"]]
                x = torch.cat(parts, dim=1) if len(parts) > 1 else parts[0]
                outs.append(x)
            elif kind["t"] == "region":
                return self.decode(x)
        raise RuntimeError("no region layer")

    def decode(self, head: torch.Tensor):
        """Region decode → (boxes [B,A*H*W,1,4] x1y1x2y2 norm,
        confs [B,A*H*W,1]). Single class → conf = sigmoid(obj)."""
        b, _, h, w = head.shape
        a = self.num_anchors
        nc = self.num_classes
        p = head.view(b, a, 5 + nc, h * w)
        gy, gx = torch.meshgrid(
            torch.arange(h, dtype=torch.float32),
            torch.arange(w, dtype=torch.float32),
            indexing="ij",
        )
        gx = gx.reshape(1, 1, h * w)
        gy = gy.reshape(1, 1, h * w)
        aw = torch.tensor(self.anchors[0::2], dtype=torch.float32).view(1, a, 1)
        ah = torch.tensor(self.anchors[1::2], dtype=torch.float32).view(1, a, 1)
        bx = (torch.sigmoid(p[:, :, 0]) + gx) / w
        by = (torch.sigmoid(p[:, :, 1]) + gy) / h
        bw = aw * torch.exp(p[:, :, 2]) / w
        bh = ah * torch.exp(p[:, :, 3]) / h
        conf = torch.sigmoid(p[:, :, 4])
        if nc > 1:
            conf = conf.unsqueeze(-1) * torch.softmax(p[:, :, 5:], dim=2)
            conf = conf.reshape(b, a * h * w, nc)
        else:
            conf = conf.reshape(b, a * h * w, 1)
        boxes = torch.stack(
            [bx - bw / 2, by - bh / 2, bx + bw / 2, by + bh / 2], dim=-1
        ).reshape(b, a * h * w, 1, 4)
        return boxes, conf


def load_darknet_weights(model: YoloV2, path: str) -> None:
    with open(path, "rb") as f:
        major, minor, _rev = np.fromfile(f, dtype=np.int32, count=3)
        if major * 10 + minor >= 2:
            np.fromfile(f, dtype=np.int64, count=1)  # seen
        else:
            np.fromfile(f, dtype=np.int32, count=1)
        buf = np.fromfile(f, dtype=np.float32)
    ptr = 0

    def take(n: int) -> torch.Tensor:
        nonlocal ptr
        out = torch.from_numpy(buf[ptr : ptr + n].copy())
        ptr += n
        return out

    for mod, kind in zip(model.mods, model.layer_kinds):
        if kind["t"] != "conv":
            continue
        conv: nn.Conv2d = mod[0]  # type: ignore[index]
        if kind["bn"]:
            bn: nn.BatchNorm2d = mod[1]  # type: ignore[index]
            n = bn.num_features
            bn.bias.data = take(n)
            bn.weight.data = take(n)
            bn.running_mean.data = take(n)
            bn.running_var.data = take(n)
        else:
            conv.bias.data = take(conv.out_channels)
        conv.weight.data = take(conv.weight.numel()).view_as(conv.weight)
    if ptr != len(buf):
        raise ValueError(f"weight count mismatch: consumed {ptr} of {len(buf)}")


def preprocess(img_path: str) -> np.ndarray:
    import cv2

    img = cv2.imread(img_path)
    resized = cv2.resize(img, (416, 416), interpolation=cv2.INTER_LINEAR)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    return (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, ...]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cfg", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--verify-against", help="reference ONNX for parity check")
    ap.add_argument("--verify-weights", help="darknet weights matching the reference ONNX")
    ap.add_argument("--image", help="real image for the parity check")
    args = ap.parse_args()

    blocks = parse_cfg(args.cfg)
    model = YoloV2(blocks)
    model.eval()

    if args.verify_against and args.verify_weights and args.image:
        import onnxruntime as ort

        load_darknet_weights(model, args.verify_weights)
        blob = preprocess(args.image)
        with torch.no_grad():
            mb, mc = model(torch.from_numpy(blob))
        sess = ort.InferenceSession(args.verify_against, providers=["CPUExecutionProvider"])
        rb, rc = sess.run(None, {sess.get_inputs()[0].name: blob})
        db = float(np.abs(mb.numpy() - rb).max())
        dc = float(np.abs(mc.numpy() - rc).max())
        print(f"parity vs reference: max|Δboxes|={db:.6f} max|Δconfs|={dc:.6f}")
        if db > 1e-3 or dc > 1e-3:
            raise SystemExit("PARITY FAILED — reorg/decode mismatch, do not ship")

    load_darknet_weights(model, args.weights)
    dummy = torch.zeros(1, 3, model.in_h, model.in_w)
    torch.onnx.export(
        model,
        dummy,
        args.out,
        input_names=["input"],
        output_names=["boxes", "confs"],
        opset_version=11,
        dynamo=False,
    )
    print(f"converted {args.weights} → {args.out}")


if __name__ == "__main__":
    main()
