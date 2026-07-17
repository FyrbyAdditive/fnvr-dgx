package persons

import (
	"math"
	"reflect"
	"testing"
)

// unit512 builds a 512-d unit vector pointing along axis i.
func unit512(i int) []float32 {
	v := make([]float32, 512)
	v[i] = 1
	return v
}

// blend512 mixes two unit axes so the result has a chosen cosine to
// the first: cos(theta) to unit512(a).
func blend512(a, b int, cosToA float64) []float32 {
	v := make([]float32, 512)
	v[a] = float32(cosToA)
	v[b] = float32(math.Sqrt(1 - cosToA*cosToA))
	return v
}

func TestPruneEnrolBatch(t *testing.T) {
	tests := []struct {
		name        string
		existing    [][]float32
		cands       [][]float32
		maxSim      float64
		maxNew      int
		wantKeep    []int
		wantSkipped int
	}{
		{
			name:        "diverse batch all kept",
			cands:       [][]float32{unit512(0), unit512(1), unit512(2)},
			maxSim:      0.90,
			maxNew:      8,
			wantKeep:    []int{0, 1, 2},
			wantSkipped: 0,
		},
		{
			name:        "in-batch near-duplicate skipped",
			cands:       [][]float32{unit512(0), blend512(0, 1, 0.95), unit512(2)},
			maxSim:      0.90,
			maxNew:      8,
			wantKeep:    []int{0, 2},
			wantSkipped: 1,
		},
		{
			name:        "near-duplicate of existing pool skipped",
			existing:    [][]float32{unit512(0)},
			cands:       [][]float32{blend512(0, 1, 0.95), unit512(2)},
			maxSim:      0.90,
			maxNew:      8,
			wantKeep:    []int{1},
			wantSkipped: 1,
		},
		{
			name:        "identical resubmission fully skipped",
			existing:    [][]float32{unit512(0)},
			cands:       [][]float32{unit512(0)},
			maxSim:      0.90,
			maxNew:      8,
			wantKeep:    []int{},
			wantSkipped: 1,
		},
		{
			name:        "cap stops keeping, remainder counted skipped",
			cands:       [][]float32{unit512(0), unit512(1), unit512(2), unit512(3)},
			maxSim:      0.90,
			maxNew:      2,
			wantKeep:    []int{0, 1},
			wantSkipped: 2,
		},
		{
			name:        "similar but below maxSim is kept",
			existing:    [][]float32{unit512(0)},
			cands:       [][]float32{blend512(0, 1, 0.85)},
			maxSim:      0.90,
			maxNew:      8,
			wantKeep:    []int{0},
			wantSkipped: 0,
		},
		{
			name:        "first-come priority within batch",
			cands:       [][]float32{blend512(0, 1, 0.95), unit512(0)},
			maxSim:      0.90,
			maxNew:      8,
			wantKeep:    []int{0},
			wantSkipped: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			keep, skipped := PruneEnrolBatch(tt.existing, tt.cands, tt.maxSim, tt.maxNew)
			if len(keep) == 0 {
				keep = []int{}
			}
			if !reflect.DeepEqual(keep, tt.wantKeep) {
				t.Errorf("keep = %v, want %v", keep, tt.wantKeep)
			}
			if skipped != tt.wantSkipped {
				t.Errorf("skipped = %d, want %d", skipped, tt.wantSkipped)
			}
		})
	}
}
