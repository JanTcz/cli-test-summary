package mathx

import "testing"

func TestAdds(t *testing.T) {
	if 1+1 != 2 {
		t.Fatal("wrong")
	}
}

func TestSubtracts(t *testing.T) {
	if got := 3 - 1; got != 1 {
		t.Errorf("3 - 1 = %d, want 1", got)
	}
}

func TestDivides(t *testing.T) {
	t.Skip("not yet")
}
