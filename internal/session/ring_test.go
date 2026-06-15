package session

import (
	"bytes"
	"testing"
)

func TestRingUnderCapacity(t *testing.T) {
	r := newRing(16)
	r.Write([]byte("hello"))
	r.Write([]byte(" world"))
	if got := r.Bytes(); !bytes.Equal(got, []byte("hello world")) {
		t.Errorf("Bytes = %q, want %q", got, "hello world")
	}
}

func TestRingWraps(t *testing.T) {
	r := newRing(8)
	r.Write([]byte("abcdef"))
	r.Write([]byte("ghij")) // total 10 into cap 8 -> keep last 8: "cdefghij"
	if got := r.Bytes(); !bytes.Equal(got, []byte("cdefghij")) {
		t.Errorf("Bytes = %q, want %q", got, "cdefghij")
	}
}

func TestRingChunkLargerThanCap(t *testing.T) {
	r := newRing(4)
	r.Write([]byte("abcdefgh")) // keep last 4
	if got := r.Bytes(); !bytes.Equal(got, []byte("efgh")) {
		t.Errorf("Bytes = %q, want %q", got, "efgh")
	}
}
