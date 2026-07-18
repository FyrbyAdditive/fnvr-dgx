#!/usr/bin/env python3
"""Export TopoFR R100 (Glint360K) to ONNX.

TopoFR (NeurIPS 2024, github.com/DanJun6737/TopoFR) is the embedder
for the aligned face stack — it replaces AdaFace IR-101 (see
docs/architecture/face-id.md). Run this OFFLINE, not at image build:
the checkpoint is Google-Drive-hosted (unreliable in CI) and 999 MB,
so the exported ONNX is committed to the build context instead
(deploy/models-cache/topofr_r100.onnx, gitignored, rsync-deployed).

Weights (pin):
  file : Glint360K_R100_TopoFR_9760.pt
  drive: https://drive.google.com/file/d/1vQBGXc_nXytEx8fpV9jykeLdxD45cE8B
  sha256: f92e5e61b326495d32803156ab60aa58abf7e17f84e83d38b5ff6bf1691bdbfe
  licence: repo publishes no LICENSE — research/personal use.

Contract (must match apps/ml-worker/fnvr_ml/inference.py):
  input : Nx3x112x112 RGB, ArcFace-aligned (norm_crop), (x/255-0.5)/0.5
  output: Nx512 raw embedding (L2-normalise downstream; the norm
          itself is kept as a quality signal).
The checkpoint bundles the 360K-class GUM classifier head (~740 MB);
the infer path never touches it, so tracing drops it and the ONNX is
~250 MB.

The IResNet definition below is vendored verbatim-in-spirit from
TopoFR backbones/iresnet.py (itself insightface arcface_torch),
trimmed to the iresnet100 infer path.
"""
from __future__ import annotations

import argparse
import hashlib

import torch
from torch import nn

CKPT_SHA256 = "f92e5e61b326495d32803156ab60aa58abf7e17f84e83d38b5ff6bf1691bdbfe"


def conv3x3(inp: int, out: int, stride: int = 1) -> nn.Conv2d:
    return nn.Conv2d(inp, out, kernel_size=3, stride=stride, padding=1, bias=False)


def conv1x1(inp: int, out: int, stride: int = 1) -> nn.Conv2d:
    return nn.Conv2d(inp, out, kernel_size=1, stride=stride, bias=False)


class IBasicBlock(nn.Module):
    expansion = 1

    def __init__(self, inplanes: int, planes: int, stride: int = 1,
                 downsample: nn.Module | None = None):
        super().__init__()
        self.bn1 = nn.BatchNorm2d(inplanes, eps=1e-05)
        self.conv1 = conv3x3(inplanes, planes)
        self.bn2 = nn.BatchNorm2d(planes, eps=1e-05)
        self.prelu = nn.PReLU(planes)
        self.conv2 = conv3x3(planes, planes, stride)
        self.bn3 = nn.BatchNorm2d(planes, eps=1e-05)
        self.downsample = downsample

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        identity = x
        out = self.bn1(x)
        out = self.conv1(out)
        out = self.bn2(out)
        out = self.prelu(out)
        out = self.conv2(out)
        out = self.bn3(out)
        if self.downsample is not None:
            identity = self.downsample(x)
        return out + identity


class IResNet(nn.Module):
    fc_scale = 7 * 7

    def __init__(self, layers: list[int], num_features: int = 512,
                 num_classes: int = 1):
        super().__init__()
        self.inplanes = 64
        self.conv1 = nn.Conv2d(3, 64, kernel_size=3, stride=1, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(64, eps=1e-05)
        self.prelu = nn.PReLU(64)
        self.layer1 = self._make_layer(64, layers[0])
        self.layer2 = self._make_layer(128, layers[1])
        self.layer3 = self._make_layer(256, layers[2])
        self.layer4 = self._make_layer(512, layers[3])
        self.bn2 = nn.BatchNorm2d(512, eps=1e-05)
        self.dropout = nn.Dropout(p=0, inplace=True)
        self.fc = nn.Linear(512 * self.fc_scale, num_features)
        self.features = nn.BatchNorm1d(num_features, eps=1e-05)
        # TopoFR keeps the GUM classifier prototype matrix as a model
        # parameter; it must exist for load_state_dict but is unused
        # in the infer path (so the ONNX trace drops it).
        self.weight = nn.Parameter(torch.zeros(num_classes, num_features))

    def _make_layer(self, planes: int, blocks: int) -> nn.Sequential:
        downsample = nn.Sequential(
            conv1x1(self.inplanes, planes, 2),
            nn.BatchNorm2d(planes, eps=1e-05),
        )
        layers = [IBasicBlock(self.inplanes, planes, 2, downsample)]
        self.inplanes = planes
        layers += [IBasicBlock(planes, planes) for _ in range(1, blocks)]
        return nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.conv1(x)
        x = self.bn1(x)
        x = self.prelu(x)
        x = self.layer1(x)
        x = self.layer2(x)
        x = self.layer3(x)
        x = self.layer4(x)
        x = self.bn2(x)
        x = torch.flatten(x, 1)
        x = self.dropout(x)
        x = self.fc(x)
        return self.features(x)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, help="Glint360K_R100_TopoFR_9760.pt")
    ap.add_argument("--out", default="deploy/models-cache/topofr_r100.onnx")
    ap.add_argument("--skip-sha", action="store_true")
    args = ap.parse_args()

    if not args.skip_sha:
        h = hashlib.sha256()
        with open(args.ckpt, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        assert h.hexdigest() == CKPT_SHA256, f"checkpoint sha mismatch: {h.hexdigest()}"

    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    num_classes = ckpt["weight"].shape[0]
    model = IResNet([3, 13, 30, 3], num_classes=num_classes)  # iresnet100
    model.load_state_dict(ckpt, strict=True)
    model.eval()

    dummy = torch.randn(1, 3, 112, 112)
    with torch.no_grad():
        emb = model(dummy)
    assert emb.shape == (1, 512), f"expected (1,512), got {tuple(emb.shape)}"

    torch.onnx.export(
        model, dummy, args.out,
        input_names=["input"], output_names=["embedding"],
        opset_version=17,
        dynamic_axes={"input": {0: "batch"}, "embedding": {0: "batch"}},
        dynamo=False,
    )
    print(f"topofr_r100 exported to {args.out} (512-d, {num_classes} train classes dropped)")


if __name__ == "__main__":
    main()
