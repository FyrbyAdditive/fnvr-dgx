package persons

import (
	"encoding/base64"
	"encoding/binary"
	"math"
	"testing"
)

func vec(dir int) []float32 {
	// Unit-ish vectors along different axes so cosine is crisp:
	// same axis → 1.0, different axis → 0.0.
	v := make([]float32, 512)
	v[dir] = 1
	return v
}

func b64Of(v []float32) string {
	raw := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(raw[i*4:], math.Float32bits(f))
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func TestScoreProbeAcceptance(t *testing.T) {
	alice := []EnrolledEmbedding{
		{PersonID: "a", Label: "alice", Vector: vec(0)},
		{PersonID: "a", Label: "alice", Vector: vec(0)},
	}
	bob := EnrolledEmbedding{PersonID: "b", Label: "bob", Vector: vec(1)}

	// Single person, probe on-axis → match.
	pid, label, sim, ok := scoreProbe(vec(0), alice, nil, 0.40, 0.05, 1.0)
	if !ok || pid != "a" || label != "alice" || sim < 0.99 {
		t.Fatalf("expected alice match, got ok=%v pid=%s sim=%v", ok, pid, sim)
	}

	// Below threshold → no match.
	if _, _, _, ok := scoreProbe(vec(5), alice, nil, 0.40, 0.05, 1.0); ok {
		t.Fatal("orthogonal probe must not match")
	}

	// Two persons, clear winner with margin → match.
	both := append(append([]EnrolledEmbedding{}, alice...), bob)
	if _, _, _, ok := scoreProbe(vec(0), both, nil, 0.40, 0.05, 1.0); !ok {
		t.Fatal("clear winner should match despite second person")
	}

	// Ambiguous probe (equal similarity to both) → margin veto.
	mix := make([]float32, 512)
	mix[0], mix[1] = 1, 1
	if _, _, _, ok := scoreProbe(mix, both, nil, 0.40, 0.05, 1.0); ok {
		t.Fatal("ambiguous probe must be vetoed by the margin rule")
	}

	// Negative veto: a dismissed embedding identical to the probe
	// wipes the score at weight 1.0.
	negs := []DismissedEmbedding{{Vector: vec(0)}}
	if _, _, _, ok := scoreProbe(vec(0), alice, negs, 0.40, 0.05, 1.0); ok {
		t.Fatal("negative veto should withdraw the match")
	}
	// ...but not at weight 0.
	if _, _, _, ok := scoreProbe(vec(0), alice, negs, 0.40, 0.05, 0); !ok {
		t.Fatal("negW=0 must disable the veto")
	}
}

func TestDecodeEmbeddingBase64(t *testing.T) {
	v := vec(3)
	got := decodeEmbeddingBase64(b64Of(v))
	if got == nil || got[3] != 1 || got[0] != 0 {
		t.Fatalf("round-trip failed: %v", got != nil)
	}
	if decodeEmbeddingBase64("nonsense!") != nil {
		t.Fatal("bad base64 must return nil")
	}
	if decodeEmbeddingBase64(base64.StdEncoding.EncodeToString([]byte("short"))) != nil {
		t.Fatal("wrong-length payload must return nil")
	}
}
